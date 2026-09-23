import { findWakeWord } from "./wakeWord.js";

// Máquina de estados da captura por voz. Não conhece microfone nem tela: recebe o texto reconhecido
// e emite eventos. Roda no navegador e no Node (os testes usam este mesmo arquivo, com relógio falso).
//
//   idle       -> escutando só a palavra-chave
//   capturing  -> palavra-chave ouvida; acumulando a mensagem; envia após `silenceMs` sem palavras novas
//   processing -> mensagem enviada; esperando o agente terminar (a fala é ignorada)
//
// Eventos (onEvent): wake {word, deadline} | transcript {text, deadline} | send {text, reason} | cancel {reason} | idle | enabled {enabled}
export function createVoiceController({
  wakeWords, silenceMs = 10_000, maxCaptureMs = 120_000, maxLeadingWords = 3, fuzzy = false,
  onEvent = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), now = () => Date.now(),
}) {
  let mode = "idle";
  let enabled = true;
  let results = []; // fotografia da sessão de reconhecimento atual: [{ text, isFinal }]
  let scanFrom = 0; // em idle, resultados antes deste índice já foram examinados
  let anchor = null; // { index, remainder }: onde a palavra-chave foi dita, se foi nesta sessão
  let frozen = ""; // texto capturado em sessões de reconhecimento que já terminaram
  let lastMessage = "";
  let silenceTimer = null;
  let maxTimer = null;
  let deadline = 0;

  const findOptions = { maxLeadingWords, fuzzy };

  function composeMessage() {
    const parts = [frozen];
    results.forEach((result, index) => {
      if (anchor && index < anchor.index) return;
      if (anchor && index === anchor.index) {
        const found = findWakeWord(result.text, wakeWords, findOptions);
        if (found) anchor.remainder = found.rest; // se a palavra "sumiu" numa revisão do texto, mantém o último valor
        parts.push(anchor.remainder);
      } else {
        parts.push(result.text);
      }
    });
    return parts.map((p) => p.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function clearTimers() {
    if (silenceTimer !== null) clearTimer(silenceTimer);
    if (maxTimer !== null) clearTimer(maxTimer);
    silenceTimer = null;
    maxTimer = null;
  }

  function armSilence() {
    if (silenceTimer !== null) clearTimer(silenceTimer);
    deadline = now() + silenceMs;
    silenceTimer = setTimer(() => {
      silenceTimer = null;
      if (mode === "capturing") finish("silêncio");
    }, silenceMs);
  }

  function finish(reason) {
    const text = composeMessage();
    clearTimers();
    if (text === "") {
      cancel("nada foi dito");
      return;
    }
    mode = "processing";
    anchor = null;
    frozen = "";
    onEvent({ type: "send", text, reason });
  }

  function cancel(reason = "cancelado") {
    if (mode !== "capturing") return;
    clearTimers();
    mode = "idle";
    scanFrom = results.length; // não reage de novo à mesma fala
    anchor = null;
    frozen = "";
    lastMessage = "";
    onEvent({ type: "cancel", reason });
  }

  function startCapture(index, found) {
    mode = "capturing";
    anchor = { index, remainder: found.rest };
    frozen = "";
    lastMessage = "";
    armSilence();
    maxTimer = setTimer(() => {
      maxTimer = null;
      if (mode === "capturing") finish("tempo máximo");
    }, maxCaptureMs);
    onEvent({ type: "wake", word: found.word, deadline });
    update();
  }

  // Só palavras NOVAS reiniciam a contagem do silêncio.
  function update() {
    const message = composeMessage();
    if (message === lastMessage) return;
    lastMessage = message;
    armSilence();
    onEvent({ type: "transcript", text: message, deadline });
  }

  return {
    // Recebe a lista completa de resultados da sessão de reconhecimento atual.
    // ignore: true = estes resultados são só o eco do próprio agente falando; não procurar palavra-chave neles.
    handleResults(newResults, { ignore = false } = {}) {
      results = newResults.map((r) => ({ text: String(r.text ?? ""), isFinal: Boolean(r.isFinal) }));
      if (!enabled || mode === "processing") return;

      if (mode === "capturing") {
        update();
        return;
      }
      if (ignore) {
        scanFrom = results.length;
        return;
      }
      for (let index = scanFrom; index < results.length; index++) {
        const found = findWakeWord(results[index].text, wakeWords, findOptions);
        if (found) {
          startCapture(index, found);
          return;
        }
        if (results[index].isFinal && index === scanFrom) scanFrom = index + 1;
      }
    },

    // O reconhecedor encerrou a sessão (o navegador faz isso sozinho de tempos em tempos). Os resultados recomeçam do zero.
    handleSessionEnd() {
      if (mode === "capturing") {
        frozen = composeMessage();
        anchor = null;
      }
      results = [];
      scanFrom = 0;
    },

    sendNow() {
      if (mode === "capturing") finish("manual");
    },
    cancel,
    finishProcessing() {
      if (mode !== "processing") return;
      mode = "idle";
      scanFrom = results.length; // ignora o que foi dito enquanto o agente trabalhava
      onEvent({ type: "idle" });
    },
    setEnabled(value) {
      if (!value && mode === "capturing") cancel("microfone desligado");
      // Ao religar, o que foi dito com o microfone desligado não deve acionar nada.
      if (value && !enabled) scanFrom = results.length;
      enabled = Boolean(value);
      onEvent({ type: "enabled", enabled });
    },
    destroy: clearTimers,
    get state() {
      return { mode, enabled, message: lastMessage };
    },
  };
}
