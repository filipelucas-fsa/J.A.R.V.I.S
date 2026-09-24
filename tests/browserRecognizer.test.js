import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createBrowserRecognizer } from "../src/voice/web/browserRecognizer.js";
import { createClock } from "./helpers/fakeClock.js";
import { FakeSpeechRecognition } from "./helpers/fakeDom.js";

beforeEach(() => { FakeSpeechRecognition.instances.length = 0; });

function setup(options = {}) {
  const clock = createClock();
  const log = { results: [], ends: 0, fatal: [], notices: [] };
  const recognizer = createBrowserRecognizer({
    SpeechRecognitionCtor: FakeSpeechRecognition, lang: "pt-BR",
    onResults: (r) => log.results.push(r), onSessionEnd: () => log.ends++,
    onFatal: (m) => log.fatal.push(m), onNotice: (m) => log.notices.push(m),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, ...options,
  });
  return { recognizer, clock, log };
}

test("configura contínuo, resultados parciais e idioma", () => {
  const { recognizer } = setup();
  recognizer.start();
  const rec = FakeSpeechRecognition.last;
  assert.deepEqual([rec.started, rec.lang, rec.continuous, rec.interimResults, rec.maxAlternatives], [true, "pt-BR", true, true, 1]);
});

test("converte os resultados do navegador em [{text, isFinal}]", () => {
  const { recognizer, log } = setup();
  recognizer.start();
  FakeSpeechRecognition.last.fire([{ text: "Jarvis abra", isFinal: true }, { text: "a pasta" }]);
  assert.deepEqual(log.results[0], [{ text: "Jarvis abra", isFinal: true }, { text: "a pasta", isFinal: false }]);
});

test("start() repetido não cria dois reconhecedores", () => {
  const { recognizer } = setup();
  recognizer.start();
  recognizer.start();
  assert.equal(FakeSpeechRecognition.instances.length, 1);
});

test("o navegador encerra a sessão sozinho: avisa e reinicia depois de uma pausa", () => {
  const { recognizer, clock, log } = setup();
  recognizer.start();
  clock.advance(30_000);
  FakeSpeechRecognition.last.finish();
  assert.equal(log.ends, 1);
  assert.equal(FakeSpeechRecognition.instances.length, 1);
  clock.advance(299);
  assert.equal(FakeSpeechRecognition.instances.length, 1);
  clock.advance(1);
  assert.equal(FakeSpeechRecognition.instances.length, 2);
  assert.equal(FakeSpeechRecognition.last.started, true);
});

test("reinícios muito rápidos aumentam a espera (evita laço infinito)", () => {
  const { recognizer, clock } = setup();
  recognizer.start();
  const delays = [];
  for (let i = 0; i < 7; i++) {
    const before = FakeSpeechRecognition.instances.length;
    FakeSpeechRecognition.last.finish(); // terminou na hora
    let waited = 0;
    while (FakeSpeechRecognition.instances.length === before && waited < 20_000) { clock.advance(50); waited += 50; }
    delays.push(waited);
  }
  assert.ok(delays[3] > delays[0], delays.join(","));
  assert.ok(Math.max(...delays) <= 5_100, delays.join(","));
});

test("stop() cancela o reinício e aborta a sessão", () => {
  const { recognizer, clock } = setup();
  recognizer.start();
  const rec = FakeSpeechRecognition.last;
  recognizer.stop();
  assert.equal(rec.aborted, true);
  assert.equal(recognizer.running, false);
  rec.finish();
  clock.advance(60_000);
  assert.equal(FakeSpeechRecognition.instances.length, 1);
  recognizer.start(); // ligar de novo funciona
  assert.equal(FakeSpeechRecognition.instances.length, 2);
});

test("erros que exigem ação do usuário param o reconhecimento e explicam", () => {
  const cases = [
    ["not-allowed", /Permissão do microfone negada/], ["service-not-allowed", /Permissão do microfone negada/],
    ["audio-capture", /Nenhum microfone/], ["language-not-supported", /VOICE_LANG/],
  ];
  for (const [error, pattern] of cases) {
    FakeSpeechRecognition.instances.length = 0;
    const { recognizer, clock, log } = setup();
    recognizer.start();
    FakeSpeechRecognition.last.fail(error);
    FakeSpeechRecognition.last.finish();
    clock.advance(60_000);
    assert.match(log.fatal[0], pattern, error);
    assert.equal(FakeSpeechRecognition.instances.length, 1, `${error}: não deve reiniciar`);
    assert.equal(recognizer.running, false);
  }
});

test("erros temporários: 'network' avisa e continua; 'no-speech' e 'aborted' são normais", () => {
  const { recognizer, clock, log } = setup();
  recognizer.start();
  FakeSpeechRecognition.last.fail("network");
  FakeSpeechRecognition.last.fail("no-speech");
  FakeSpeechRecognition.last.fail("aborted");
  assert.equal(log.notices.length, 1);
  assert.match(log.notices[0], /Sem conexão/);
  assert.equal(log.fatal.length, 0);
  FakeSpeechRecognition.last.finish();
  clock.advance(1_000);
  assert.equal(FakeSpeechRecognition.instances.length, 2);
});

test("diagnóstico: debug registra o ciclo de vida (início, o que ouviu, erros e reinício)", () => {
  const lines = [];
  const { recognizer, clock } = setup({ debug: (line) => lines.push(line) });
  recognizer.start();
  FakeSpeechRecognition.last.fire([{ text: "Jarvis", isFinal: false }]);
  FakeSpeechRecognition.last.fail("aborted");
  FakeSpeechRecognition.last.finish();
  clock.advance(600);
  assert.ok(lines.some((l) => /escuta iniciada/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /ouvi "Jarvis"/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /erro do reconhecimento: aborted/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /reiniciando em \d+ms/.test(l)), lines.join(" | "));
});

test("start() que lança erro: 'already started' é ignorado; qualquer outro é fatal", () => {
  const original = FakeSpeechRecognition.prototype.start;
  try {
    FakeSpeechRecognition.prototype.start = function () { throw new Error("recognition has already started"); };
    const a = setup();
    a.recognizer.start();
    assert.equal(a.log.fatal.length, 0);

    FakeSpeechRecognition.prototype.start = function () { throw new Error("falha estranha"); };
    const b = setup();
    b.recognizer.start();
    assert.match(b.log.fatal[0], /falha estranha/);
    assert.equal(b.recognizer.running, false);
  } finally {
    FakeSpeechRecognition.prototype.start = original;
  }
});
