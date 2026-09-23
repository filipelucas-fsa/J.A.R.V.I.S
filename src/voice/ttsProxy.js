import { extractErrorMessage } from "../ai/openaiCompatible.js";

export class TtsError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "TtsError";
    this.status = status;
  }
}

const CONTENT_TYPES = { mp3: "audio/mpeg", wav: "audio/wav", opus: "audio/ogg", flac: "audio/flac" };
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

// Fala com um servidor de voz no formato OpenAI (POST {baseURL}/audio/speech). O Kokoro-FastAPI, rodando localmente,
// oferece esse formato (e suporta português do Brasil); servidores da OpenAI e compatíveis também servem.
// O painel nunca fala direto com ele: passa por este proxy (a chave, se houver, fica só no servidor).
export function createTtsProxy({ baseURL, apiKey, model, voice, format = "mp3", speed = 1, timeoutMs = 30_000, fetchImpl = globalThis.fetch }) {
  const root = baseURL.replace(/\/+$/, "");
  const authHeaders = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

  async function call(url, options, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw new TtsError("Pedido de voz cancelado.", 499);
      if (timeout.aborted) throw new TtsError(`O servidor de voz não respondeu em ${Math.round(timeoutMs / 1000)}s.`, 504);
      throw new TtsError(`Não foi possível falar com o servidor de voz em ${root}. Ele está rodando? (${error?.cause?.code ?? error?.message ?? error})`, 502);
    }
  }

  function explain(status, detail) {
    if (status === 400 || status === 422) return `O servidor de voz recusou o pedido: ${detail}. Confira TTS_VOICE ('${voice}') e TTS_MODEL ('${model}').`;
    if (status === 401 || status === 403) return "O servidor de voz recusou a chave (TTS_API_KEY).";
    if (status === 404) return `Endereço do servidor de voz não encontrado (TTS_BASE_URL: ${root}). Ele normalmente termina em /v1.`;
    return `O servidor de voz respondeu com erro ${status}: ${detail}`;
  }

  return {
    contentType: CONTENT_TYPES[format] ?? "audio/mpeg",

    // Retorna um Buffer com o áudio. Lança TtsError (status HTTP e mensagem prontos para o painel).
    async synthesize(text, { signal } = {}) {
      const response = await call(`${root}/audio/speech`, {
        method: "POST", headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ model, input: text, voice, response_format: format, speed }),
      }, signal);
      if (!response.ok) throw new TtsError(explain(response.status, extractErrorMessage(await response.text().catch(() => ""))));
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) throw new TtsError("O servidor de voz devolveu um áudio vazio.");
      if (audio.length > MAX_AUDIO_BYTES) throw new TtsError("O áudio devolvido pelo servidor de voz é grande demais.");
      return audio;
    },

    // Lista as vozes do servidor (GET {baseURL}/audio/voices), quando ele oferece.
    async listVoices() {
      const response = await call(`${root}/audio/voices`, { headers: authHeaders });
      if (!response.ok) throw new TtsError(explain(response.status, extractErrorMessage(await response.text().catch(() => ""))));
      const json = await response.json().catch(() => null);
      const list = Array.isArray(json?.voices) ? json.voices : Array.isArray(json) ? json : [];
      return list.map((item) => (typeof item === "string" ? item : item?.id ?? item?.name)).filter((id) => typeof id === "string").sort();
    },
  };
}
