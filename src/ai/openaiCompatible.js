import { ModelError } from "./errors.js";

// Adaptador para QUALQUER servidor no formato "OpenAI Chat Completions" (POST {baseURL}/chat/completions):
// NVIDIA, OpenAI, Ollama, LM Studio, vLLM, Groq, OpenRouter, Together, Mistral, DeepSeek, Gemini (endpoint compatível)...
//
// O agente guarda o histórico no formato da Anthropic (blocos tool_use / tool_result). Este adaptador
// traduz esse histórico para o formato OpenAI a cada chamada e traduz a resposta de volta,
// então o resto do projeto não precisa saber qual provedor está em uso.

const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const IMAGE_NOTE = "Imagem retornada pela ferramenta:";
const MAX_RETRY_WAIT_MS = 30_000;

// ---------- tradução: histórico e ferramentas (ida) ----------

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

export function toOpenAITools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

// systemMode: "system" (padrão) | "inline" (junta as instruções à 1ª mensagem do usuário, para modelos que
// não aceitam o papel "system") | "none".
// vision: se false, imagens de ferramentas são trocadas por um aviso em texto.
export function toOpenAIMessages(messages, { system, systemMode = "system", vision = false } = {}) {
  const out = [];
  if (system && systemMode === "system") out.push({ role: "system", content: system });
  let inlineSystem = system && systemMode === "inline" ? system : null;

  for (const message of messages) {
    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        out.push({ role: "assistant", content: message.content });
        continue;
      }
      const text = textOf(message.content);
      const calls = message.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      const converted = { role: "assistant", content: text || null };
      if (calls.length > 0) converted.tool_calls = calls;
      out.push(converted);
      continue;
    }

    // mensagem do usuário
    if (typeof message.content === "string") {
      const content = inlineSystem ? `${inlineSystem}\n\n${message.content}` : message.content;
      inlineSystem = null;
      out.push({ role: "user", content });
      continue;
    }

    const attachments = [];
    for (const block of message.content.filter((b) => b.type === "tool_result")) {
      let text = textOf(block.content);
      const images = Array.isArray(block.content) ? block.content.filter((b) => b.type === "image") : [];
      if (images.length > 0) {
        if (vision) attachments.push(...images);
        else text += "\n[imagem omitida: este modelo não recebe imagens]";
      }
      if (block.is_error) text = `[ERRO] ${text}`;
      out.push({ role: "tool", tool_call_id: block.tool_use_id, content: text });
    }
    // O formato OpenAI não aceita imagem dentro de mensagem "tool": vai numa mensagem de usuário logo depois.
    if (attachments.length > 0) {
      out.push({
        role: "user",
        content: [
          { type: "text", text: IMAGE_NOTE },
          ...attachments.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.source.media_type};base64,${image.source.data}` },
          })),
        ],
      });
    }
    const otherText = textOf(message.content.filter((b) => b.type !== "tool_result"));
    if (otherText) out.push({ role: "user", content: otherText });
  }
  return out;
}

// ---------- tradução: resposta (volta) ----------

const FINISH_TO_STOP = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };

// Ids de ferramenta vêm do provedor e precisam ser textos simples e únicos (o histórico interno os valida).
function normalizeToolCallId(id, index, used) {
  let normalized = typeof id === "string" ? id.replace(/[^a-zA-Z0-9_-]/g, "_") : "";
  if (normalized === "" || !TOOL_ID_PATTERN.test(normalized)) normalized = `call_${index}`;
  while (used.has(normalized)) normalized += "_";
  used.add(normalized);
  return normalized;
}

function parseArguments(raw) {
  if (raw === undefined || raw === null || raw === "") return { input: {} };
  if (typeof raw === "object" && !Array.isArray(raw)) return { input: raw };
  if (typeof raw !== "string") return { input: {}, parseError: "os argumentos não são um texto JSON" };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { input: {}, parseError: "os argumentos devem ser um objeto JSON" };
    }
    return { input: parsed };
  } catch (error) {
    return { input: {}, parseError: `JSON inválido (${error.message})` };
  }
}

export function fromOpenAIResponse(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  if (!choice) {
    const detail = json?.error?.message ?? json?.detail ?? "";
    throw new ModelError(`A resposta do modelo veio sem 'choices' (formato inesperado).${detail ? ` Detalhe: ${detail}` : ""}`);
  }
  const message = choice.message ?? {};

  let text = "";
  if (typeof message.content === "string") text = message.content;
  else if (Array.isArray(message.content)) text = textOf(message.content.map((part) => ({ type: "text", text: part?.text ?? "" })));
  // Alguns modelos de raciocínio devolvem o "pensamento" dentro de <think>...</think>: não faz parte da resposta.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  const refusal = typeof message.refusal === "string" && message.refusal !== "" ? message.refusal : null;
  if (refusal && text === "") text = refusal;

  const used = new Set();
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call, index) => {
    const id = normalizeToolCallId(call?.id, index, used);
    const name = call?.function?.name;
    const { input, parseError } = parseArguments(call?.function?.arguments);
    const entry = { id, name: typeof name === "string" ? name : "", input };
    if (typeof name !== "string" || name === "") entry.parseError = "a chamada não informa o nome da ferramenta";
    else if (parseError) entry.parseError = parseError;
    return entry;
  });

  let stopReason = FINISH_TO_STOP[choice.finish_reason] ?? "end_turn";
  if (refusal) stopReason = "refusal";
  // Muitos servidores devolvem finish_reason "stop" mesmo com tool_calls: o que vale é a presença das chamadas.
  if (toolCalls.length > 0 && stopReason !== "max_tokens") stopReason = "tool_use";
  if (toolCalls.length === 0 && stopReason === "tool_use") stopReason = "end_turn";

  const content = [];
  if (text !== "") content.push({ type: "text", text });
  for (const call of toolCalls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });

  return { text, stopReason, content, toolCalls };
}

// ---------- erros HTTP ----------

// Cada provedor formata o erro de um jeito: {error:{message}} (OpenAI), {detail} / {title} (NVIDIA), texto puro (proxies)...
export function extractErrorMessage(bodyText) {
  const raw = String(bodyText ?? "").trim();
  try {
    const json = JSON.parse(raw);
    const candidate = json?.error?.message ?? (typeof json?.error === "string" ? json.error : undefined) ?? json?.detail ?? json?.message ?? json?.title;
    if (typeof candidate === "string" && candidate !== "") return candidate.slice(0, 500);
    if (candidate !== undefined) return JSON.stringify(candidate).slice(0, 500);
  } catch {
    // não é JSON: usa o texto cru
  }
  return raw.replace(/\s+/g, " ").slice(0, 300) || "(sem detalhes)";
}

export function describeHttpError(status, detail, { modelName, provider = "provedor", retryAfter, requestId } = {}) {
  const suffix = requestId ? ` (request id: ${requestId})` : "";
  const base = { status, requestId };

  if (status === 400 || status === 422) {
    let hint = "Isso normalmente indica incompatibilidade entre este agente e o modelo; veja o log e as opções MODEL_* no .env.";
    if (/tool|function/i.test(detail)) hint = "O modelo pode não suportar chamada de ferramentas: use um modelo com suporte ou defina MODEL_TOOLS=false (só conversa).";
    else if (/image|vision|multimodal|modalit/i.test(detail)) hint = "O modelo pode não aceitar imagens: defina MODEL_VISION=false.";
    else if (/role|system|alternat|conversation/i.test(detail)) hint = "O modelo pode não aceitar o papel 'system': defina MODEL_SYSTEM_MODE=inline.";
    else if (/max_tokens|max_completion_tokens/i.test(detail)) hint = "Troque o parâmetro de limite com MODEL_MAX_TOKENS_PARAM=max_completion_tokens (ou max_tokens).";
    else if (/context|too long|maximum.*length|token limit/i.test(detail)) hint = "O histórico ficou grande demais para o contexto deste modelo.";
    else if (/credit|billing|quota/i.test(detail)) hint = "Parece um problema de créditos/cota na sua conta.";
    return { ...base, retryable: false, message: `Requisição recusada por ${provider} (${status}): ${detail}. ${hint}${suffix}` };
  }
  if (status === 401) return { ...base, retryable: false, message: `Chave de API inválida ou ausente (401) para ${provider}. Confira a chave no .env.${suffix}` };
  if (status === 402) return { ...base, retryable: false, message: `Problema de cobrança/créditos em ${provider} (402).${suffix}` };
  if (status === 403) return { ...base, retryable: false, message: `Sem permissão (403) em ${provider}: a chave não pode usar este recurso/modelo. ${detail}${suffix}` };
  if (status === 404) {
    return {
      ...base, retryable: false,
      message:
        `Modelo ou endereço não encontrado (404) em ${provider}. Confira MODEL_NAME ('${modelName}'): ele pode não existir, ` +
        `não estar habilitado na sua conta, ou MODEL_BASE_URL estar errada (normalmente termina em /v1). Detalhe: ${detail}${suffix}`,
    };
  }
  if (status === 413) return { ...base, retryable: false, message: `Requisição grande demais (413) para ${provider}: imagens ou histórico demais.${suffix}` };
  if (status === 429) {
    const wait = retryAfter ? ` Tente de novo em ${retryAfter}s.` : "";
    return { ...base, retryable: true, message: `Limite de uso/taxa atingido (429) em ${provider}.${wait}${suffix}` };
  }
  if (status >= 500) return { ...base, retryable: true, message: `Erro no servidor de ${provider} (${status}): ${detail}. Tente novamente em instantes.${suffix}` };
  return { ...base, retryable: false, message: `Erro de ${provider} (${status}): ${detail}${suffix}` };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ModelError("Requisição cancelada."));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ModelError("Requisição cancelada."));
    }, { once: true });
  });
}

export class OpenAICompatibleModel {
  // baseURL: ex. "https://integrate.api.nvidia.com/v1" (sem a barra final nem /chat/completions)
  constructor({
    apiKey, baseURL, modelName, provider = "provedor", timeoutMs = 120_000, maxRetries = 2, retryBaseMs = 500,
    maxTokens = 4096, maxTokensParam = "max_tokens", systemMode = "system", vision = false, fetchImpl = globalThis.fetch,
    temperature, topP, reasoningBudget,
  }) {
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.modelName = modelName;
    this.provider = provider;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseMs = retryBaseMs;
    this.maxTokens = maxTokens;
    this.maxTokensParam = maxTokensParam;
    this.systemMode = systemMode;
    this.temperature = temperature;
    this.topP = topP;
    this.reasoningBudget = reasoningBudget;
    this.fetch = fetchImpl;
    this.label = `${provider} · ${modelName}`;
    this.capabilities = { vision, tools: true };
  }

  #redact(text) {
    return this.apiKey ? String(text).split(this.apiKey).join("***") : String(text);
  }

  // Mesma interface do Model da Anthropic. Retorna { text, stopReason, content, toolCalls }.
  async ask(messages, { system, tools = [], signal } = {}) {
    const body = {
      model: this.modelName,
      messages: toOpenAIMessages(messages, { system, systemMode: this.systemMode, vision: this.capabilities.vision }),
      [this.maxTokensParam]: this.maxTokens,
    };
    if (tools.length > 0) body.tools = toOpenAITools(tools);
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (this.topP !== undefined) body.top_p = this.topP;
    // Campo específico da NVIDIA NIM para modelos "reasoning" (ex.: Nemotron Omni Reasoning); outros servidores o ignoram.
    if (this.reasoningBudget !== undefined) body.reasoning_budget = this.reasoningBudget;

    const json = await this.#post(body, signal);
    return fromOpenAIResponse(json);
  }

  async #post(body, userSignal) {
    const url = `${this.baseURL}/chat/completions`;
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const payload = JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combined = userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal;
      let failure; // { message, retryable, ... } quando a tentativa falha
      let retryAfterMs;

      try {
        const response = await this.fetch(url, { method: "POST", headers, body: payload, signal: combined });
        const text = await response.text();

        if (response.ok) {
          try {
            return JSON.parse(text);
          } catch {
            throw new ModelError(
              `${this.provider} respondeu com algo que não é JSON. Confira MODEL_BASE_URL (${this.baseURL}): ` +
                `normalmente deve terminar em /v1. Início da resposta: ${this.#redact(text.slice(0, 120))}`
            );
          }
        }

        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = /^\d+$/.test(retryAfterHeader ?? "") ? Number(retryAfterHeader) : undefined;
        retryAfterMs = retryAfterSeconds !== undefined ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_WAIT_MS) : undefined;
        failure = describeHttpError(response.status, this.#redact(extractErrorMessage(text)), {
          modelName: this.modelName, provider: this.provider, retryAfter: retryAfterSeconds,
          requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
        });
      } catch (error) {
        if (error instanceof ModelError) throw error;
        if (userSignal?.aborted) throw new ModelError("Requisição cancelada.");
        if (timeoutSignal.aborted) {
          failure = { retryable: true, message: `Tempo esgotado (${Math.round(this.timeoutMs / 1000)}s) esperando ${this.provider}. Tente novamente; se persistir, verifique a conexão ou o modelo.` };
        } else {
          failure = { retryable: true, message: `Não foi possível conectar a ${this.provider} (${this.baseURL}). Verifique a internet e MODEL_BASE_URL. Detalhe: ${this.#redact(error?.cause?.code ?? error?.message ?? error)}` };
        }
      }

      if (!failure.retryable || attempt >= this.maxRetries) {
        throw new ModelError(failure.message, { status: failure.status, retryable: failure.retryable, requestId: failure.requestId });
      }
      await sleep(retryAfterMs ?? Math.min(this.retryBaseMs * 2 ** attempt, MAX_RETRY_WAIT_MS), userSignal);
    }
  }

  // GET {baseURL}/models: lista os modelos disponíveis (também serve para testar se a chave funciona).
  async listModels({ signal } = {}) {
    const headers = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let response;
    try {
      response = await this.fetch(`${this.baseURL}/models`, { headers, signal: signal ?? AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new ModelError(`Não foi possível conectar a ${this.provider} (${this.baseURL}). Detalhe: ${this.#redact(error?.cause?.code ?? error?.message ?? error)}`, { retryable: true });
    }
    const text = await response.text();
    if (!response.ok) {
      const info = describeHttpError(response.status, this.#redact(extractErrorMessage(text)), { modelName: this.modelName, provider: this.provider });
      throw new ModelError(info.message, { status: response.status, retryable: info.retryable });
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ModelError(`${this.provider} respondeu algo que não é JSON em /models. Confira MODEL_BASE_URL.`);
    }
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    return list.map((item) => (typeof item === "string" ? item : item?.id)).filter((id) => typeof id === "string").sort();
  }
}
