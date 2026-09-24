import { createVoiceController } from "./voiceController.js";
import { createBrowserRecognizer } from "./browserRecognizer.js";
import { findWakeWord, parseWakeWords } from "./wakeWord.js";
import { isEcho } from "./speech.js";
import { createBrowserEngine, createServerEngine, createVoiceOutput } from "./voiceOutput.js";
import { renderMarkdown } from "./markdown.js";

const MAX_MESSAGES = 200;
const MAX_LOG_CHARS = 300;
const ECHO_GUARD_MS = 800; // logo depois que o agente cala, o microfone ainda pode captar o final da fala dele
const HEARD_HIDE_MS = 4_000; // por quanto tempo a linha "ouvi" continua na tela após a última fala
const KEY_VOICE = "jarvis.voice";
const KEY_TYPED = "jarvis.typed";

// Mini chat do modo voz (visual J.A.R.V.I.S.). Recebe TUDO do ambiente por parâmetro (document, fetch, EventSource,
// síntese de voz...), então roda no navegador de verdade e nos testes com dublês. Todo texto vindo do modelo ou da
// fala entra como textContent (texto puro), nunca como HTML.
export function createPanel(deps) {
  const {
    document: doc, fetch, EventSource, SpeechRecognitionCtor, speechSynthesis, SpeechSynthesisUtterance, AudioCtor, URLApi,
    setTimer, clearTimer, setTicker, clearTicker, now = () => Date.now(), playBeep = () => {}, focusWindow = () => {}, storage = null,
    debug = () => {},
  } = deps;

  const $ = (id) => doc.getElementById(id);
  const el = {
    boot: $("boot"), title: $("title"), model: $("model"), dot: $("dot"), status: $("status"), notice: $("notice"), messages: $("messages"), heard: $("heard"),
    live: $("live"), liveText: $("live-text"), ring: $("ring"), countdown: $("countdown"), btnSend: $("btn-send"), btnCancel: $("btn-cancel"),
    confirm: $("confirm"), confirmTitle: $("confirm-title"), confirmText: $("confirm-text"),
    btnYes: $("btn-yes"), btnAlways: $("btn-always"), btnNo: $("btn-no"),
    form: $("form"), text: $("text"), btnStop: $("btn-stop"), btnMute: $("btn-mute"),
    btnVoice: $("btn-voice"), btnTyped: $("btn-typed"), btnHush: $("btn-hush"), btnNew: $("btn-new"),
  };

  const store = {
    get(key) { try { return storage?.getItem(key) ?? null; } catch { return null; } },
    set(key, value) { try { storage?.setItem(key, value); } catch { /* sem armazenamento */ } },
  };

  let controller = null;
  let recognizer = null;
  let output = null;
  let wakeWords = [];
  let ttsConfig = { bargeIn: "any" };
  let silenceMs = 10_000;
  let firstWord = "Jarvis";
  let busy = false;
  let muted = false;
  let fatal = false;
  let pendingConfirmId = null;
  let tickerId = null;
  let deadline = 0;
  let heardTimer = null;
  let taskByVoice = false;
  let voiceEnabled = store.get(KEY_VOICE) !== "off";
  let speakTyped = store.get(KEY_TYPED) === "on";
  let echoGuardUntil = 0;

  // ---------- desenho ----------
  function refreshStatus() {
    let kind = "idle";
    let text = `Diga "${firstWord}"…`;
    if (busy) [kind, text] = ["processing", "Pensando…"];
    else if (controller?.state.mode === "capturing") [kind, text] = ["capturing", "Ouvindo…"];
    else if (output?.speaking) [kind, text] = ["speaking", "Falando…"];
    else if (fatal) [kind, text] = ["error", "Microfone indisponível"];
    else if (!recognizer) [kind, text] = ["muted", "Voz indisponível: digite abaixo"];
    else if (muted) [kind, text] = ["muted", "Microfone desligado"];
    el.dot.className = `dot ${kind}`;
    el.status.textContent = text;
    if (doc.body) doc.body.dataset.state = kind; // o CSS anima o reator e a onda conforme o estado
  }

  function refreshVoiceButtons() {
    el.btnVoice.textContent = voiceEnabled ? "🔊" : "🔈";
    el.btnVoice.title = voiceEnabled ? "Voz do agente: ligada (clique para desligar)" : "Voz do agente: desligada (clique para ligar)";
    el.btnTyped.textContent = speakTyped ? "Digitado: com voz" : "Digitado: sem voz";
  }

  function addMessage(kind, text) {
    const node = doc.createElement("div");
    node.className = `msg ${kind}`;
    if (kind === "agent") renderMarkdown(node, text, doc);
    else node.textContent = String(text);
    el.messages.appendChild(node);
    while (el.messages.children.length > MAX_MESSAGES) el.messages.removeChild(el.messages.children[0]);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  const showNotice = (text) => { el.notice.textContent = text; el.notice.hidden = false; };
  const hideNotice = () => { el.notice.hidden = true; };

  function updateCountdown() {
    const remaining = Math.max(0, deadline - now());
    el.countdown.textContent = `Enviando em ${Math.ceil(remaining / 1000)}s`;
    el.ring.style.setProperty("--p", String(Math.min(1, remaining / silenceMs))); // anel de contagem regressiva
  }
  function startCountdown(newDeadline) {
    deadline = newDeadline;
    updateCountdown();
    if (tickerId === null) tickerId = setTicker(updateCountdown, 250);
  }
  function stopCountdown() {
    if (tickerId !== null) clearTicker(tickerId);
    tickerId = null;
    el.countdown.textContent = "";
  }

  function hideConfirm() {
    pendingConfirmId = null;
    el.confirm.hidden = true;
  }

  // ---------- voz do agente ----------
  // A resposta é falada se você chamou POR VOZ (e a voz está ligada) ou se ligou "Digitado: com voz".
  const shouldSpeak = () => Boolean(output) && voiceEnabled && (taskByVoice || speakTyped);
  const speak = (text) => { if (shouldSpeak()) output.speak(text); };

  function onSpeakingChange({ speaking, reason }) {
    el.btnHush.hidden = !speaking;
    if (!speaking) {
      echoGuardUntil = now() + ECHO_GUARD_MS;
      // Terminou de falar sozinho: reinicia a escuta para descartar o eco acumulado. Se foi interrompido por
      // você falando, NÃO reinicia (perderia as suas palavras).
      if (reason === "finished") recognizer?.restart();
    }
    refreshStatus();
  }

  // Mostra o que foi ouvido mesmo sem palavra-chave: confirma que a captura está viva e revela erros de
  // transcrição (o painel só reage ao texto exato; sem esta linha, "ouviu mas não entendeu" é invisível).
  function showHeard(text, ignored) {
    const clean = String(text ?? "").trim();
    if (clean === "") return;
    el.heard.textContent = `ouvi${ignored ? " (ignorado)" : ""}: "${clean}"`;
    el.heard.hidden = false;
    if (heardTimer !== null) clearTimer(heardTimer);
    heardTimer = setTimer(() => { heardTimer = null; el.heard.hidden = true; }, HEARD_HIDE_MS);
  }

  // Filtra o que o microfone ouve enquanto o agente fala: o eco dele mesmo não pode nem acionar a palavra-chave
  // nem interromper a fala; já a SUA voz interrompe (conforme VOICE_BARGE_IN).
  function onRecognizerResults(results) {
    const heard = results.at(-1)?.text ?? "";
    if (output && (output.speaking || now() < echoGuardUntil)) {
      const reference = output.speaking ? output.currentText : output.lastText;
      if (isEcho(heard, reference)) {
        showHeard(heard, true);
        controller.handleResults(results, { ignore: true });
        return;
      }
      if (output.speaking) {
        const mode = ttsConfig.bargeIn;
        if (mode === "off" || (mode === "wake" && !findWakeWord(heard, wakeWords, { fuzzy: false }))) {
          showHeard(heard, true);
          controller.handleResults(results, { ignore: true });
          return;
        }
        output.stop();
      }
    }
    showHeard(heard, false);
    controller.handleResults(results);
  }

  // ---------- comunicação com o agente ----------
  async function post(pathname, body) {
    try {
      const response = await fetch(pathname, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body),
      });
      let json = null;
      try { json = await response.json(); } catch { /* sem corpo */ }
      return { ok: response.ok, status: response.status, json };
    } catch {
      return { ok: false, status: 0, json: { error: "Não foi possível falar com o agente (o programa foi encerrado?)." } };
    }
  }

  function finishRun() {
    busy = false;
    taskByVoice = false;
    el.btnStop.hidden = true;
    hideConfirm();
    controller?.finishProcessing();
    refreshStatus();
  }

  async function submit(text, { byVoice = false } = {}) {
    output?.stop();
    busy = true;
    taskByVoice = byVoice;
    el.btnStop.hidden = false;
    addMessage("user", text);
    refreshStatus();
    const result = await post("/api/message", { text });
    if (!result.ok) {
      addMessage("error", result.json?.error ?? `Erro ${result.status} ao enviar a mensagem.`);
      finishRun();
    }
  }

  function answerConfirmation(decision) {
    const id = pendingConfirmId;
    if (id === null) return;
    hideConfirm();
    post("/api/confirm", { id, decision }).then((result) => {
      if (!result.ok) addMessage("error", result.json?.error ?? "Não foi possível enviar a resposta.");
    });
  }

  function connectEvents() {
    const source = new EventSource("/api/events");
    const on = (name, handler) => source.addEventListener(name, (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      handler(data);
    });

    on("hello", (data) => {
      hideNotice();
      if (data.busy && !busy) { busy = true; el.btnStop.hidden = false; refreshStatus(); }
      else if (!data.busy && busy) finishRun();
    });
    on("log", (data) => addMessage("tool", String(data.line ?? "").slice(0, MAX_LOG_CHARS)));
    on("answer", (data) => {
      addMessage("agent", data.text);
      const talk = shouldSpeak();
      finishRun();
      if (talk) output.speak(data.text);
    });
    on("error", (data) => {
      addMessage("error", data.message);
      const talk = shouldSpeak();
      finishRun();
      if (talk) output.speak("Encontrei um problema. Veja os detalhes no painel.");
    });
    on("confirm_request", (data) => {
      pendingConfirmId = data.id;
      el.confirmTitle.textContent = `O agente quer usar: ${data.tool}`;
      el.confirmText.textContent = data.description;
      el.btnAlways.hidden = !data.allowSessionApproval;
      el.confirm.hidden = false;
      playBeep();
      focusWindow();
      speak("Preciso da sua autorização. Confirme no painel."); // só um aviso: a autorização vale apenas com o clique
    });
    on("confirm_expired", (data) => {
      if (data.id !== pendingConfirmId) return;
      hideConfirm();
      addMessage("system", "A confirmação expirou: ação negada.");
    });
    source.onerror = () => showNotice("Conexão com o agente perdida. Tentando reconectar…");
    return source;
  }

  // ---------- voz de entrada ----------
  function onControllerEvent(event) {
    switch (event.type) {
      case "wake":
        output?.stop(); // você chamou: o agente para de falar
        el.live.hidden = false;
        el.liveText.textContent = "";
        startCountdown(event.deadline);
        playBeep();
        focusWindow();
        refreshStatus();
        break;
      case "transcript":
        el.liveText.textContent = event.text;
        startCountdown(event.deadline);
        break;
      case "send":
        stopCountdown();
        el.live.hidden = true;
        submit(event.text, { byVoice: true });
        break;
      case "cancel":
        stopCountdown();
        el.live.hidden = true;
        addMessage("system", `Captura cancelada (${event.reason}).`);
        refreshStatus();
        break;
      default:
        refreshStatus();
    }
  }

  function toggleMute() {
    muted = !muted;
    if (muted) recognizer?.stop(); else recognizer?.start();
    controller?.setEnabled(!muted);
    el.btnMute.textContent = muted ? "🔇" : "🎙️";
    refreshStatus();
  }

  function bindUi() {
    el.btnSend.addEventListener("click", () => controller?.sendNow());
    el.btnCancel.addEventListener("click", () => controller?.cancel("cancelado pelo usuário"));
    el.btnYes.addEventListener("click", () => answerConfirmation("yes"));
    el.btnAlways.addEventListener("click", () => answerConfirmation("always"));
    el.btnNo.addEventListener("click", () => answerConfirmation("no"));
    el.btnMute.addEventListener("click", toggleMute);
    el.btnHush.addEventListener("click", () => output?.stop());
    el.btnVoice.addEventListener("click", () => {
      voiceEnabled = !voiceEnabled;
      store.set(KEY_VOICE, voiceEnabled ? "on" : "off");
      if (!voiceEnabled) output?.stop();
      refreshVoiceButtons();
    });
    el.btnTyped.addEventListener("click", () => {
      speakTyped = !speakTyped;
      store.set(KEY_TYPED, speakTyped ? "on" : "off");
      refreshVoiceButtons();
    });
    el.btnNew.addEventListener("click", async () => {
      const result = await post("/api/reset", {});
      if (!result.ok) { addMessage("error", result.json?.error ?? "Não foi possível iniciar uma nova conversa."); return; }
      while (el.messages.children.length > 0) el.messages.removeChild(el.messages.children[0]);
      addMessage("system", "Nova conversa iniciada.");
    });
    el.btnStop.addEventListener("click", () => {
      addMessage("system", "Parando…");
      post("/api/stop", {});
    });
    el.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = el.text.value.trim();
      if (text === "") return;
      if (busy) { addMessage("system", "Aguarde: o agente ainda está trabalhando."); return; }
      if (controller?.state.mode === "capturing") controller.cancel("mensagem digitada");
      el.text.value = "";
      submit(text);
    });
    // Navegadores só liberam o som depois de uma interação com a página: o primeiro clique/tecla libera a voz.
    const unlock = () => output?.unlock();
    doc.addEventListener("pointerdown", unlock);
    doc.addEventListener("keydown", (event) => {
      unlock();
      if (event.key === "Escape" && controller?.state.mode === "capturing") controller.cancel("Esc");
    });
  }

  function buildOutput(config) {
    const tts = config.tts ?? {};
    const browserEngine = speechSynthesis && SpeechSynthesisUtterance
      ? createBrowserEngine({
        speechSynthesis, SpeechSynthesisUtterance, lang: tts.lang ?? config.lang, rate: tts.rate ?? 1, pitch: tts.pitch ?? 1,
        voiceName: tts.voiceName ?? undefined, setTimer, clearTimer,
      })
      : null;
    const serverEngine = tts.engine === "server" && AudioCtor && URLApi ? createServerEngine({ fetch, AudioCtor, URLApi }) : null;
    const primary = serverEngine ?? browserEngine;
    if (!primary) return null;
    return createVoiceOutput({
      engine: primary, fallback: serverEngine ? browserEngine : null,
      onChange: onSpeakingChange, onNotice: showNotice, maxChars: tts.maxChars ?? 1200,
    });
  }

  async function start() {
    bindUi();
    let config;
    try {
      const response = await fetch("/api/config", { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      config = await response.json();
    } catch {
      showNotice("Não foi possível carregar a configuração. Reabra o painel pelo endereço completo mostrado no terminal.");
      el.boot.hidden = true;
      return;
    }

    wakeWords = parseWakeWords(config.wakeWords);
    firstWord = wakeWords[0].label;
    silenceMs = config.silenceMs;
    ttsConfig = config.tts ?? ttsConfig;
    el.title.textContent = config.title ?? "J.A.R.V.I.S.";
    el.model.textContent = config.model ?? "";
    controller = createVoiceController({
      wakeWords, silenceMs: config.silenceMs, maxCaptureMs: config.maxCaptureMs, fuzzy: Boolean(config.fuzzy),
      onEvent: onControllerEvent, setTimer, clearTimer, now,
    });

    if (config.tts?.replies === "off") voiceEnabled = false;
    output = buildOutput(config);
    el.btnVoice.hidden = !output;
    el.btnTyped.hidden = !output;
    refreshVoiceButtons();

    if (SpeechRecognitionCtor) {
      recognizer = createBrowserRecognizer({
        SpeechRecognitionCtor, lang: config.lang,
        onResults: onRecognizerResults,
        onSessionEnd: () => controller.handleSessionEnd(),
        onFatal: (message) => { fatal = true; showNotice(message); refreshStatus(); },
        onNotice: showNotice, setTimer, clearTimer, now, debug,
      });
      recognizer.start();
    } else {
      showNotice("Este navegador não tem reconhecimento de voz. Use o Chrome ou o Edge, ou digite abaixo.");
    }
    connectEvents();
    el.boot.hidden = true;
    refreshStatus();
  }

  return {
    start,
    get controller() { return controller; },
    get recognizer() { return recognizer; },
    get output() { return output; },
  };
}
