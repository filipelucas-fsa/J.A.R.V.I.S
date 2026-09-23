import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechError, createBrowserEngine, createServerEngine, createVoiceOutput } from "../src/voice/web/voiceOutput.js";
import { createClock } from "./helpers/fakeClock.js";
import { flush } from "./helpers/fakeDom.js";
import { FakeSynth, Utterance, v } from "./helpers/fakeSpeech.js";

// ---------- doubles ----------
function browserEngine(synth, options = {}) {
  const clock = createClock();
  return { clock, engine: createBrowserEngine({ speechSynthesis: synth, SpeechSynthesisUtterance: Utterance, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options }) };
}

// ---------- motor do navegador ----------
test("navegador: usa a melhor voz pt-BR e aplica idioma, velocidade e tom", async () => {
  const synth = new FakeSynth([v("Microsoft Maria - Portuguese (Brazil)"), v("Microsoft Antonio Online (Natural) - Portuguese (Brazil)"), v("David", "en-US")]);
  const { engine } = browserEngine(synth, { rate: 1.1, pitch: 0.9 });
  const done = engine.speak("Olá");
  await flush();
  const u = synth.spoken[0];
  assert.deepEqual([u.text, u.lang, u.rate, u.pitch], ["Olá", "pt-BR", 1.1, 0.9]);
  assert.match(u.voice.name, /Antonio/);
  synth.end();
  await done;
  assert.match(engine.voiceName, /Antonio/);
});

test("navegador: espera a lista de vozes chegar (voiceschanged) e cai na voz padrão se não vier", async () => {
  const synth = new FakeSynth([]);
  const { engine } = browserEngine(synth);
  const first = engine.speak("um");
  await flush();
  assert.equal(synth.spoken.length, 0); // ainda esperando as vozes
  synth.emitVoices([v("Google português do Brasil")]);
  await flush();
  assert.match(synth.spoken[0].voice.name, /Google/);
  synth.end();
  await first;

  const empty = new FakeSynth([]);
  const { engine: lateEngine, clock } = browserEngine(empty, { voicesTimeoutMs: 1500 });
  const waiting = lateEngine.speak("dois");
  await flush();
  clock.advance(1500);
  await flush();
  assert.equal(empty.spoken.length, 1);
  assert.equal(empty.spoken[0].voice, undefined); // sem voz pt-BR: fala com a padrão, no idioma pedido
  assert.equal(empty.spoken[0].lang, "pt-BR");
  empty.end();
  await waiting;
});

test("navegador: nome de voz preferido; entradas quebradas do Edge são ignoradas", async () => {
  const synth = new FakeSynth([{ name: "Microsoft undefined Online (Natural) - undefined", lang: "pt-BR" }, v("Microsoft Francisca Online (Natural)"), v("Microsoft Antonio Online (Natural)")]);
  const { engine } = browserEngine(synth, { voiceName: "francisca" });
  const p = engine.speak("x");
  await flush();
  assert.match(synth.spoken[0].voice.name, /Francisca/);
  synth.end();
  await p;
});

test("navegador: cancelar resolve sem erro; abortar por sinal cancela a síntese", async () => {
  const synth = new FakeSynth([v("Google português do Brasil")]);
  const { engine } = browserEngine(synth);
  const p = engine.speak("texto longo");
  await flush();
  engine.cancel();
  await p; // não lança
  const controller = new AbortController();
  const q = engine.speak("outro", { signal: controller.signal });
  await flush();
  controller.abort();
  await q;
  assert.ok(synth.canceled >= 2);
  const already = new AbortController();
  already.abort();
  const before = synth.spoken.length;
  await engine.speak("nem começa", { signal: already.signal });
  assert.equal(synth.spoken.length, before);
});

test("navegador: erros — 'not-allowed' vira SpeechError com código; outros também", async () => {
  const synth = new FakeSynth([v("Voz")]);
  const { engine } = browserEngine(synth);
  const a = engine.speak("a");
  await flush();
  synth.fail("not-allowed");
  await assert.rejects(a, (e) => e instanceof SpeechError && e.code === "not-allowed");
  const b = engine.speak("b");
  await flush();
  synth.fail("synthesis-failed");
  await assert.rejects(b, (e) => e.code === "synthesis-failed" && /synthesis-failed/.test(e.message));
  const c = engine.speak("c");
  await flush();
  synth.fail(undefined);
  await assert.rejects(c, /desconhecida/);
});

test("navegador: unlock fala um texto mudo (libera o som após o primeiro clique)", () => {
  const synth = new FakeSynth([]);
  const { engine } = browserEngine(synth);
  engine.unlock();
  assert.equal(synth.spoken[0].volume, 0);
  const broken = { getVoices: () => [], speak() { throw new Error("sem síntese"); } };
  assert.doesNotThrow(() => browserEngine(broken).engine.unlock());
});

// ---------- motor do servidor ----------
class FakeAudio {
  static instances = [];
  constructor(url) { this.url = url; this.paused = false; FakeAudio.instances.push(this); }
  play() { if (FakeAudio.playError) return Promise.reject(FakeAudio.playError); return Promise.resolve(); }
  pause() { this.paused = true; }
  finish() { this.onended(); }
  static get last() { return FakeAudio.instances.at(-1); }
}
function serverEngine(route) {
  FakeAudio.instances.length = 0;
  FakeAudio.playError = null;
  const calls = [];
  const revoked = [];
  const fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const r = (await route?.(calls.at(-1))) ?? {};
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json ?? {}, blob: async () => r.blob ?? "BLOB" };
  };
  const URLApi = { createObjectURL: (b) => `blob:${b}`, revokeObjectURL: (u) => revoked.push(u) };
  return { calls, revoked, engine: createServerEngine({ fetch, AudioCtor: FakeAudio, URLApi }) };
}

test("servidor: pede o áudio a /api/tts, toca e libera a URL do blob", async () => {
  const { engine, calls, revoked } = serverEngine();
  const p = engine.speak("Olá mundo");
  await flush();
  assert.deepEqual(calls[0], { url: "/api/tts", body: { text: "Olá mundo" } });
  assert.equal(FakeAudio.last.url, "blob:BLOB");
  FakeAudio.last.finish();
  await p;
  assert.deepEqual(revoked, ["blob:BLOB"]);
});

test("servidor: prefetch evita buscar o mesmo trecho duas vezes", async () => {
  const { engine, calls } = serverEngine();
  engine.prefetch("trecho dois");
  engine.prefetch("trecho dois");
  engine.prefetch("");
  const p = engine.speak("trecho dois");
  await flush();
  assert.equal(calls.length, 1);
  FakeAudio.last.finish();
  await p;
});

test("servidor: erro do servidor de voz vira SpeechError com a mensagem dele; sem corpo usa o status", async () => {
  const a = serverEngine(() => ({ status: 502, json: { error: "Kokoro fora do ar" } }));
  await assert.rejects(a.engine.speak("x"), (e) => e.code === "tts-failed" && /Kokoro fora do ar/.test(e.message));
  const b = serverEngine(() => ({ status: 500 }));
  await assert.rejects(b.engine.speak("x"), /erro 500/);
  const c = serverEngine();
  c.engine.prefetch("falha");
  const failing = serverEngine(() => ({ status: 502, json: { error: "x" } }));
  failing.engine.prefetch("t");
  await assert.rejects(failing.engine.speak("t"), /x/); // prefetch que falhou propaga o erro
});

test("servidor: áudio bloqueado pelo navegador, erro de reprodução e cancelamento", async () => {
  const a = serverEngine();
  FakeAudio.playError = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
  await assert.rejects(a.engine.speak("x"), (e) => e.code === "not-allowed");
  const b = serverEngine();
  FakeAudio.playError = new Error("decode");
  await assert.rejects(b.engine.speak("x"), (e) => e.code === "audio-error");
  const c = serverEngine();
  const p = c.engine.speak("x");
  await flush();
  FakeAudio.last.onerror();
  await assert.rejects(p, /Não foi possível tocar/);
  const d = serverEngine();
  const q = d.engine.speak("x");
  await flush();
  d.engine.cancel();
  assert.equal(FakeAudio.last.paused, true);
  FakeAudio.last.finish();
  await q;
  const controller = new AbortController();
  const e = serverEngine();
  const r = e.engine.speak("x", { signal: controller.signal });
  await flush();
  controller.abort();
  await r;
  assert.equal(FakeAudio.last.paused, true);
});

// ---------- gerenciador ----------
function fakeEngine(name = "fake") {
  const engine = {
    name, spoken: [], canceled: 0, prefetched: [], pending: [],
    speak(text, { signal } = {}) {
      engine.spoken.push(text);
      return new Promise((resolve, reject) => {
        engine.pending.push({ resolve, reject });
        signal?.addEventListener("abort", resolve, { once: true });
      });
    },
    cancel() { engine.canceled++; },
    prefetch(text) { engine.prefetched.push(text); },
    unlocked: 0, unlock() { engine.unlocked++; },
    finishCurrent() { engine.pending.shift().resolve(); },
    failCurrent(error) { engine.pending.shift().reject(error); },
  };
  return engine;
}
const setup = (options = {}) => {
  const engine = fakeEngine("principal");
  const changes = [];
  const notices = [];
  const output = createVoiceOutput({ engine, onChange: (c) => changes.push(c.speaking), onNotice: (n) => notices.push(n), ...options });
  return { engine, output, changes, notices };
};
const LONG = "Primeira frase bem comprida para forçar trechos. ".repeat(12);

test("fala os trechos em sequência: o próximo só começa quando o anterior termina", async () => {
  const { engine, output, changes } = setup();
  const done = output.speak(LONG);
  await flush();
  assert.equal(output.speaking, true);
  assert.equal(engine.spoken.length, 1);
  assert.equal(engine.prefetched.length, 1); // já pediu o próximo trecho
  engine.finishCurrent();
  await flush();
  assert.equal(engine.spoken.length, 2);
  while (engine.pending.length) { engine.finishCurrent(); await flush(); }
  await done;
  assert.equal(output.speaking, false);
  assert.deepEqual(changes, [true, false]);
  assert.ok(engine.spoken.length >= 3);
});

test("limpa markdown e código antes de falar; texto vazio não faz nada", async () => {
  const { engine, output } = setup();
  const p = output.speak("**Feito.** Veja https://x.com e:\n```js\nfoo()\n```");
  await flush();
  assert.ok(!/[*`]|https|foo/.test(engine.spoken[0]));
  assert.match(engine.spoken[0], /link/);
  engine.finishCurrent();
  await p;
  await output.speak("   ");
  await output.speak("```\ncódigo```".replace("```\ncódigo", "").replace("```", ""));
  assert.equal(engine.spoken.length, 1);
});

test("stop() interrompe na hora, cancela o motor e não fala os trechos seguintes", async () => {
  const { engine, output, changes } = setup();
  const p = output.speak(LONG);
  await flush();
  output.stop();
  await p;
  assert.equal(output.speaking, false);
  assert.equal(engine.canceled, 1);
  assert.equal(engine.spoken.length, 1);
  assert.deepEqual(changes, [true, false]);
  output.stop(); // sem nada falando: nada acontece
  assert.deepEqual(changes, [true, false]);
});

test("uma fala nova interrompe a anterior", async () => {
  const { engine, output, changes } = setup();
  const a = output.speak("Primeira resposta.");
  await flush();
  const b = output.speak("Segunda resposta.");
  await flush();
  assert.equal(engine.canceled, 1);
  assert.deepEqual(engine.spoken, ["Primeira resposta.", "Segunda resposta."]);
  engine.pending.at(-1).resolve();
  await Promise.all([a, b]);
  assert.equal(output.speaking, false);
  assert.deepEqual(changes, [true, false, true, false]);
});

test("guarda o texto falado (currentText e lastText) para a detecção de eco", async () => {
  const { engine, output } = setup();
  const p = output.speak("Encontrei três arquivos.");
  await flush();
  assert.equal(output.currentText, "Encontrei três arquivos.");
  engine.finishCurrent();
  await p;
  assert.equal(output.currentText, "");
  assert.equal(output.lastText, "Encontrei três arquivos.");
});

test("navegador bloqueou o som: avisa e retoma do MESMO trecho no primeiro clique", async () => {
  const { engine, output, notices, changes } = setup();
  const p = output.speak(LONG);
  await flush();
  engine.finishCurrent();
  await flush();
  engine.failCurrent(new SpeechError("bloqueado", "not-allowed")); // 2º trecho é bloqueado
  await p;
  assert.match(notices[0], /Clique uma vez/);
  assert.equal(output.speaking, false);
  const blockedText = engine.spoken.at(-1);
  output.unlock();
  await flush();
  assert.equal(engine.unlocked, 1);
  assert.equal(engine.spoken.at(-1), blockedText);
  assert.equal(output.speaking, true);
  while (engine.pending.length) { engine.finishCurrent(); await flush(); }
  assert.equal(output.speaking, false);
  assert.equal(changes.at(-1), false);
  output.unlock(); // nada bloqueado e já liberado: não repete o "sussurro" (atrasaria a fala seguinte)
  assert.equal(engine.unlocked, 1);
});

test("motor principal falha: usa o alternativo no mesmo trecho e continua com ele", async () => {
  const fallback = fakeEngine("navegador");
  const { engine, output, notices } = setup({ fallback });
  const p = output.speak(LONG);
  await flush();
  engine.failCurrent(new SpeechError("Kokoro fora do ar", "tts-failed"));
  await flush();
  assert.match(notices[0], /Kokoro fora do ar.*voz do navegador/);
  assert.equal(fallback.spoken[0], engine.spoken[0]); // repetiu o mesmo trecho
  assert.equal(output.engineName, "navegador");
  fallback.finishCurrent();
  await flush();
  assert.equal(engine.spoken.length, 1); // o restante segue no alternativo
  assert.equal(fallback.spoken.length, 2);
  while (fallback.pending.length) { fallback.finishCurrent(); await flush(); }
  await p;
  const next = output.speak("Outra.");
  await flush();
  assert.equal(fallback.spoken.at(-1), "Outra.");
  fallback.finishCurrent();
  await next;
});

test("sem alternativo, a falha é avisada e a fala termina sem travar", async () => {
  const { engine, output, notices } = setup();
  const p = output.speak(LONG);
  await flush();
  engine.failCurrent(new Error("quebrou"));
  await p;
  assert.match(notices[0], /Não consegui falar: quebrou/);
  assert.equal(output.speaking, false);
});

test("alternativo também falha: avisa e termina", async () => {
  const fallback = fakeEngine("navegador");
  const { engine, output, notices } = setup({ fallback });
  const p = output.speak("Uma frase.");
  await flush();
  engine.failCurrent(new Error("principal caiu"));
  await flush();
  fallback.failCurrent(new Error("alternativo caiu"));
  await p;
  assert.equal(notices.length, 2);
  assert.match(notices[1], /alternativo caiu/);
  assert.equal(output.speaking, false);
});

test("stop() também cancela o motor alternativo e impede retomar um trecho bloqueado", async () => {
  const fallback = fakeEngine("navegador");
  const { engine, output } = setup({ fallback });
  const p = output.speak("Uma frase.");
  await flush();
  engine.failCurrent(new SpeechError("x", "not-allowed"));
  await p;
  output.stop();
  const before = engine.spoken.length;
  output.unlock();
  await flush();
  assert.equal(engine.spoken.length, before); // parou: não retoma
  const q = output.speak("Outra.");
  await flush();
  output.stop();
  await q;
  assert.equal(fallback.canceled, 1);
});
