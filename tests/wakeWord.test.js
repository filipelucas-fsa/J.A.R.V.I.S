import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WAKE_WORDS, findWakeWord, parseWakeWords } from "../src/voice/web/wakeWord.js";

const words = parseWakeWords(DEFAULT_WAKE_WORDS);
const find = (text, options) => findWakeWord(text, words, options);

test("palavras-chave padrão: jarvis, sexta-feira e batman", () => {
  assert.deepEqual(DEFAULT_WAKE_WORDS, ["jarvis", "sexta-feira", "batman"]);
  assert.deepEqual(find("Jarvis, abra a pasta"), { word: "jarvis", rest: "abra a pasta" });
  assert.deepEqual(find("Batman liga o modo foco"), { word: "batman", rest: "liga o modo foco" });
  assert.deepEqual(find("Sexta-feira, me ajuda"), { word: "sexta-feira", rest: "me ajuda" });
});

test("variações de escrita do reconhecedor: espaço, hífen, junto, maiúsculas e acentos", () => {
  for (const text of ["sexta feira me ajuda", "Sexta-Feira me ajuda", "SEXTA FEIRA me ajuda", "sextafeira me ajuda", "sexta  -  feira: me ajuda", "Séxta feira me ajuda"]) {
    assert.deepEqual(find(text), { word: "sexta-feira", rest: "me ajuda" }, text);
  }
  assert.equal(find("bat man abre isso").word, "batman");
  assert.equal(find("JARVIS abre").word, "jarvis");
});

test("o que vem depois é o começo da mensagem; pontuação inicial é removida", () => {
  assert.equal(find("Jarvis").rest, "");
  assert.equal(find("Jarvis...").rest, "");
  assert.equal(find("Jarvis,   abre o navegador").rest, "abre o navegador");
  assert.equal(find("Jarvis: — abre").rest, "abre");
  assert.equal(find("Jarvis abre o site https://x.com/a?b=1").rest, "abre o site https://x.com/a?b=1");
});

test("aceita pequenas palavras antes ('ok jarvis', 'ei jarvis', 'bom dia jarvis') mas não no meio da frase", () => {
  assert.equal(find("ok jarvis abre").word, "jarvis");
  assert.equal(find("ei sexta feira abre").word, "sexta-feira");
  assert.equal(find("bom dia jarvis").word, "jarvis");
  assert.equal(find("eu vi o batman ontem no cinema"), null);
  assert.equal(find("ontem passou um filme do batman"), null);
  assert.equal(find("eu vi o batman ontem", { maxLeadingWords: 5 }).word, "batman");
});

test("sem palavra-chave, ou só parte dela, não aciona", () => {
  for (const text of ["", "   ", "bom dia", "sexta", "feira", "sexta que vem", "jarv", "jarvisson", "batmans", "o barman trouxe a conta", "harvis oi", "..."]) {
    assert.equal(find(text), null, JSON.stringify(text));
  }
  assert.equal(find(null), null);
  assert.equal(find(undefined), null);
});

test("tolerância a uma letra é opcional, só para o mesmo número de palavras (e 'barman' é o risco conhecido)", () => {
  assert.equal(find("jarvys faz isso"), null);
  assert.equal(find("jarvys faz isso", { fuzzy: true }).word, "jarvis");
  assert.equal(find("sesta feira me ajuda", { fuzzy: true }).word, "sexta-feira");
  assert.equal(find("eu vi o batman", { fuzzy: true }), null); // "o"+"batman" não vira janela de 1 palavra
  assert.equal(find("jarv", { fuzzy: true }), null); // curto demais para tolerância
  assert.equal(find("o barman trouxe", { fuzzy: true }).word, "batman"); // falso positivo conhecido: por isso é opcional
});

test("palavras-chave personalizadas e validação", () => {
  const custom = parseWakeWords("Computador, ei assistente , computador");
  assert.deepEqual(custom.map((w) => w.label), ["Computador", "ei assistente"]);
  assert.equal(findWakeWord("ei assistente abre", custom).rest, "abre");
  assert.equal(findWakeWord("COMPUTADOR abre", custom).word, "Computador");
  assert.deepEqual(parseWakeWords(["a b c", "xyz"]).map((w) => w.label), ["a b c", "xyz"]);
  assert.throws(() => parseWakeWords(""), /Nenhuma palavra-chave/);
  assert.throws(() => parseWakeWords(",,,"), /Nenhuma palavra-chave/);
  assert.throws(() => parseWakeWords("ok"), /ao menos 3 letras/);
  assert.throws(() => parseWakeWords("jarvis, ab"), /'ab'/);
  assert.throws(() => parseWakeWords(undefined), /Nenhuma/);
});

test("duplicadas por normalização são unificadas (sexta-feira == sexta feira)", () => {
  assert.equal(parseWakeWords("sexta-feira, sexta feira, SEXTA-FEIRA").length, 1);
});
