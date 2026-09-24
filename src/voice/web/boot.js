import { createPanel } from "./panel.js";

// Liga o painel ao navegador de verdade. Toda a lógica está em panel.js (testada com dublês).
const w = window;
const AudioContextCtor = w.AudioContext || w.webkitAudioContext;

// Aviso sonoro curto ao ouvir a palavra-chave. Alguns navegadores bloqueiam som antes de você clicar na página.
function playBeep() {
  try {
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.05;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => context.close();
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
  } catch {
    // sem áudio: segue sem o aviso
  }
}

// Tenta colocar a janela no canto inferior direito (nem todo navegador permite mover a janela por script).
try {
  const width = w.outerWidth || 400;
  const height = w.outerHeight || 640;
  w.moveTo((w.screen.availLeft ?? 0) + w.screen.availWidth - width - 16, (w.screen.availTop ?? 0) + w.screen.availHeight - height - 16);
} catch {
  // ignora
}

let storage = null;
try { storage = w.localStorage; } catch { /* armazenamento bloqueado */ }

createPanel({
  document: w.document,
  fetch: w.fetch.bind(w),
  EventSource: w.EventSource,
  SpeechRecognitionCtor: w.SpeechRecognition || w.webkitSpeechRecognition,
  speechSynthesis: w.speechSynthesis,
  SpeechSynthesisUtterance: w.SpeechSynthesisUtterance,
  AudioCtor: w.Audio,
  URLApi: w.URL,
  setTimer: (fn, ms) => w.setTimeout(fn, ms),
  clearTimer: (id) => w.clearTimeout(id),
  setTicker: (fn, ms) => w.setInterval(fn, ms),
  clearTicker: (id) => w.clearInterval(id),
  now: () => Date.now(),
  playBeep,
  focusWindow: () => { try { w.focus(); } catch { /* ignora */ } },
  storage,
  // Diagnóstico de voz no DevTools (Ctrl+Shift+I): tudo que o microfone ouve e o ciclo de vida da escuta.
  debug: (...args) => console.debug("[voz]", ...args),
}).start();
