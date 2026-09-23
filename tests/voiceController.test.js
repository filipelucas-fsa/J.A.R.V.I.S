import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceController } from "../src/voice/web/voiceController.js";
import { parseWakeWords } from "../src/voice/web/wakeWord.js";
import { createClock } from "./helpers/fakeClock.js";

const wakeWords = parseWakeWords("jarvis,sexta-feira,batman");
const r = (text, isFinal = false) => ({ text, isFinal });

function setup(options = {}) {
  const clock = createClock();
  const events = [];
  const controller = createVoiceController({ wakeWords, onEvent: (e) => events.push(e), ...clock, ...options });
  const types = () => events.map((e) => e.type);
  const last = (type) => events.filter((e) => e.type === type).at(-1);
  return { controller, clock, events, types, last };
}

test("sem palavra-chave nada acontece", () => {
  const { controller, events, clock } = setup();
  controller.handleResults([r("bom dia, o que temos hoje?", true)]);
  controller.handleResults([r("bom dia, o que temos hoje?", true), r("vou almoçar")]);
  clock.advance(60_000);
  assert.deepEqual(events, []);
  assert.equal(controller.state.mode, "idle");
});

test("palavra-chave abre a captura e o texto seguinte aparece em tempo real", () => {
  const { controller, events, clock } = setup();
  controller.handleResults([r("Jarvis abra a pasta")]);
  assert.equal(events[0].type, "wake");
  assert.equal(events[0].word, "jarvis");
  assert.equal(events[0].deadline, clock.now() + 10_000);
  assert.equal(events[1].type, "transcript");
  assert.equal(events[1].text, "abra a pasta");
  assert.equal(controller.state.mode, "capturing");
});

test("ENVIA após 10 s sem falar: nem antes, nem depois", () => {
  const { controller, clock, types, last } = setup();
  controller.handleResults([r("Jarvis abra a pasta de downloads")]);
  clock.advance(9_999);
  assert.ok(!types().includes("send"));
  clock.advance(1);
  assert.deepEqual(last("send"), { type: "send", text: "abra a pasta de downloads", reason: "silêncio" });
  assert.equal(controller.state.mode, "processing");
  clock.advance(60_000);
  assert.equal(types().filter((t) => t === "send").length, 1);
});

test("novas palavras reiniciam os 10 s; repetir o mesmo texto NÃO reinicia", () => {
  const { controller, clock, types, last } = setup();
  controller.handleResults([r("Jarvis abra")]); // t=0
  clock.advance(6_000);
  controller.handleResults([r("Jarvis abra o navegador")]); // palavras novas: prazo vai para t=16s
  assert.equal(last("transcript").deadline, clock.now() + 10_000);
  clock.advance(4_000); // t=10s: nada
  controller.handleResults([r("Jarvis abra o navegador")]); // igual: não reinicia
  clock.advance(5_900); // t=15,9s
  assert.ok(!types().includes("send"));
  clock.advance(200); // t=16,1s
  assert.equal(last("send").text, "abra o navegador");
});

test("só disse a palavra-chave e nada mais: cancela em vez de enviar mensagem vazia", () => {
  const { controller, clock, types, last } = setup();
  controller.handleResults([r("Jarvis")]);
  assert.equal(controller.state.mode, "capturing");
  clock.advance(10_000);
  assert.ok(!types().includes("send"));
  assert.equal(last("cancel").reason, "nada foi dito");
  assert.equal(controller.state.mode, "idle");
  assert.equal(clock.pending, 0);
});

test("fala em vários trechos: junta, ignorando o que veio ANTES da palavra-chave", () => {
  const { controller, clock, last } = setup();
  controller.handleResults([r("bom dia a todos", true), r("Sexta-feira liga a luz")]);
  assert.equal(last("wake").word, "sexta-feira");
  controller.handleResults([r("bom dia a todos", true), r("Sexta-feira liga a luz da sala", true), r("e fecha a porta")]);
  assert.equal(last("transcript").text, "liga a luz da sala e fecha a porta");
  clock.advance(10_000);
  assert.equal(last("send").text, "liga a luz da sala e fecha a porta");
});

test("o texto reconhecido pode ser revisado enquanto a pessoa fala", () => {
  const { controller, clock, last } = setup();
  controller.handleResults([r("jarvis a bra")]);
  controller.handleResults([r("Jarvis abra o navegador")]);
  controller.handleResults([r("Jarvis, abra o navegador.", true)]);
  clock.advance(10_000);
  assert.equal(last("send").text, "abra o navegador.");
});

test("o navegador reinicia a sessão de voz no meio da fala: nada se perde", () => {
  const { controller, clock, last } = setup();
  controller.handleResults([r("Jarvis abra o", true)]);
  controller.handleSessionEnd();
  controller.handleResults([r("navegador", true)]);
  assert.equal(last("transcript").text, "abra o navegador");
  controller.handleSessionEnd();
  controller.handleResults([r("e pesquise gatos")]);
  clock.advance(10_000);
  assert.equal(last("send").text, "abra o navegador e pesquise gatos");
});

test("sessão reiniciada em espera: a próxima fala volta a ser examinada do zero", () => {
  const { controller, types } = setup();
  controller.handleResults([r("conversa qualquer", true)]);
  controller.handleSessionEnd();
  controller.handleResults([r("Batman abre a pasta")]);
  assert.deepEqual(types().slice(0, 2), ["wake", "transcript"]);
});

test("depois de enviar, a fala durante o processamento é ignorada e depois volta a escutar", () => {
  const { controller, clock, types } = setup();
  controller.handleResults([r("Jarvis faça isso", true)]);
  clock.advance(10_000);
  assert.equal(controller.state.mode, "processing");
  controller.handleResults([r("Jarvis faça isso", true), r("Jarvis cancela tudo", true)]); // dito enquanto trabalha
  assert.ok(!types().includes("cancel"));
  assert.equal(types().filter((t) => t === "wake").length, 1);

  controller.finishProcessing();
  assert.equal(types().at(-1), "idle");
  controller.handleResults([r("Jarvis faça isso", true), r("Jarvis cancela tudo", true)]); // mesma fala: não reage
  assert.equal(types().filter((t) => t === "wake").length, 1);
  controller.handleResults([r("Jarvis faça isso", true), r("Jarvis cancela tudo", true), r("Batman outra coisa")]);
  assert.equal(types().filter((t) => t === "wake").length, 2);
});

test("finishProcessing só age depois de um envio", () => {
  const { controller, types } = setup();
  controller.finishProcessing();
  assert.deepEqual(types(), []);
});

test("enviar agora (botão) e cancelar", () => {
  const a = setup();
  a.controller.handleResults([r("Jarvis abra a pasta")]);
  a.controller.sendNow();
  assert.deepEqual(a.last("send"), { type: "send", text: "abra a pasta", reason: "manual" });
  assert.equal(a.clock.pending, 0);

  const b = setup();
  b.controller.handleResults([r("Jarvis abra a pasta")]);
  b.controller.cancel("Esc");
  assert.deepEqual(b.last("cancel"), { type: "cancel", reason: "Esc" });
  assert.equal(b.clock.pending, 0);
  b.controller.handleResults([r("Jarvis abra a pasta")]); // a mesma fala não reabre a captura
  assert.equal(b.types().filter((t) => t === "wake").length, 1);

  const c = setup();
  c.controller.handleResults([r("Jarvis")]);
  c.controller.sendNow(); // vazio: cancela
  assert.equal(c.last("cancel").reason, "nada foi dito");

  const d = setup();
  d.controller.sendNow();
  d.controller.cancel();
  assert.deepEqual(d.events, []);
});

test("tempo máximo de captura força o envio mesmo com fala contínua", () => {
  const { controller, clock, last } = setup({ silenceMs: 10_000, maxCaptureMs: 30_000 });
  let text = "Jarvis";
  for (let i = 0; i < 8; i++) {
    text += ` palavra${i}`;
    controller.handleResults([r(text)]);
    clock.advance(5_000);
  }
  assert.equal(last("send").reason, "tempo máximo");
  assert.match(last("send").text, /^palavra0 /);
});

test("tempo de silêncio configurável", () => {
  const { controller, clock, types } = setup({ silenceMs: 3_000 });
  controller.handleResults([r("Jarvis oi")]);
  clock.advance(2_999);
  assert.ok(!types().includes("send"));
  clock.advance(1);
  assert.ok(types().includes("send"));
});

test("microfone desligado: cancela a captura e ignora a fala até religar", () => {
  const { controller, types, last } = setup();
  controller.handleResults([r("Jarvis abra")]);
  controller.setEnabled(false);
  assert.equal(last("cancel").reason, "microfone desligado");
  const wakes = () => types().filter((t) => t === "wake").length;
  controller.handleResults([r("Jarvis abra", true), r("Batman oi", true)]); // dito com o microfone desligado
  assert.equal(wakes(), 1);
  controller.setEnabled(true);
  controller.handleResults([r("Jarvis abra", true), r("Batman oi", true)]); // religou: o que passou é ignorado
  assert.equal(wakes(), 1);
  controller.handleResults([r("Jarvis abra", true), r("Batman oi", true), r("Sexta-feira agora sim")]);
  assert.equal(wakes(), 2);
});

test("palavra-chave repetida durante a captura vira texto da mensagem", () => {
  const { controller, clock, last } = setup();
  controller.handleResults([r("Jarvis diga jarvis é um nome")]);
  clock.advance(10_000);
  assert.equal(last("send").text, "diga jarvis é um nome");
});

test("destroy limpa os temporizadores", () => {
  const { controller, clock } = setup();
  controller.handleResults([r("Jarvis abra")]);
  assert.ok(clock.pending > 0);
  controller.destroy();
  assert.equal(clock.pending, 0);
});

test("entradas estranhas não quebram (texto ausente, lista vazia)", () => {
  const { controller } = setup();
  assert.doesNotThrow(() => controller.handleResults([]));
  assert.doesNotThrow(() => controller.handleResults([{ isFinal: true }, { text: null }]));
  assert.doesNotThrow(() => controller.handleSessionEnd());
  assert.equal(controller.state.mode, "idle");
});
