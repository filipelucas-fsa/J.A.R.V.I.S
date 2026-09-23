import Anthropic from "@anthropic-ai/sdk";
import { Model, describeApiError } from "./model.js";
import { ModelError } from "./errors.js";
import { OpenAICompatibleModel } from "./openaiCompatible.js";

export class ConfigError extends Error {}

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
    try {
      const url = new URL(baseURL);
      if (!/^https?:$/.test(url.protocol)) throw new Error("protocolo");
    } catch {
      throw new ConfigError(`MODEL_BASE_URL inválida: '${baseURL}'. Use um endereço http(s) completo.`);
    }
    baseURL = baseURL.replace(/\/+$/, "");
  }

  const systemMode = (env.MODEL_SYSTEM_MODE || "system").trim().toLowerCase();
  if (!["system", "inline", "none"].includes(systemMode)) {
    throw new ConfigError(`MODEL_SYSTEM_MODE deve ser system, inline ou none (valor recebido: '${systemMode}').`);
  }
  const maxTokensParam = (env.MODEL_MAX_TOKENS_PARAM || preset.maxTokensParam || "max_tokens").trim();
  if (!["max_tokens", "max_completion_tokens"].includes(maxTokensParam)) {
    throw new ConfigError("MODEL_MAX_TOKENS_PARAM deve ser max_tokens ou max_completion_tokens.");
  }

  const maxTokens = readNumber(env, "MODEL_MAX_TOKENS", 4096, { integer: true, max: 1_000_000 });
  const temperature = optionalNumber(env, "MODEL_TEMPERATURE", { min: 0, max: 2 });
  const topP = optionalNumber(env, "MODEL_TOP_P", { min: 0, max: 1 });
  // reasoning_budget é específico de modelos "reasoning" da NVIDIA (NIM); não existe na API da Anthropic.
  const reasoningBudget = optionalNumber(env, "MODEL_REASONING_BUDGET", { integer: true, min: 0, max: 1_000_000 });
  if (reasoningBudget !== undefined && preset.kind !== "openai") {
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
    systemMode,
    maxTokensParam,
    timeoutMs: readNumber(env, "MODEL_TIMEOUT_SECONDS", 120, { max: 3600 }) * 1000,
    maxRetries: readNumber(env, "MODEL_MAX_RETRIES", 2, { integer: true, max: 10, allowZero: true }),
    maxTokens, temperature, topP, reasoningBudget,
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
