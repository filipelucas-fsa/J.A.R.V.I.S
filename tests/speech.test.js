import { test } from "node:test";
import assert from "node:assert/strict";
import { isEcho, pickVoice, prepareSpeech } from "../src/voice/web/speech.js";

const spoken = (text, options) => prepareSpeech(text, options).chunks.join(" ");

test("texto simples vira um trecho; vazio não gera nada", () => {
  assert.deepEqual(prepareSpeech("Encontrei três arquivos."), { chunks: ["Encontrei três arquivos."], truncated: false });
  for (const empty of ["", "   ", null, undefined, "\n\n", "```js\n```".replace("js\n", "")]) {
    const r = prepareSpeech(empty);
    assert.ok(r.chunks.length === 0 || !/```/.test(r.chunks.join(" ")), JSON.stringify(empty));
  }
  assert.deepEqual(prepareSpeech(""), { chunks: [], truncated: false });
});

test("markdown: títulos, listas, negrito, links, imagens, citações e tabelas são limpos", () => {
  const md = "# Resultado\n\n- **Item um** com [um link](https://x.com/a)\n- item dois\n1. terceiro\n> citação\n\n![figura](img.png)";
  const out = spoken(md);
  assert.equal(out, "Resultado. Item um com um link, item dois, terceiro, citação. figura");
  assert.ok(!/[*#>\[\]()]/.test(out));
  assert.doesNotMatch(spoken("| a | b |\n|---|---|\n| 1 | 2 |"), /[|-]{2,}/);
});

test("código não é lido: vira um aviso curto (uma vez por sequência)", () => {
  const out = spoken("Use este comando:\n```bash\nrm -rf x\nls\n```\nDepois rode:\n```js\nfoo()\n```\nPronto.");
  assert.match(out, /trecho de código omitido/);
  assert.ok(!/rm -rf|foo\(\)|bash|js\b/.test(out));
  // o texto ANTES, ENTRE e DEPOIS dos blocos de código continua sendo falado
  assert.match(out, /Use este comando/);
  assert.match(out, /Depois rode/);
  assert.match(out, /Pronto\.$/);
  assert.equal(spoken("```a```\n```b```"), "(trecho de código omitido)");
  assert.match(spoken("texto ```nunca fecha\ncódigo"), /trecho de código omitido/);
  assert.equal(spoken("rode `npm test` agora"), "rode npm test agora");
});

test("URLs, emojis e símbolos", () => {
  assert.equal(spoken("Veja https://exemplo.com/a?b=1&c=2 agora"), "Veja link agora");
  assert.equal(spoken("Feito 🚀✅ com sucesso 😀"), "Feito com sucesso");
  assert.equal(spoken("Uso de CPU: 45% & memória"), "Uso de CPU: 45 por cento e memória");
  assert.ok(!/[→]/.test(spoken("a → b")));
});

test("respostas longas: corta em fim de frase e avisa que o resto está na tela", () => {
  const long = Array.from({ length: 80 }, (_, i) => `Esta é a frase número ${i} da resposta.`).join(" ");
  const r = prepareSpeech(long, { maxChars: 500 });
  assert.equal(r.truncated, true);
  const joined = r.chunks.join(" ");
  assert.ok(joined.length <= 560);
  assert.match(joined, /O restante está na tela\.$/);
  assert.match(joined, /da resposta\. O restante/);
  assert.equal(prepareSpeech("curta.", { maxChars: 500 }).truncated, false);
});

test("trechos curtos: nenhum passa do limite, mesmo com frases enormes sem pontuação", () => {
  const r = prepareSpeech(Array.from({ length: 200 }, (_, i) => `palavra${i}`).join(" "), { maxChars: 5000, chunkChars: 100 });
  assert.ok(r.chunks.length > 5);
  for (const chunk of r.chunks) assert.ok(chunk.length <= 101, `${chunk.length}: ${chunk}`);
  const withCommas = prepareSpeech("aaa, ".repeat(100) + "fim.", { maxChars: 5000, chunkChars: 80 });
  for (const chunk of withCommas.chunks) assert.ok(chunk.length <= 81);
  const gigantic = prepareSpeech("x".repeat(1000), { maxChars: 5000, chunkChars: 100 });
  for (const chunk of gigantic.chunks) assert.ok(chunk.length <= 101);
  assert.equal(gigantic.chunks.join("").length >= 900, true);
});

test("nenhum conteúdo se perde ao dividir em trechos (frases curtas)", () => {
  const text = "Primeira frase. Segunda frase! Terceira frase? Quarta frase.";
  const r = prepareSpeech(text, { chunkChars: 30 });
  assert.equal(r.chunks.join(" "), text);
  assert.ok(r.chunks.length >= 2);
});

// ---------- eco ----------
test("eco: o que o agente está falando não conta como você falando", () => {
  const said = "Encontrei três arquivos na pasta de downloads e um deles é um relatório";
  assert.equal(isEcho("encontrei três arquivos na pasta", said), true);
  assert.equal(isEcho("Encontrei 3 arquivos na pasta de downloads", said), true); // reconhecedor escreveu "3": ainda é eco
  assert.equal(isEcho("arquivos na pasta de download", said), true); // singular/plural
  assert.equal(isEcho("um deles é um relatório", said), true);
});

test("fala do usuário NÃO é eco: interrompe", () => {
  const said = "Encontrei três arquivos na pasta de downloads";
  assert.equal(isEcho("Jarvis para de falar", said), false);
  assert.equal(isEcho("espera um pouco", said), false);
  assert.equal(isEcho("abre o navegador agora", said), false);
  assert.equal(isEcho("não era isso que eu queria", said), false);
});

test("eco: casos-limite", () => {
  assert.equal(isEcho("", "qualquer coisa"), true);
  assert.equal(isEcho("   ...  ", "qualquer coisa"), true);
  assert.equal(isEcho(undefined, "x"), true);
  assert.equal(isEcho("olá", ""), false); // nada sendo falado: é o usuário
  assert.equal(isEcho("olá", null), false);
  assert.equal(isEcho("ÁRVORE  Café", "arvore cafe"), true); // acentos e maiúsculas
  assert.equal(isEcho("uma palavra nova aqui e outra", "uma palavra", { threshold: 0.9 }), true); // limiar configurável
});

// ---------- voz ----------
const v = (name, lang, extra = {}) => ({ name, lang, localService: true, ...extra });

test("prefere voz neural pt-BR masculina; depois qualquer neural; depois qualquer pt-BR", () => {
  const voices = [
    v("Microsoft Maria - Portuguese (Brazil)", "pt-BR"),
    v("Google português do Brasil", "pt-BR", { localService: false }),
    v("Microsoft Francisca Online (Natural) - Portuguese (Brazil)", "pt-BR", { localService: false }),
    v("Microsoft Antonio Online (Natural) - Portuguese (Brazil)", "pt-BR", { localService: false }),
    v("Microsoft David - English (United States)", "en-US"),
  ];
  assert.match(pickVoice(voices).name, /Antonio/);
  assert.match(pickVoice(voices.filter((x) => !/Antonio/.test(x.name))).name, /Francisca/);
  assert.match(pickVoice(voices.slice(0, 2)).name, /Google/);
  assert.match(pickVoice([voices[0]]).name, /Maria/);
});

test("preferências: nome pedido pelo usuário vence; preferMale=false; pt-PT só se não houver pt-BR", () => {
  const voices = [v("Microsoft Antonio Online (Natural)", "pt-BR"), v("Microsoft Francisca Online (Natural)", "pt-BR"), v("Microsoft Duarte Online (Natural)", "pt-PT")];
  assert.match(pickVoice(voices, "pt-BR", { preferName: "francisca" }).name, /Francisca/);
  assert.match(pickVoice(voices, "pt-BR", { preferName: "FRANCÍSCA" }).name, /Francisca/);
  assert.match(pickVoice(voices, "pt-BR", { preferMale: false }).name, /Antonio|Francisca/);
  assert.match(pickVoice([voices[2], v("Voz Comum", "en-US")]).name, /Duarte/);
  assert.equal(pickVoice([v("Voice", "en-US"), v("Voz", "es-ES")]), null);
  assert.match(pickVoice([v("Voz Portuguesa", "pt_BR")]).name, /Portuguesa/); // pt_BR com sublinhado
});

test("entradas incompletas do navegador ('undefined', vazias, nulas) são ignoradas (bug do Edge)", () => {
  const broken = [
    { name: "Microsoft undefined Online (Natural) - undefined", lang: "pt-BR" },
    { name: "Microsoft Antonio Online (Natural)", lang: undefined },
    { name: "", lang: "pt-BR" }, { name: "x", lang: "" }, null, undefined, {}, { name: 5, lang: "pt-BR" },
  ];
  assert.equal(pickVoice(broken), null);
  assert.match(pickVoice([...broken, v("Google português do Brasil", "pt-BR")]).name, /Google/);
  assert.equal(pickVoice(undefined), null);
  assert.equal(pickVoice([]), null);
});
