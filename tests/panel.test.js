import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPanel } from "../src/voice/web/panel.js";
import { createClock } from "./helpers/fakeClock.js";
import { FakeDocument, FakeEventSource, FakeSpeechRecognition, createFakeFetch, flush } from "./helpers/fakeDom.js";
import { FakeSynth, Utterance, v } from "./helpers/fakeSpeech.js";

beforeEach(() => {
  FakeEventSource.instances.length = 0;
  FakeSpeechRecognition.instances.length = 0;
});

const CONFIG = { wakeWords: ["jarvis", "sexta-feira", "batman"], lang: "pt-BR", silenceMs: 10_000, maxCaptureMs: 120_000, fuzzy: false };

class MemoryStorage {
  constructor(initial = {}) { this.data = { ...initial }; }
  getItem(key) { return key in this.data ? this.data[key] : null; }
  setItem(key, value) { this.data[key] = String(value); }
}

async function mount({ config = CONFIG, speech = true, route, synth = new FakeSynth([v("Microsoft Antonio Online (Natural)")]), storage = new MemoryStorage(), extra = {} } = {}) {
  const dom = new FakeDocument();
  const clock = createClock();
  const beeps = [];
  const focuses = [];
  const fetch = createFakeFetch(async (call) => {
    if (route) { const custom = await route(call); if (custom) return custom; }
    if (call.url === "/api/config") return { body: config };
    if (call.url === "/api/message") return { status: 202, body: { accepted: true } };
    return { body: { ok: true } };
  });
  const panel = createPanel({
    document: dom, fetch, EventSource: FakeEventSource, SpeechRecognitionCtor: speech ? FakeSpeechRecognition : undefined,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, setTicker: clock.setTicker, clearTicker: clock.clearTicker, now: clock.now,
    playBeep: () => beeps.push(1), focusWindow: () => focuses.push(1),
    speechSynthesis: synth, SpeechSynthesisUtterance: Utterance, storage, ...extra,
  });
  await panel.start();
  await flush();
  const el = dom.elements;
  const rec = () => FakeSpeechRecognition.last;
  // Em uma sessão real de reconhecimento a lista de resultados só CRESCE: a frase nova é o próximo índice.
  let session = [];
  const say = (...list) => { session = list.map((t) => (typeof t === "string" ? { text: t } : t)); rec().fire(session); };
  const next = (text) => { session = [...session.map((r) => ({ ...r, isFinal: true })), { text, isFinal: false }]; rec().fire(session); };
  const posts = (url) => fetch.calls.filter((c) => c.method === "POST" && c.url === url);
  return { panel, dom, el, clock, fetch, beeps, focuses, rec, say, next, posts, synth, storage, source: FakeEventSource.last };
}

test("todos os ids que o painel usa existem no index.html (o DOM falso vem do HTML real)", async () => {
  const { el } = await mount();
  for (const id of ["dot", "status", "notice", "messages", "heard", "live", "live-text", "countdown", "btn-send", "btn-cancel", "confirm", "confirm-title", "confirm-text", "btn-yes", "btn-always", "btn-no", "form", "text", "btn-stop", "btn-mute"]) {
    assert.ok(el[id], `falta #${id} no index.html`);
  }
  assert.equal(el.live.hidden, true);
  assert.equal(el.confirm.hidden, true);
  assert.equal(el["btn-stop"].hidden, true);
});

test("início: carrega a configuração, liga o microfone e mostra o que dizer", async () => {
  const { el, fetch, rec, source } = await mount();
  assert.equal(fetch.calls[0].url, "/api/config");
  assert.equal(rec().started, true);
  assert.equal(rec().lang, "pt-BR");
  assert.equal(el.status.textContent, 'Diga "jarvis"…');
  assert.equal(el.dot.className, "dot idle");
  assert.equal(source.url, "/api/events");
});

test("FLUXO PRINCIPAL: fala a palavra-chave, o mini chat transcreve e envia após 10 s de silêncio", async () => {
  const { el, clock, say, posts, beeps, focuses, dom } = await mount();
  say("Jarvis abra a pasta");
  assert.equal(el.live.hidden, false);
  assert.equal(el["live-text"].textContent, "abra a pasta");
  assert.equal(el.dot.className, "dot capturing");
  assert.equal(el.status.textContent, "Ouvindo…");
  assert.equal(el.countdown.textContent, "Enviando em 10s");
  assert.equal(beeps.length, 1);
  assert.equal(focuses.length, 1);

  clock.advance(4_000);
  assert.equal(el.countdown.textContent, "Enviando em 6s"); // contagem regressiva ao vivo
  say("Jarvis abra a pasta de downloads");
  assert.equal(el["live-text"].textContent, "abra a pasta de downloads");
  assert.equal(el.countdown.textContent, "Enviando em 10s");

  clock.advance(9_900);
  assert.equal(posts("/api/message").length, 0);
  clock.advance(200);
  await flush();
  assert.deepEqual(posts("/api/message")[0].body, { text: "abra a pasta de downloads" });
  assert.equal(el.live.hidden, true);
  assert.equal(el.countdown.textContent, "");
  assert.deepEqual(dom.messages("user"), ["abra a pasta de downloads"]);
  assert.equal(el.status.textContent, "Pensando…");
  assert.equal(el["btn-stop"].hidden, false);
  assert.equal(clock.pending, 0); // nenhum temporizador ficou pendurado depois do envio
});

test("'ouvi': em idle mostra o texto bruto ouvido (mesmo sem palavra-chave) e some sozinho", async () => {
  const { el, say, clock } = await mount();
  say("Jarbas ligue as luzes"); // transcrição errada: a palavra-chave não casa…
  assert.equal(el.live.hidden, true); // …mas dá para VER o que o navegador entendeu
  assert.equal(el.heard.hidden, false);
  assert.equal(el.heard.textContent, 'ouvi: "Jarbas ligue as luzes"');
  clock.advance(4_000);
  assert.equal(el.heard.hidden, true); // apaga sozinho
});

test("'ouvi': fala nova renova a linha; ela some 4 s depois da ÚLTIMA", async () => {
  const { el, say, clock } = await mount();
  say("bom dia");
  clock.advance(3_000);
  say("tudo bem aí");
  assert.equal(el.heard.textContent, 'ouvi: "tudo bem aí"');
  clock.advance(3_500); // 6,5 s desde a primeira, 3,5 s desde a segunda
  assert.equal(el.heard.hidden, false);
  clock.advance(500);
  assert.equal(el.heard.hidden, true);
});

test("resposta do agente aparece no chat e o painel volta a escutar", async () => {
  const { el, dom, clock, say, rec, source, synth } = await mount();
  say("Jarvis qual a hora");
  clock.advance(10_000);
  await flush();
  source.emit("log", { type: "log", line: "[tool] read_file {\"path\":\"a\"}" });
  source.emit("answer", { type: "answer", text: "São 15h." });
  assert.deepEqual(dom.messages("agent"), ["São 15h."]);
  assert.deepEqual(dom.messages("tool"), ['[tool] read_file {"path":"a"}']);
  assert.equal(el["btn-stop"].hidden, true);
  assert.equal(el.status.textContent, "Falando…"); // chamou por voz: a resposta é falada
  await flush();
  synth.end();
  await flush();
  assert.equal(el.status.textContent, 'Diga "jarvis"…');
  rec().finish(); // a escuta foi reiniciada de propósito ao terminar de falar
  clock.advance(400);
  say("Batman e agora"); // depois de responder, volta a reagir a novas falas
  assert.equal(el.live.hidden, false);
});

test("erro do agente aparece no chat", async () => {
  const { dom, say, clock, source, el } = await mount();
  say("Jarvis faça algo");
  clock.advance(10_000);
  await flush();
  source.emit("error", { type: "error", message: "Chave de API inválida (401)" });
  assert.deepEqual(dom.messages("error"), ["Chave de API inválida (401)"]);
  assert.equal(el["btn-stop"].hidden, true);
});

test("cancelar (botão e Esc) descarta a captura sem enviar", async () => {
  for (const cancel of [(t) => t.el["btn-cancel"].click(), (t) => t.dom.press("Escape")]) {
    FakeSpeechRecognition.instances.length = 0;
    const t = await mount();
    t.say("Jarvis apague tudo");
    cancel(t);
    assert.equal(t.el.live.hidden, true);
    assert.equal(t.posts("/api/message").length, 0);
    assert.match(t.dom.messages("system")[0], /Captura cancelada/);
    t.clock.advance(60_000);
    await flush();
    assert.equal(t.posts("/api/message").length, 0);
  }
});

test("'Enviar agora' envia sem esperar os 10 s", async () => {
  const { el, say, posts } = await mount();
  say("Jarvis abra a agenda");
  el["btn-send"].click();
  await flush();
  assert.deepEqual(posts("/api/message")[0].body, { text: "abra a agenda" });
});

test("só a palavra-chave e silêncio: cancela sozinho, sem enviar nada", async () => {
  const { say, clock, posts, dom, el } = await mount();
  say("Jarvis");
  clock.advance(10_000);
  await flush();
  assert.equal(posts("/api/message").length, 0);
  assert.match(dom.messages("system")[0], /nada foi dito/);
  assert.equal(el.live.hidden, true);
});

test("digitar no campo envia na hora; durante a execução avisa para aguardar", async () => {
  const { el, dom, posts, source } = await mount();
  el.text.value = "  liste os arquivos  ";
  el.form.dispatch("submit", { preventDefault() {} });
  await flush();
  assert.deepEqual(posts("/api/message")[0].body, { text: "liste os arquivos" });
  assert.equal(el.text.value, "");

  el.text.value = "outra coisa";
  el.form.dispatch("submit", { preventDefault() {} });
  await flush();
  assert.equal(posts("/api/message").length, 1);
  assert.match(dom.messages("system")[0], /Aguarde/);

  source.emit("answer", { type: "answer", text: "ok" });
  el.text.value = "   ";
  el.form.dispatch("submit", { preventDefault() {} });
  await flush();
  assert.equal(posts("/api/message").length, 1); // vazio não envia
});

test("digitar durante uma captura por voz cancela a captura", async () => {
  const { el, say, posts, clock } = await mount();
  say("Jarvis abra");
  el.text.value = "abra o terminal";
  el.form.dispatch("submit", { preventDefault() {} });
  await flush();
  assert.deepEqual(posts("/api/message").map((c) => c.body.text), ["abra o terminal"]);
  clock.advance(60_000);
  await flush();
  assert.equal(posts("/api/message").length, 1);
});

test("falha ao enviar (agente encerrado, 409, 413): mostra o motivo e volta ao normal", async () => {
  for (const [response, pattern] of [
    [{ status: 409, body: { error: "O agente ainda está trabalhando na tarefa anterior." } }, /ainda está trabalhando/],
    [{ status: 413, body: { error: "Mensagem grande demais" } }, /grande demais/],
    [{ status: 500, body: null }, /Erro 500/],
  ]) {
    FakeSpeechRecognition.instances.length = 0;
    const t = await mount({ route: (call) => (call.url === "/api/message" ? response : undefined) });
    t.el.text.value = "faça algo";
    t.el.form.dispatch("submit", { preventDefault() {} });
    await flush();
    assert.match(t.dom.messages("error")[0], pattern);
    assert.equal(t.el["btn-stop"].hidden, true);
    assert.equal(t.el.status.textContent, 'Diga "jarvis"…');
  }
  const dead = await mount({ route: (call) => { if (call.url === "/api/message") throw new Error("ECONNREFUSED"); } });
  dead.el.text.value = "x";
  dead.el.form.dispatch("submit", { preventDefault() {} });
  await flush();
  assert.match(dead.dom.messages("error")[0], /encerrado/);
});

test("CONFIRMAÇÃO: pedido do agente aparece com a descrição e só vale com clique", async () => {
  const { el, source, posts, beeps, focuses } = await mount();
  source.emit("confirm_request", { type: "confirm_request", id: "c-1", tool: "write_file", description: "Criar o arquivo 'a.txt'\n--- início ---\noi", allowSessionApproval: false });
  assert.equal(el.confirm.hidden, false);
  assert.equal(el["confirm-title"].textContent, "O agente quer usar: write_file");
  assert.equal(el["confirm-text"].textContent, "Criar o arquivo 'a.txt'\n--- início ---\noi");
  assert.equal(el["btn-always"].hidden, true);
  assert.equal(beeps.length, 1);
  assert.equal(focuses.length, 1);

  el["btn-yes"].click();
  await flush();
  assert.deepEqual(posts("/api/confirm")[0].body, { id: "c-1", decision: "yes" });
  assert.equal(el.confirm.hidden, true);
  el["btn-yes"].click(); // clique repetido depois de responder: nada acontece
  await flush();
  assert.equal(posts("/api/confirm").length, 1);
});

test("confirmação: 'não', 'sempre nesta sessão' e expiração", async () => {
  const a = await mount();
  a.source.emit("confirm_request", { id: "c-2", tool: "screenshot", description: "d", allowSessionApproval: true });
  assert.equal(a.el["btn-always"].hidden, false);
  a.el["btn-always"].click();
  await flush();
  assert.equal(a.posts("/api/confirm")[0].body.decision, "always");

  const b = await mount();
  b.source.emit("confirm_request", { id: "c-3", tool: "execute_command", description: "d", allowSessionApproval: false });
  b.el["btn-no"].click();
  await flush();
  assert.equal(b.posts("/api/confirm")[0].body.decision, "no");

  const c = await mount();
  c.source.emit("confirm_request", { id: "c-4", tool: "x", description: "d" });
  c.source.emit("confirm_expired", { id: "outro-id" });
  assert.equal(c.el.confirm.hidden, false); // expiração de outro pedido não fecha este
  c.source.emit("confirm_expired", { id: "c-4" });
  assert.equal(c.el.confirm.hidden, true);
  assert.match(c.dom.messages("system").at(-1), /expirou/);
});

test("confirmação NUNCA é aceita por voz: falar 'sim' não responde ao pedido", async () => {
  const { el, say, source, posts } = await mount();
  source.emit("confirm_request", { id: "c-5", tool: "execute_command", description: "rm x", allowSessionApproval: false });
  say("Jarvis sim", { text: "Jarvis confirma", isFinal: true });
  await flush();
  assert.equal(posts("/api/confirm").length, 0);
  assert.equal(el.confirm.hidden, false);
});

test("botão Parar chama /api/stop", async () => {
  const { el, posts, dom } = await mount();
  el["btn-stop"].click();
  await flush();
  assert.equal(posts("/api/stop").length, 1);
  assert.match(dom.messages("system")[0], /Parando/);
});

test("mudo: desliga o reconhecimento e ignora a fala; religar volta a escutar", async () => {
  const { el, rec, say, clock } = await mount();
  const first = rec();
  el["btn-mute"].click();
  assert.equal(first.aborted, true);
  assert.equal(el.status.textContent, "Microfone desligado");
  assert.equal(el["btn-mute"].textContent, "🔇");
  first.finish();
  clock.advance(5_000);
  assert.equal(FakeSpeechRecognition.instances.length, 1);

  el["btn-mute"].click();
  assert.equal(FakeSpeechRecognition.instances.length, 2);
  assert.equal(el.status.textContent, 'Diga "jarvis"…');
  say("Jarvis oi");
  assert.equal(el.live.hidden, false);
});

test("mudo durante uma captura cancela a captura", async () => {
  const { el, say, posts, clock } = await mount();
  say("Jarvis abra");
  el["btn-mute"].click();
  assert.equal(el.live.hidden, true);
  clock.advance(60_000);
  await flush();
  assert.equal(posts("/api/message").length, 0);
});

test("SEGURANÇA: texto do modelo, da fala e da confirmação entra como texto puro (nada de HTML)", async () => {
  const { dom, el, source, say, clock } = await mount();
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  source.emit("answer", { text: evil });
  source.emit("error", { message: evil });
  source.emit("log", { line: evil });
  source.emit("confirm_request", { id: "x", tool: evil, description: evil });
  say(`Jarvis ${evil}`);
  clock.advance(10_000);
  await flush();
  const messages = el.messages.children;
  assert.ok(messages.length >= 4);
  const ALLOWED = new Set(["div", "span", "strong", "code", "pre", "ul", "ol", "li", "#text"]);
  const tags = (node) => [node.tag, ...(node.children ?? []).flatMap(tags)];
  for (const node of messages) {
    for (const tag of tags(node)) assert.ok(ALLOWED.has(tag), `tag inesperada: ${tag}`); // nunca <img>, <script>...
    if (node.className !== "msg agent") assert.equal(node.children.length, 0, "fora as respostas do agente, só texto puro");
  }
  assert.equal(dom.messages("agent")[0], evil);
  assert.equal(el["confirm-text"].textContent, evil);
  assert.equal(el["confirm-title"].textContent, `O agente quer usar: ${evil}`);
});

test("o histórico do chat tem limite (200 mensagens)", async () => {
  const { el, source } = await mount();
  for (let i = 0; i < 250; i++) source.emit("log", { line: `linha ${i}` });
  assert.equal(el.messages.children.length, 200);
  assert.equal(el.messages.children[0].textContent, "linha 50");
  assert.equal(el.messages.scrollTop, el.messages.scrollHeight);
});

test("logs longos são cortados; eventos malformados do servidor são ignorados", async () => {
  const { el, source } = await mount();
  source.emit("log", { line: "x".repeat(1000) });
  assert.equal(el.messages.children[0].textContent.length, 300);
  source.emitRaw("answer", "isto não é json");
  source.emitRaw("hello", "{{{");
  assert.equal(el.messages.children.length, 1);
});

test("conexão com o agente: aviso ao cair e some ao reconectar; 'hello' sincroniza o estado", async () => {
  const { el, source } = await mount();
  source.onerror();
  assert.equal(el.notice.hidden, false);
  assert.match(el.notice.textContent, /Conexão com o agente perdida/);
  source.emit("hello", { type: "hello", busy: false });
  assert.equal(el.notice.hidden, true);

  source.emit("hello", { type: "hello", busy: true }); // página recarregada com o agente trabalhando
  assert.equal(el.status.textContent, "Pensando…");
  assert.equal(el["btn-stop"].hidden, false);
  source.emit("hello", { type: "hello", busy: false }); // terminou enquanto estava desconectado
  assert.equal(el["btn-stop"].hidden, true);
  assert.equal(el.status.textContent, 'Diga "jarvis"…');
});

test("navegador sem reconhecimento de voz: avisa e o campo de texto continua funcionando", async () => {
  const { el, posts } = await mount({ speech: false });
  assert.match(el.notice.textContent, /Chrome ou o Edge/);
  assert.equal(el.status.textContent, "Voz indisponível: digite abaixo");
  el.text.value = "oi";
  el.form.dispatch("submit", { preventDefault() {} });
  await flush();
  assert.equal(posts("/api/message").length, 1);
});

test("microfone negado pelo navegador: mostra a orientação e o estado de erro", async () => {
  const { el, rec } = await mount();
  rec().fail("not-allowed");
  assert.match(el.notice.textContent, /Permissão do microfone negada/);
  assert.equal(el.dot.className, "dot error");
  assert.equal(el.status.textContent, "Microfone indisponível");
});

test("configuração inacessível: orienta reabrir pelo endereço do terminal", async () => {
  const { el } = await mount({ route: (call) => (call.url === "/api/config" ? { status: 401, body: {} } : undefined) });
  assert.match(el.notice.textContent, /endereço completo mostrado no terminal/);
  assert.equal(FakeSpeechRecognition.instances.length, 0);
});

test("outras palavras-chave e um segundo comando na mesma sessão", async () => {
  const { say, clock, posts, source } = await mount();
  say("Sexta-feira ligue o modo foco");
  clock.advance(10_000);
  await flush();
  source.emit("answer", { text: "feito" });
  say({ text: "Sexta-feira ligue o modo foco", isFinal: true }, "Batman abra o mapa");
  clock.advance(10_000);
  await flush();
  assert.deepEqual(posts("/api/message").map((c) => c.body.text), ["ligue o modo foco", "abra o mapa"]);
});

// =============== VOZ DO AGENTE (fala em pt-BR) ===============
const askByVoice = async (t, text = "Jarvis qual a hora") => {
  t.say(text);
  t.clock.advance(10_000);
  await flush();
};

test("chamou POR VOZ: a resposta é falada automaticamente, em pt-BR, com a melhor voz", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "São três da tarde." });
  await flush();
  assert.equal(t.synth.spoken.length, 1);
  const u = t.synth.spoken[0];
  assert.equal(u.text, "São três da tarde.");
  assert.equal(u.lang, "pt-BR");
  assert.match(u.voice.name, /Antonio/);
  assert.equal(t.el.dot.className, "dot speaking");
  assert.equal(t.dom.body.dataset.state, "speaking");
  assert.equal(t.el["btn-hush"].hidden, false);
  t.synth.end();
  await flush();
  assert.equal(t.el["btn-hush"].hidden, true);
  assert.equal(t.dom.body.dataset.state, "idle");
});

test("DIGITOU: por padrão a resposta NÃO é falada; com 'Digitado: com voz' é", async () => {
  const t = await mount();
  t.el.text.value = "que horas são";
  t.el.form.dispatch("submit", { preventDefault() {} });
  await flush();
  t.source.emit("answer", { text: "Três da tarde." });
  await flush();
  assert.equal(t.synth.spoken.length, 0);

  t.el["btn-typed"].click();
  assert.equal(t.el["btn-typed"].textContent, "Digitado: com voz");
  assert.equal(t.storage.getItem("jarvis.typed"), "on");
  t.el.text.value = "e agora";
  t.el.form.dispatch("submit", { preventDefault() {} });
  await flush();
  t.source.emit("answer", { text: "Quatro da tarde." });
  await flush();
  assert.equal(t.synth.spoken.at(-1).text, "Quatro da tarde.");
});

test("botão de voz desliga a fala (e lembra a escolha); desligar durante a fala silencia na hora", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Primeira resposta longa." });
  await flush();
  t.el["btn-voice"].click();
  assert.equal(t.el["btn-voice"].textContent, "🔈");
  assert.equal(t.storage.getItem("jarvis.voice"), "off");
  assert.ok(t.synth.canceled >= 1);
  assert.equal(t.el.dot.className, "dot idle");

  await askByVoice(t, "Jarvis outra pergunta");
  t.source.emit("answer", { text: "Não deve ser falada." });
  await flush();
  assert.ok(!t.synth.spoken.some((u) => u.text === "Não deve ser falada."));
  assert.equal(t.dom.messages("agent").at(-1), "Não deve ser falada."); // continua aparecendo no chat
});

test("a preferência de voz desligada persiste entre sessões; VOICE_REPLIES=off também desliga", async () => {
  const off = await mount({ storage: new MemoryStorage({ "jarvis.voice": "off" }) });
  await askByVoice(off);
  off.source.emit("answer", { text: "sem voz" });
  await flush();
  assert.equal(off.synth.spoken.length, 0);
  assert.equal(off.el["btn-voice"].textContent, "🔈");

  const cfg = await mount({ config: { ...CONFIG, tts: { replies: "off", bargeIn: "any" } } });
  await askByVoice(cfg);
  cfg.source.emit("answer", { text: "sem voz também" });
  await flush();
  assert.equal(cfg.synth.spoken.length, 0);
});

test("botão 'Calar' interrompe a fala na hora", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Uma resposta." });
  await flush();
  assert.equal(t.el["btn-hush"].hidden, false);
  t.el["btn-hush"].click();
  assert.equal(t.el.dot.className, "dot idle");
  assert.equal(t.el["btn-hush"].hidden, true);
});

test("INTERROMPER FALANDO: sua voz (não é eco) para o agente", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Encontrei três arquivos na pasta de downloads." });
  await flush();
  const canceledBefore = t.synth.canceled;
  t.next("espera um momento por favor");
  assert.ok(t.synth.canceled > canceledBefore);
  assert.equal(t.el.dot.className, "dot idle");
});

test("ECO: o que o agente fala e o microfone ouve NÃO o interrompe nem aciona a palavra-chave", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Diga Jarvis quando precisar. Encontrei três arquivos na pasta." });
  await flush();
  const canceledBefore = t.synth.canceled;
  // o microfone capta a própria fala do agente, inclusive a palavra "Jarvis"
  t.next("Diga Jarvis quando precisar");
  t.next("encontrei três arquivos na pasta");
  assert.equal(t.synth.canceled, canceledBefore); // não interrompeu
  assert.equal(t.el.live.hidden, true); // não abriu captura
  assert.equal(t.el.dot.className, "dot speaking");
});

test("'ouvi (ignorado)': o eco do agente aparece marcado na linha, sem parecer a sua fala", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Diga Jarvis quando precisar." });
  await flush();
  t.next("Diga Jarvis quando precisar"); // o microfone captou a própria fala do agente
  assert.equal(t.el.heard.hidden, false);
  assert.match(t.el.heard.textContent, /ouvi \(ignorado\): "Diga Jarvis quando precisar"/);
  assert.equal(t.el.live.hidden, true);
});

test("eco: depois que o agente termina de falar, o eco residual também é ignorado e a escuta reinicia", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Diga Jarvis quando precisar." });
  await flush();
  const first = t.rec();
  t.synth.end();
  await flush();
  assert.equal(first.aborted, true); // terminou sozinho: descarta a sessão com o eco
  first.finish();
  t.clock.advance(400);
  assert.equal(FakeSpeechRecognition.instances.length, 2); // sessão nova, limpa
  t.say("Diga Jarvis quando precisar"); // eco tardio, dentro da janela de proteção
  assert.equal(t.el.live.hidden, true);
  t.clock.advance(2_000);
  t.next("Jarvis abra a pasta"); // agora é você
  assert.equal(t.el.live.hidden, false);
});

test("interromper pela sua voz NÃO reinicia a escuta (não perde suas palavras)", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Encontrei três arquivos." });
  await flush();
  const rec = t.rec();
  t.next("Jarvis para de falar");
  assert.equal(rec.aborted, false);
  assert.equal(t.el.live.hidden, false); // e ainda abriu a captura (a palavra-chave estava no início)
});

test("falar a palavra-chave enquanto o agente fala: ele cala e a captura começa", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Vou listar os arquivos da pasta de downloads agora." });
  await flush();
  t.next("Batman abra a agenda");
  assert.equal(t.el.live.hidden, false);
  assert.equal(t.el["live-text"].textContent, "abra a agenda");
  assert.ok(t.synth.canceled >= 1);
});

test("modos de interrupção: 'wake' só com a palavra-chave; 'off' nunca", async () => {
  const wake = await mount({ config: { ...CONFIG, tts: { bargeIn: "wake" } } });
  await askByVoice(wake);
  wake.source.emit("answer", { text: "Encontrei três arquivos na pasta." });
  await flush();
  const before = wake.synth.canceled;
  wake.next("uma conversa qualquer ao fundo"); // sem palavra-chave: não interrompe
  assert.equal(wake.synth.canceled, before);
  assert.equal(wake.el.dot.className, "dot speaking");
  wake.next("Jarvis para");
  assert.ok(wake.synth.canceled > before);

  FakeSpeechRecognition.instances.length = 0;
  const off = await mount({ config: { ...CONFIG, tts: { bargeIn: "off" } } });
  await askByVoice(off);
  off.source.emit("answer", { text: "Encontrei três arquivos na pasta." });
  await flush();
  const b = off.synth.canceled;
  off.next("Jarvis para de falar agora");
  assert.equal(off.synth.canceled, b);
  assert.equal(off.el.live.hidden, true);
  off.el["btn-hush"].click(); // o botão continua funcionando
  assert.equal(off.el.dot.className, "dot idle");
});

test("mandar uma nova mensagem (digitada ou por voz) cala a fala anterior", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Uma resposta longa que está sendo lida." });
  await flush();
  const before = t.synth.canceled;
  t.el.text.value = "próximo comando";
  t.el.form.dispatch("submit", { preventDefault() {} });
  await flush();
  assert.ok(t.synth.canceled > before);
});

test("pedido de autorização é anunciado em voz, mas SÓ vale com o clique", async () => {
  const t = await mount();
  await askByVoice(t, "Jarvis apague o arquivo");
  t.source.emit("confirm_request", { id: "c-9", tool: "write_file", description: "d", allowSessionApproval: false });
  await flush();
  assert.match(t.synth.spoken.at(-1).text, /autorização.*painel/i);
  t.next("sim autorizo"); // dizer "sim" não autoriza nada
  await flush();
  assert.equal(t.posts("/api/confirm").length, 0);
  assert.equal(t.el.confirm.hidden, false);
});

test("erro do agente por voz: fala um aviso curto (não lê a mensagem técnica)", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("error", { message: "Requisição recusada por NVIDIA (400): tools are not supported" });
  await flush();
  assert.match(t.synth.spoken.at(-1).text, /Encontrei um problema/);
  assert.ok(!/NVIDIA|400/.test(t.synth.spoken.at(-1).text));
});

test("respostas longas com markdown e código: a voz lê só o essencial", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "## Resultado\n\nRode:\n```bash\nrm -rf x\n```\nVeja https://exemplo.com/a agora." });
  await flush();
  const spokenText = t.synth.spoken.map((u) => u.text).join(" ");
  assert.ok(!/rm -rf|```|##|https/.test(spokenText));
  assert.match(spokenText, /código omitido/);
  assert.equal(t.dom.messages("agent")[0].includes("rm -rf"), true); // no chat aparece completo
});

test("som bloqueado pelo navegador: avisa e o primeiro clique libera e retoma a fala", async () => {
  const t = await mount();
  await askByVoice(t);
  t.source.emit("answer", { text: "Olá, senhor." });
  await flush();
  t.synth.fail("not-allowed");
  await flush();
  assert.match(t.el.notice.textContent, /Clique uma vez/);
  assert.equal(t.el.dot.className, "dot idle");
  const spokenBefore = t.synth.spoken.length;
  t.dom.pointer(); // primeiro clique do usuário
  await flush();
  assert.ok(t.synth.spoken.length > spokenBefore);
  assert.equal(t.el.dot.className, "dot speaking");
});

test("navegador sem síntese de voz: sem botões de voz e o resto continua funcionando", async () => {
  const t = await mount({ synth: undefined, extra: { speechSynthesis: undefined, SpeechSynthesisUtterance: undefined } });
  assert.equal(t.el["btn-voice"].hidden, true);
  assert.equal(t.el["btn-typed"].hidden, true);
  await askByVoice(t);
  t.source.emit("answer", { text: "resposta" });
  await flush();
  assert.deepEqual(t.dom.messages("agent"), ["resposta"]);
});

test("servidor de voz (Kokoro): usa /api/tts; se falhar, cai na voz do navegador e avisa", async () => {
  class Audio {
    static all = [];
    constructor(url) { this.url = url; Audio.all.push(this); }
    play() { return Promise.resolve(); }
    pause() {}
  }
  const t = await mount({
    config: { ...CONFIG, tts: { engine: "server", bargeIn: "any", lang: "pt-BR" } },
    route: (call) => (call.url === "/api/tts" ? { status: 502, body: { error: "Kokoro fora do ar" } } : undefined),
    extra: { AudioCtor: Audio, URLApi: { createObjectURL: () => "blob:x", revokeObjectURL() {} } },
  });
  await askByVoice(t);
  t.source.emit("answer", { text: "Olá, senhor." });
  await flush();
  assert.equal(t.posts("/api/tts").length, 1);
  assert.match(t.el.notice.textContent, /Kokoro fora do ar.*voz do navegador/);
  assert.equal(t.synth.spoken.at(-1).text, "Olá, senhor."); // caiu na voz do navegador
});

test("nova conversa: reinicia a memória do agente e limpa o chat", async () => {
  const t = await mount();
  t.source.emit("log", { line: "[tool] x" });
  t.source.emit("answer", { text: "algo" });
  t.el["btn-new"].click();
  await flush();
  assert.equal(t.posts("/api/reset").length, 1);
  assert.deepEqual(t.dom.messages(), ["Nova conversa iniciada."]);

  const busy = await mount({ route: (call) => (call.url === "/api/reset" ? { status: 409, body: { error: "O agente está trabalhando" } } : undefined) });
  busy.source.emit("log", { line: "[tool] y" });
  busy.el["btn-new"].click();
  await flush();
  assert.match(busy.dom.messages("error")[0], /trabalhando/);
  assert.equal(busy.dom.messages("tool").length, 1); // não limpou
});

test("visual: título, modelo, abertura, anel de contagem e estado no <body> (o CSS anima a partir dele)", async () => {
  const t = await mount({ config: { ...CONFIG, title: "J.A.R.V.I.S.", model: "NVIDIA · meta/llama-3.1-70b-instruct" } });
  assert.equal(t.el.title.textContent, "J.A.R.V.I.S.");
  assert.equal(t.el.model.textContent, "NVIDIA · meta/llama-3.1-70b-instruct");
  assert.equal(t.el.boot.hidden, true); // a tela de abertura some quando tudo está pronto
  assert.equal(t.dom.body.dataset.state, "idle");

  t.say("Jarvis abra");
  assert.equal(t.dom.body.dataset.state, "capturing");
  assert.equal(t.el.ring.style.props["--p"], "1");
  t.clock.advance(5_000);
  assert.equal(Number(t.el.ring.style.props["--p"]), 0.5);
  t.clock.advance(5_000);
  await flush();
  assert.equal(t.dom.body.dataset.state, "processing");
  t.source.emit("answer", { text: "ok" });
  await flush();
  t.synth.end();
  await flush();
  t.el["btn-mute"].click();
  assert.equal(t.dom.body.dataset.state, "muted");
});

test("a tela de abertura também some se a configuração falhar (para o aviso aparecer)", async () => {
  const t = await mount({ route: (call) => (call.url === "/api/config" ? { status: 401, body: {} } : undefined) });
  assert.equal(t.el.boot.hidden, true);
  assert.equal(t.el.notice.hidden, false);
});
