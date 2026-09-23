import { ConfigError } from "../ai/index.js";
import { DEFAULT_WAKE_WORDS, parseWakeWords } from "./web/wakeWord.js";

function number(env, name, fallback, { min, max, integer = true }) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ConfigError(`${name} deve ser um número${integer ? " inteiro" : ""} entre ${min} e ${max} (valor recebido: '${raw}').`);
  }
  return value;
}

function choice(env, name, fallback, allowed) {
  const value = (env[name] ?? "").trim().toLowerCase() || fallback;
  if (!allowed.includes(value)) throw new ConfigError(`${name} deve ser um de: ${allowed.join(", ")} (valor recebido: '${value}').`);
  return value;
}

function bool(env, name, fallback) {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  if (/^(true|1|sim|yes)$/i.test(raw)) return true;
  if (/^(false|0|nao|não|no)$/i.test(raw)) return false;
  throw new ConfigError(`${name} deve ser true ou false.`);
}

// Presets de servidor de voz. "kokoro" = Kokoro-FastAPI rodando na sua máquina (docker ou script).
const TTS_PRESETS = {
  kokoro: { baseURL: "http://localhost:8880/v1", model: "kokoro", voice: "pm_alex" },
  "openai-compatible": { baseURL: null, model: "tts-1", voice: "alloy" },
};

function readTtsServer(env, provider) {
  if (provider === "browser") return null;
  const preset = TTS_PRESETS[provider];
  const baseURL = (env.TTS_BASE_URL?.trim() || preset.baseURL || "").replace(/\/+$/, "");
  if (!baseURL) throw new ConfigError("defina TTS_BASE_URL (ex.: http://localhost:8880/v1) para usar TTS_PROVIDER=openai-compatible.");
  try {
    if (!/^https?:$/.test(new URL(baseURL).protocol)) throw new Error("protocolo");
  } catch {
    throw new ConfigError(`TTS_BASE_URL inválida: '${baseURL}'.`);
  }
  return {
    baseURL,
    apiKey: env.TTS_API_KEY?.trim() || undefined,
    model: env.TTS_MODEL?.trim() || preset.model,
    voice: env.TTS_VOICE?.trim() || preset.voice,
    format: choice(env, "TTS_FORMAT", "mp3", ["mp3", "wav", "opus", "flac"]),
    speed: number(env, "TTS_SPEED", 1, { min: 0.5, max: 2, integer: false }),
  };
}

// Lê as variáveis do modo voz e devolve a configuração enviada ao painel (sem segredos) e ao servidor.
// Lança ConfigError se algo estiver inválido.
export function readVoiceConfig(env = process.env) {
  let words;
  try {
    words = parseWakeWords(env.WAKE_WORDS?.trim() ? env.WAKE_WORDS : DEFAULT_WAKE_WORDS);
  } catch (error) {
    throw new ConfigError(`WAKE_WORDS inválido: ${error.message}`);
  }

  const lang = (env.VOICE_LANG || "pt-BR").trim();
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) throw new ConfigError(`VOICE_LANG inválido: '${lang}' (exemplos: pt-BR, en-US).`);

  const silenceSeconds = number(env, "VOICE_SILENCE_SECONDS", 10, { min: 1, max: 120, integer: false });
  const maxCaptureSeconds = number(env, "VOICE_MAX_CAPTURE_SECONDS", 120, { min: 5, max: 600 });
  if (maxCaptureSeconds < silenceSeconds) throw new ConfigError("VOICE_MAX_CAPTURE_SECONDS não pode ser menor que VOICE_SILENCE_SECONDS.");

  let screen;
  if (env.VOICE_SCREEN_SIZE?.trim()) {
    const match = /^(\d{3,5})x(\d{3,5})$/i.exec(env.VOICE_SCREEN_SIZE.trim());
    if (!match) throw new ConfigError("VOICE_SCREEN_SIZE deve ser LARGURAxALTURA (ex.: 1920x1080).");
    screen = { width: Number(match[1]), height: Number(match[2]) };
  }

  const ttsProvider = choice(env, "TTS_PROVIDER", "browser", ["browser", "kokoro", "openai-compatible"]);
  const ttsServer = readTtsServer(env, ttsProvider);
  const title = (env.VOICE_TITLE ?? "").trim() || "J.A.R.V.I.S.";
  if (title.length > 40) throw new ConfigError("VOICE_TITLE deve ter até 40 caracteres.");

  return {
    panel: {
      title,
      wakeWords: words.map((w) => w.label), lang, silenceMs: Math.round(silenceSeconds * 1000),
      maxCaptureMs: maxCaptureSeconds * 1000, fuzzy: bool(env, "WAKE_FUZZY", false),
      tts: {
        engine: ttsServer ? "server" : "browser",
        lang,
        rate: number(env, "VOICE_RATE", 1, { min: 0.5, max: 2, integer: false }),
        pitch: number(env, "VOICE_PITCH", 1, { min: 0, max: 2, integer: false }),
        voiceName: env.VOICE_NAME?.trim() || null,
        replies: choice(env, "VOICE_REPLIES", "auto", ["auto", "off"]),
        bargeIn: choice(env, "VOICE_BARGE_IN", "any", ["any", "wake", "off"]),
        maxChars: number(env, "VOICE_MAX_SPOKEN_CHARS", 1200, { min: 200, max: 5000 }),
      },
    },
    ttsServer,
    port: number(env, "VOICE_PORT", 47821, { min: 0, max: 65535 }),
    screen,
    openBrowser: !bool(env, "VOICE_NO_BROWSER", false),
  };
}
