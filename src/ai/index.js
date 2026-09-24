import Anthropic from "@anthropic-ai/sdk";
import { Model, describeApiError } from "./model.js";
import { ModelError } from "./errors.js";
import { OpenAICompatibleModel } from "./openaiCompatible.js";
import { ModelManager } from "./manager.js";

export class ConfigError extends Error {}

export { ModelManager };

// Provedores prontos. Qualquer outro servidor no formato OpenAI serve com MODEL_PROVIDER=openai-compatible + MODEL_BASE_URL.
export const PROVIDERS = {
  anthropic: {
    kind: "anthropic", label: "Anthropic", keyVars: ["ANTHROPIC_API_KEY"], modelVars: ["ANTHROPIC_MODEL"],
    defaultModel: "claude-sonnet-5", vision: true,
  },
  nvidia: {
    kind: "openai", label: "NVIDIA", baseURL: "https://integrate.api.nvidia.com/v1", keyVars: ["NVIDIA_API_KEY"],
    vision: false, maxTokensParam: "max_tokens",
  },
  openai: {
    kind: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", keyVars: ["OPENAI_API_KEY"],
    vision: false, maxTokensParam: "max_completion_tokens",
  },
  ollama: {
    kind: "openai", label: "Ollama (local)", baseURL: "http://localhost:11434/v1", keyVars: [], keyOptional: true,
    vision: false, maxTokensParam: "max_tokens",
  },
  "openai-compatible": {
    kind: "openai", label: "servidor compatível com OpenAI", keyVars: [], keyOptional: true,
    vision: false, maxTokensParam: "max_tokens", needsBaseURL: true,
  },
};

const first = (env, names) => names.map((name) => env[name]).find((value) => typeof value === "string" && value.trim() !== "");

function readBoolean(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (/^(true|1|sim|yes)$/i.test(raw.trim())) return true;
  if (/^(false|0|nao|não|no)$/i.test(raw.trim())) return false;
  throw new ConfigError(`${name} deve ser true ou false (valor recebido: '${raw}').`);
}

function readNumber(env, name, fallback, { integer = false, max = Infinity, allowZero = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  const tooSmall = allowZero ? value < 0 : value <= 0;
  if (!Number.isFinite(value) || tooSmall || value > max || (integer && !Number.isInteger(value))) {
    throw new ConfigError(
      `${name} deve ser um número ${integer ? "inteiro " : ""}${allowZero ? "de 0" : "maior que 0"}${Number.isFinite(max) ? ` até ${max}` : ""} (valor recebido: '${raw}').`
    );
  }
  return value;
}

// Como readNumber, mas o padrão é "não definido" (o parâmetro simplesmente não é enviado à API).
function optionalNumber(env, name, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ConfigError(`${name} deve ser um número${integer ? " inteiro" : ""} entre ${min} e ${max} (valor recebido: '${raw}').`);
  }
  return value;
}

// Endereço de servidor no formato OpenAI: valida http(s) e remove barras finais.
function normalizeOpenAIBaseURL(baseURL) {
  try {
    const url = new URL(baseURL);
    if (!/^https?:$/.test(url.protocol)) throw new Error("protocolo");
  } catch {
    throw new ConfigError(`MODEL_BASE_URL inválida: '${baseURL}'. Use um endereço http(s) completo.`);
  }
  return baseURL.replace(/\/+$/, "");
}

// Ajustes globais do modelo (valem para o principal e para os de reserva).
// A ordem das validações é a mesma do comportamento original do resolveModelConfig.
function resolveSharedParams(env, preset) {
  const systemMode = (env.MODEL_SYSTEM_MODE || "system").trim().toLowerCase();
  if (!["system", "inline", "none"].includes(systemMode)) {
    throw new ConfigError(`MODEL_SYSTEM_MODE deve ser system, inline ou none (valor recebido: '${systemMode}').`);
  }
  const maxTokensParam = (env.MODEL_MAX_TOKENS_PARAM || preset.maxTokensParam || "max_tokens").trim();
  if (!["max_tokens", "max_completion_tokens"].includes(maxTokensParam)) {
    throw new ConfigError("MODEL_MAX_TOKENS_PARAM deve ser max_tokens ou max_completion_tokens.");
  }
  return {
    systemMode,
    maxTokensParam,
    maxTokens: readNumber(env, "MODEL_MAX_TOKENS", 4096, { integer: true, max: 1_000_000 }),
    temperature: optionalNumber(env, "MODEL_TEMPERATURE", { min: 0, max: 2 }),
    topP: optionalNumber(env, "MODEL_TOP_P", { min: 0, max: 1 }),
    // reasoning_budget é específico de modelos "reasoning" da NVIDIA (NIM); não existe na API da Anthropic.
    reasoningBudget: optionalNumber(env, "MODEL_REASONING_BUDGET", { integer: true, min: 0, max: 1_000_000 }),
    timeoutMs: readNumber(env, "MODEL_TIMEOUT_SECONDS", 120, { max: 3600 }) * 1000,
    maxRetries: readNumber(env, "MODEL_MAX_RETRIES", 2, { integer: true, max: 10, allowZero: true }),
  };
}

// Lê as variáveis de ambiente e devolve a configuração do modelo. Lança ConfigError com mensagem clara.
export function resolveModelConfig(env = process.env) {
  const providerName = (env.MODEL_PROVIDER || "anthropic").trim().toLowerCase();
  const preset = PROVIDERS[providerName];
  if (!preset) {
    throw new ConfigError(`MODEL_PROVIDER '${providerName}' desconhecido. Válidos: ${Object.keys(PROVIDERS).join(", ")}.`);
  }

  const apiKey = first(env, ["MODEL_API_KEY", ...preset.keyVars]);
  if (!apiKey && !preset.keyOptional) {
    throw new ConfigError(`defina ${preset.keyVars[0]} (ou MODEL_API_KEY) no arquivo .env`);
  }

  const modelName = first(env, ["MODEL_NAME", ...(preset.modelVars ?? [])]) ?? preset.defaultModel;
  if (!modelName) {
    throw new ConfigError(`defina MODEL_NAME no .env (nome do modelo em ${preset.label}). Dica: 'npm run models' lista os disponíveis.`);
  }

  let baseURL = first(env, ["MODEL_BASE_URL"]) ?? preset.baseURL;
  if (preset.kind === "openai") {
    if (!baseURL) throw new ConfigError("defina MODEL_BASE_URL (ex.: http://localhost:1234/v1) para usar openai-compatible.");
    baseURL = normalizeOpenAIBaseURL(baseURL);
  }

  const shared = resolveSharedParams(env, preset);
  if (shared.reasoningBudget !== undefined && preset.kind !== "openai") {
    throw new ConfigError("MODEL_REASONING_BUDGET só se aplica a modelos no formato OpenAI/NIM (ex.: NVIDIA), não à Anthropic.");
  }

  return {
    provider: providerName,
    kind: preset.kind,
    label: preset.label,
    apiKey,
    modelName,
    baseURL,
    vision: readBoolean(env, "MODEL_VISION", preset.vision),
    tools: readBoolean(env, "MODEL_TOOLS", true),
    ...shared,
  };
}

export function createModel(config) {
  if (config.kind === "anthropic") {
    return new Model({
      apiKey: config.apiKey, modelName: config.modelName, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries,
      maxTokens: config.maxTokens, temperature: config.temperature, topP: config.topP,
    });
  }
  return new OpenAICompatibleModel({
    apiKey: config.apiKey, baseURL: config.baseURL, modelName: config.modelName, provider: config.label,
    timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, maxTokensParam: config.maxTokensParam,
    systemMode: config.systemMode, vision: config.vision, maxTokens: config.maxTokens,
    temperature: config.temperature, topP: config.topP, reasoningBudget: config.reasoningBudget,
  });
}

// ===================== cadeia de modelos (fallback) =====================

// Uma entrada de FALLBACK_MODELS: "provider:modelo" com tags opcionais entre colchetes
// (ex.: nvidia:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning[+vision]). Só o PRIMEIRO ":"
// separa o provider — o id do modelo pode conter "/" (ex.: meta/llama-3.3-70b-instruct).
const TAG_PATTERN = /^([+-])(vision|tools)$/;
const ENTRY_PATTERN = /^([a-zA-Z0-9_-]+):(.*)$/;

export function parseFallbackModels(raw) {
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      let idPart = entry;
      let tagPart = "";
      const bracket = entry.indexOf("[");
      if (bracket !== -1) {
        idPart = entry.slice(0, bracket).trim();
        tagPart = entry.slice(bracket + 1);
        if (!tagPart.endsWith("]")) {
          throw new ConfigError(`FALLBACK_MODELS: as tags de '${entry}' não fecham com ']' (ex.: provider:modelo[+vision]).`);
        }
        tagPart = tagPart.slice(0, -1);
      }

      const flags = {};
      if (tagPart !== "") {
        for (const token of tagPart.split(",").map((tag) => tag.trim()).filter(Boolean)) {
          const tag = TAG_PATTERN.exec(token);
          if (!tag) {
            throw new ConfigError(`FALLBACK_MODELS: tag '${token}' inválida em '${entry}'. Use +vision, -vision, +tools ou -tools.`);
          }
          flags[tag[2]] = tag[1] === "+";
        }
      }

      const match = ENTRY_PATTERN.exec(idPart);
      if (!match) {
        throw new ConfigError(`FALLBACK_MODELS: entrada '${entry}' inválida. Use o formato provider:modelo (ex.: nvidia:meta/llama-3.3-70b-instruct).`);
      }
      const providerName = match[1].toLowerCase();
      const preset = PROVIDERS[providerName];
      if (!preset) {
        throw new ConfigError(`FALLBACK_MODELS: provider '${match[1]}' desconhecido em '${entry}'. Válidos: ${Object.keys(PROVIDERS).join(", ")}.`);
      }
      const modelName = match[2].trim();
      if (!modelName) {
        throw new ConfigError(`FALLBACK_MODELS: '${entry}' não informa o nome do modelo (formato: provider:modelo).`);
      }
      return { providerName, preset, modelName, flags };
    });
}

// Configuração de um modelo de RESERVA: herda os ajustes globais (timeout, retries, max_tokens…)
// e usa a chave do próprio provider já definida no .env. Reserva do mesmo provider do principal
// usa o mesmo endereço (baseURL) — cobre NIM local e LM Studio sem configuração extra.
function resolveFallbackModelConfig(env, { providerName, preset, modelName, flags }, primary) {
  const apiKey = first(env, ["MODEL_API_KEY", ...preset.keyVars]);
  if (!apiKey && !preset.keyOptional) {
    throw new ConfigError(`FALLBACK_MODELS: defina ${preset.keyVars[0]} (ou MODEL_API_KEY) no .env para usar ${providerName}.`);
  }

  let baseURL;
  if (providerName === primary.provider) {
    baseURL = primary.baseURL;
  } else if (preset.kind === "openai") {
    baseURL = preset.baseURL ?? first(env, ["MODEL_BASE_URL"]);
    if (!baseURL) {
      throw new ConfigError(`FALLBACK_MODELS: ${providerName} precisa de MODEL_BASE_URL no .env (ex.: http://localhost:1234/v1).`);
    }
    baseURL = normalizeOpenAIBaseURL(baseURL);
  } else {
    baseURL = preset.baseURL;
  }

  const shared = resolveSharedParams(env, preset);
  return {
    provider: providerName,
    kind: preset.kind,
    label: preset.label,
    apiKey,
    modelName,
    baseURL,
    vision: flags.vision ?? preset.vision,
    tools: flags.tools ?? true,
    ...shared,
    // reasoning_budget só existe no formato OpenAI/NIM; em outros providers a reserva simplesmente ignora.
    reasoningBudget: preset.kind === "openai" ? shared.reasoningBudget : undefined,
  };
}

// Monta a cadeia: modelo principal (a configuração atual) + reservas de FALLBACK_MODELS.
// Sem FALLBACK_MODELS, devolve a cadeia de um único modelo — comportamento idêntico ao original.
export function resolveModelChain(env = process.env) {
  const primary = resolveModelConfig(env);

  const cooldownSeconds = readNumber(env, "MODEL_COOLDOWN_SECONDS", 60, { integer: true, max: 3600, allowZero: true });
  const cooldownMaxSeconds = readNumber(env, "MODEL_COOLDOWN_MAX_SECONDS", Math.max(900, cooldownSeconds), { integer: true, max: 86_400 });
  if (cooldownMaxSeconds < cooldownSeconds) {
    throw new ConfigError("MODEL_COOLDOWN_MAX_SECONDS deve ser maior ou igual a MODEL_COOLDOWN_SECONDS.");
  }

  const raw = (env.FALLBACK_MODELS ?? "").trim();
  if (!raw) return { models: [primary], cooldownSeconds, cooldownMaxSeconds };

  const models = [primary];
  for (const entry of parseFallbackModels(raw)) {
    // Entrada repetida (igual ao principal ou duplicada) não entra duas vezes.
    if (models.some((model) => model.provider === entry.providerName && model.modelName === entry.modelName)) continue;
    models.push(resolveFallbackModelConfig(env, entry, primary));
  }

  // Cadeia mista de ferramentas não funciona: uma reserva sem suporte a tools não conseguiria
  // continuar a tarefa no meio do loop de ferramentas (o histórico já tem blocos de ferramenta).
  if (primary.tools) {
    const semTools = models.slice(1).find((model) => model.tools === false);
    if (semTools) {
      throw new ConfigError(
        `FALLBACK_MODELS: '${semTools.provider}:${semTools.modelName}' não aceita ferramentas, mas o modelo principal usa ferramentas. ` +
          "Remova essa entrada, ou desligue as ferramentas para todos com MODEL_TOOLS=false (só conversa)."
      );
    }
  }

  return { models, cooldownSeconds, cooldownMaxSeconds };
}

// Monta o ModelManager: um adaptador por modelo da cadeia, todos com a mesma interface ask().
// requireVision: com TOOLS=computer, modelos sem visão ficam desativados (não conseguem
// "ver" a tela e quebrariam a tarefa no meio).
export function createModelManager({ models, cooldownSeconds = 60, cooldownMaxSeconds = 900, requireVision = false, log = () => {}, clock } = {}) {
  const entries = models.map((config) => {
    const disabled = requireVision && !config.vision;
    if (disabled) {
      log(`[modelo] reserva ${config.label} · ${config.modelName} desativada nesta sessão: não aceita imagens (TOOLS=computer).`);
    }
    return { config, instance: createModel(config), disabled };
  });
  return new ModelManager({ entries, cooldownSeconds, cooldownMaxSeconds, log, clock });
}

// Lista os modelos disponíveis para a chave configurada (também serve para testar se a chave funciona).
export async function listAvailableModels(config) {
  if (config.kind === "anthropic") {
    const client = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 1 });
    try {
      const ids = [];
      for await (const model of client.models.list({ limit: 100 })) ids.push(model.id);
      return ids.sort();
    } catch (error) {
      const info = describeApiError(error, { modelName: config.modelName });
      throw new ModelError(info.message, { ...info, cause: error });
    }
  }
  return createModel(config).listModels();
}
