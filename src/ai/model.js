import Anthropic from "@anthropic-ai/sdk";
import { ModelError } from "./errors.js";

export { ModelError };

function headerValue(headers, name) {
  if (!headers) return undefined;
  return typeof headers.get === "function" ? headers.get(name) : headers[name];
}

// Converte qualquer erro do SDK em uma mensagem acionável.
// Regra geral (documentação da API): 429/500/504/529 são temporários; 400/401/402/403/404/413 pedem uma correção.
export function describeApiError(error, { modelName } = {}) {
  if (error instanceof Anthropic.APIUserAbortError) {
    return { message: "Requisição cancelada.", retryable: false };
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return {
      message: "Tempo esgotado esperando a resposta da API. Tente novamente; se persistir, verifique sua conexão.",
      retryable: true,
    };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return {
      message:
        "Não foi possível conectar à API. Verifique sua conexão com a internet " +
        "(e ANTHROPIC_BASE_URL, se você a definiu).",
      retryable: true,
    };
  }

  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    const status = error.status;
    const type = error.error?.error?.type ?? error.error?.type;
    const apiMessage = error.error?.error?.message ?? error.error?.message ?? error.message;
    const requestId = error.requestID ?? headerValue(error.headers, "request-id");
    const suffix = requestId ? ` (request id: ${requestId})` : "";

    if (status === 400) {
      let hint = "Isso normalmente indica um bug de compatibilidade do agente; veja o log de ações e reporte.";
      if (/credit balance|billing/i.test(apiMessage)) hint = "Parece um problema de créditos/cobrança na sua conta da Anthropic.";
      else if (/image/i.test(apiMessage)) hint = "Uma imagem (screenshot) ultrapassou os limites da API.";
      else if (/tool_use|tool_result/i.test(apiMessage)) hint = "O histórico de ferramentas ficou inconsistente.";
      return { message: `Requisição recusada pela API (400): ${apiMessage}. ${hint}${suffix}`, status, type, retryable: false, requestId };
    }
    if (status === 401) {
      return { message: `Chave de API inválida ou ausente (401). Confira ANTHROPIC_API_KEY no .env.${suffix}`, status, type, retryable: false, requestId };
    }
    if (status === 402) {
      return { message: `Problema de cobrança na conta (402). Verifique o pagamento no Claude Console.${suffix}`, status, type, retryable: false, requestId };
    }
    if (status === 403) {
      return { message: `Sem permissão (403): sua chave não pode usar este recurso/modelo. ${apiMessage}${suffix}`, status, type, retryable: false, requestId };
    }
    if (status === 404) {
      return {
        message: `Modelo '${modelName}' não encontrado ou sem acesso (404). Defina um modelo válido em ANTHROPIC_MODEL.${suffix}`,
        status, type, retryable: false, requestId,
      };
    }
    if (status === 413) {
      return { message: `Requisição grande demais (413). Provavelmente há imagens ou histórico demais.${suffix}`, status, type, retryable: false, requestId };
    }
    if (status === 429) {
      const wait = headerValue(error.headers, "retry-after");
      const waitText = wait ? ` Tente de novo em ${wait}s.` : "";
      const retryAfterMs = /^\d+$/.test(wait ?? "") ? Number(wait) * 1000 : undefined;
      return { message: `Limite de uso/taxa atingido (429).${waitText}${suffix}`, status, type, retryable: true, requestId, retryAfterMs };
    }
    if (status === 529) {
      return { message: `A API está sobrecarregada (529). Aguarde um pouco e tente de novo.${suffix}`, status, type, retryable: true, requestId };
    }
    if (status >= 500) {
      return { message: `Erro interno na API (${status}). Tente novamente em instantes.${suffix}`, status, type, retryable: true, requestId };
    }
    return { message: `Erro da API (${status}): ${apiMessage}${suffix}`, status, type, retryable: false, requestId };
  }

  return { message: `Erro inesperado ao falar com o modelo: ${error?.message ?? String(error)}`, retryable: false };
}

// Responsável apenas por conversar com a API do modelo.
// Não executa ferramentas: só envia as definições e devolve o que o modelo pediu.
export class Model {
  // timeoutMs: tempo máximo por tentativa. maxRetries: novas tentativas automáticas do SDK
  // para erros temporários (429/5xx/rede), com espera crescente.
  constructor({ apiKey, modelName, baseURL, timeoutMs = 120_000, maxRetries = 2, maxTokens = 4096, temperature, topP }) {
    this.client = new Anthropic({ apiKey, baseURL, timeout: timeoutMs, maxRetries });
    this.modelName = modelName;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.topP = topP;
    this.label = `Anthropic · ${modelName}`;
    this.capabilities = { vision: true, tools: true };
  }

  // Recebe: messages = [{ role, content: texto ou lista de blocos }, ...]
  //         options.system, options.tools (de toolRegistry.getDefinitions()), options.signal (AbortSignal)
  // Retorna: { text, stopReason, content, toolCalls: [{ id, name, input }] }
  // Lança: ModelError (mensagem amigável).
  async ask(messages, { system, tools = [], signal } = {}) {
    const params = { model: this.modelName, max_tokens: this.maxTokens, system, messages };
    if (tools.length > 0) params.tools = tools;
    if (this.temperature !== undefined) params.temperature = this.temperature;
    if (this.topP !== undefined) params.top_p = this.topP;

    let response;
    try {
      response = await this.client.messages.create(params, signal ? { signal } : undefined);
    } catch (error) {
      const info = describeApiError(error, { modelName: this.modelName });
      throw new ModelError(info.message, { ...info, cause: error });
    }

    if (!response || !Array.isArray(response.content)) {
      throw new ModelError("A API retornou uma resposta em formato inesperado (sem 'content').");
    }

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const toolCalls = response.content
      .filter((block) => block.type === "tool_use")
      .map(({ id, name, input }) => ({ id, name, input }));

    return { text, stopReason: response.stop_reason, content: response.content, toolCalls };
  }
}
