import { pickVoice, prepareSpeech } from "./speech.js";

export class SpeechError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SpeechError";
    this.code = code;
  }
}

// ---------- motor 1: voz do próprio navegador (gratuita, sem instalar nada) ----------
// Chrome e Edge trazem vozes em pt-BR; o Edge tem vozes neurais "Natural", bem melhores.
export function createBrowserEngine({
  speechSynthesis, SpeechSynthesisUtterance, lang = "pt-BR", rate = 1, pitch = 1, voiceName,
  voicesTimeoutMs = 1500, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  let waited = false;
  let chosen = null;

  // A lista de vozes costuma chegar depois do carregamento da página: espera um pouco na primeira vez.
  async function ensureVoices() {
    if (waited || speechSynthesis.getVoices().length > 0) return;
    waited = true;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimer(timer);
        speechSynthesis.removeEventListener?.("voiceschanged", finish);
        resolve();
      };
      const timer = setTimer(finish, voicesTimeoutMs);
      speechSynthesis.addEventListener?.("voiceschanged", finish);
    });
  }

  return {
    name: "browser",
    get voiceName() { return chosen?.name ?? null; },

    async speak(text, { signal } = {}) {
      await ensureVoices();
      if (signal?.aborted) return;
      chosen = pickVoice(speechSynthesis.getVoices(), lang, { preferName: voiceName }) ?? chosen;

      await new Promise((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = lang;
        utterance.rate = rate;
        utterance.pitch = pitch;
        if (chosen) utterance.voice = chosen;

        const onAbort = () => speechSynthesis.cancel();
        signal?.addEventListener("abort", onAbort, { once: true });
        const done = () => signal?.removeEventListener("abort", onAbort);
        utterance.onend = () => { done(); resolve(); };
        utterance.onerror = (event) => {
          done();
          const code = event?.error;
          if (code === "canceled" || code === "interrupted") resolve(); // fomos nós que interrompemos
          else if (code === "not-allowed") reject(new SpeechError("O navegador bloqueou o áudio até você clicar no painel.", "not-allowed"));
          else reject(new SpeechError(`Falha na voz do navegador (${code ?? "desconhecida"}).`, code ?? "error"));
        };
        speechSynthesis.speak(utterance);
      });
    },

    cancel() {
      speechSynthesis.cancel();
    },

    // Navegadores só liberam o som depois de uma interação: um "sussurro" vazio no primeiro clique resolve.
    unlock() {
      try {
        const utterance = new SpeechSynthesisUtterance(" ");
        utterance.volume = 0;
        speechSynthesis.speak(utterance);
      } catch {
        // sem síntese de voz
      }
    },
  };
}

// ---------- motor 2: servidor de voz local (ex.: Kokoro), via /api/tts do nosso servidor ----------
export function createServerEngine({ fetch, AudioCtor, URLApi, endpoint = "/api/tts" }) {
  let playing = null;
  const prefetched = new Map();

  async function fetchAudio(text) {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      let message;
      try { message = (await response.json())?.error; } catch { /* sem corpo */ }
      throw new SpeechError(message ?? `O servidor de voz respondeu com erro ${response.status}.`, "tts-failed");
    }
    return response.blob();
  }

  return {
    name: "server",

    // Busca o próximo trecho enquanto o atual toca, para não haver pausas entre eles.
    prefetch(text) {
      if (!text || prefetched.has(text)) return;
      const promise = fetchAudio(text);
      promise.catch(() => prefetched.delete(text));
      prefetched.set(text, promise);
    },

    async speak(text, { signal } = {}) {
      const pending = prefetched.get(text) ?? fetchAudio(text);
      prefetched.delete(text);
      const blob = await pending;
      if (signal?.aborted) return;

      const url = URLApi.createObjectURL(blob);
      const audio = new AudioCtor(url);
      playing = audio;
      try {
        await new Promise((resolve, reject) => {
          const onAbort = () => { audio.pause?.(); resolve(); };
          signal?.addEventListener("abort", onAbort, { once: true });
          audio.onended = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
          audio.onerror = () => reject(new SpeechError("Não foi possível tocar o áudio do servidor de voz.", "audio-error"));
          Promise.resolve(audio.play()).catch((error) => {
            reject(error?.name === "NotAllowedError"
              ? new SpeechError("O navegador bloqueou o áudio até você clicar no painel.", "not-allowed")
              : new SpeechError(`Não foi possível tocar o áudio: ${error?.message ?? error}`, "audio-error"));
          });
        });
      } finally {
        URLApi.revokeObjectURL(url);
        if (playing === audio) playing = null;
      }
    },

    cancel() {
      prefetched.clear();
      playing?.pause?.();
    },

    unlock() {},
  };
}

// ---------- gerenciador: fila de trechos, interrupção, fallback ----------
// engine: motor principal. fallback: motor usado se o principal falhar (ex.: servidor Kokoro fora do ar).
export function createVoiceOutput({ engine, fallback = null, onChange = () => {}, onNotice = () => {}, prepare = prepareSpeech, maxChars = 1200 }) {
  let job = null; // tarefa de fala em andamento
  let blocked = null; // tarefa que o navegador bloqueou: retomada no primeiro clique
  let lastText = "";
  let usingFallback = false;
  let unlocked = false;

  function finish(current) {
    if (job !== current) return;
    job = null;
    onChange({ speaking: false, reason: "finished" });
  }

  async function play(current, startIndex) {
    let active = usingFallback && fallback ? fallback : engine;
    for (let i = startIndex; i < current.chunks.length; i++) {
      if (current.controller.signal.aborted) return;
      current.index = i;
      active.prefetch?.(current.chunks[i + 1]);
      try {
        await active.speak(current.chunks[i], { signal: current.controller.signal });
      } catch (error) {
        if (current.controller.signal.aborted) return;
        if (error.code === "not-allowed") {
          blocked = current;
          onNotice("O navegador bloqueou o som. Clique uma vez em qualquer lugar do painel para liberar a voz.");
          finish(current);
          return;
        }
        if (fallback && active !== fallback) {
          usingFallback = true;
          active = fallback;
          onNotice(`Voz principal indisponível (${error.message}). Usando a voz do navegador.`);
          i--; // repete este trecho com o motor alternativo
          continue;
        }
        onNotice(`Não consegui falar: ${error.message}`);
        break;
      }
    }
    finish(current);
  }

  return {
    // Fala a resposta (já limpando markdown/código). Interrompe qualquer fala anterior.
    async speak(text) {
      const { chunks } = prepare(text, { maxChars });
      if (chunks.length === 0) return;
      this.stop();
      const current = { chunks, text: chunks.join(" "), controller: new AbortController(), index: 0 };
      job = current;
      lastText = current.text;
      onChange({ speaking: true });
      await play(current, 0);
    },

    stop() {
      blocked = null;
      if (!job) return;
      const current = job;
      job = null;
      current.controller.abort();
      engine.cancel();
      fallback?.cancel();
      onChange({ speaking: false, reason: "stopped" });
    },

    // Chame no primeiro clique/tecla do usuário: libera o áudio e retoma uma fala que estava bloqueada.
    unlock() {
      if (!unlocked) {
        unlocked = true;
        engine.unlock?.();
        fallback?.unlock?.();
      }
      if (!blocked) return;
      const current = blocked;
      blocked = null;
      current.controller = new AbortController();
      job = current;
      onChange({ speaking: true });
      play(current, current.index);
    },

    get speaking() { return job !== null; },
    get currentText() { return job?.text ?? ""; },
    get lastText() { return lastText; },
    get engineName() { return usingFallback && fallback ? fallback.name : engine.name; },
  };
}
