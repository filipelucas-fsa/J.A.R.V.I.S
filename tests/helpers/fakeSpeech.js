// Dublês da síntese de voz do navegador.
export class FakeSynth {
  constructor(voices = []) { this.voices = voices; this.spoken = []; this.canceled = 0; this.listeners = {}; }
  getVoices() { return this.voices; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] ?? []).filter((f) => f !== fn); }
  speak(utterance) { this.spoken.push(utterance); }
  cancel() {
    this.canceled++;
    const current = this.spoken.at(-1);
    if (current && !current.done) { current.done = true; current.onerror?.({ error: "canceled" }); }
  }
  end(index = this.spoken.length - 1) { const u = this.spoken[index]; u.done = true; u.onend(); }
  fail(error, index = this.spoken.length - 1) { const u = this.spoken[index]; u.done = true; u.onerror({ error }); }
  emitVoices(voices) { this.voices = voices; for (const fn of this.listeners.voiceschanged ?? []) fn(); }
}
export class Utterance { constructor(text) { this.text = text; } }
export const v = (name, lang = "pt-BR") => ({ name, lang });

