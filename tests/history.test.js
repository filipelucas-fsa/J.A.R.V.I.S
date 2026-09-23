import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolResultBlock, pruneOldImages, assertValidHistory, MAX_TOOL_TEXT_CHARS } from "../src/agent/history.js";

// PNG 1x1 válido em base64
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const image = { mediaType: "image/png", data: PIXEL };

test("resultado de texto vira string, sem is_error", () => {
  assert.deepEqual(buildToolResultBlock("t1", { ok: true, output: "oi", images: [] }), {
    type: "tool_result", tool_use_id: "t1", content: "oi",
  });
});

test("resultado de erro tem is_error e texto", () => {
  assert.deepEqual(buildToolResultBlock("t1", { ok: false, error: "falhou" }), {
    type: "tool_result", tool_use_id: "t1", content: "falhou", is_error: true,
  });
});

test("nunca envia conteúdo vazio (a API rejeita is_error com conteúdo vazio)", () => {
  assert.equal(buildToolResultBlock("t", { ok: true, output: "" }).content, "(sem saída)");
  assert.equal(buildToolResultBlock("t", { ok: true, output: "   \n" }).content, "(sem saída)");
  assert.equal(buildToolResultBlock("t", { ok: false, error: "" }).content, "Erro desconhecido.");
  assert.equal(buildToolResultBlock("t", { ok: false, error: undefined }).content, "Erro desconhecido.");
  assert.equal(buildToolResultBlock("t", { ok: false, error: "  " }).content, "Erro desconhecido.");
});

test("imagens viram lista [texto, imagem] no formato da API", () => {
  const block = buildToolResultBlock("t", { ok: true, output: "screenshot", images: [image] });
  assert.deepEqual(block.content, [
    { type: "text", text: "screenshot" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
  ]);
});

test("imagens inválidas são descartadas com aviso, sem quebrar o resultado", () => {
  const tooBig = Buffer.alloc(5 * 1024 * 1024 + 10).toString("base64");
  const cases = [
    [{ mediaType: "image/png", data: "" }, /vazia/],
    [{ mediaType: "image/bmp", data: PIXEL }, /tipo de imagem/],
    [{ mediaType: "image/png", data: "não é base64!!" }, /base64/],
    [{ mediaType: "image/png", data: "abc" }, /base64/],
    [{ mediaType: "image/png", data: tooBig }, /grande demais/],
    [null, /tipo de imagem/],
  ];
  for (const [img, pattern] of cases) {
    const block = buildToolResultBlock("t", { ok: true, output: "x", images: [img] });
    assert.equal(typeof block.content, "string");
    assert.match(block.content, pattern);
  }
});

test("imagens em resultado de erro são ignoradas", () => {
  const block = buildToolResultBlock("t", { ok: false, error: "e", images: [image] });
  assert.equal(block.content, "e");
});

test("texto gigante é truncado com aviso", () => {
  const block = buildToolResultBlock("t", { ok: true, output: "x".repeat(MAX_TOOL_TEXT_CHARS + 1000) });
  assert.ok(block.content.length < MAX_TOOL_TEXT_CHARS + 200);
  assert.match(block.content, /saída truncada/);
});

// ---------- pruneOldImages ----------
const shot = (id, label) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: label }, { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } }] }],
});
const countImages = (messages) =>
  messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).flatMap((b) => (Array.isArray(b.content) ? b.content : [])).filter((b) => b.type === "image").length;

test("pruneOldImages mantém só as N mais recentes", () => {
  const messages = [shot("a", "1"), shot("b", "2"), shot("c", "3"), shot("d", "4")];
  pruneOldImages(messages, 2);
  assert.equal(countImages(messages), 2);
  assert.equal(messages[0].content[0].content[1].type, "text"); // mais antigas viraram texto
  assert.match(messages[0].content[0].content[1].text, /removido/);
  assert.equal(messages[3].content[0].content[1].type, "image"); // mais recente preservada
  assert.equal(messages[0].content[0].content[0].text, "1"); // texto original preservado
});

test("pruneOldImages não mexe quando há poucas imagens, e keep=0 remove todas", () => {
  const few = [shot("a", "1"), shot("b", "2")];
  pruneOldImages(few, 3);
  assert.equal(countImages(few), 2);
  pruneOldImages(few, 0);
  assert.equal(countImages(few), 0);
});

// ---------- assertValidHistory ----------
const use = (id) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "x", input: {} }] });
const result = (id, extra = {}) => ({ type: "tool_result", tool_use_id: id, content: "ok", ...extra });

test("históricos válidos passam", () => {
  assert.doesNotThrow(() => assertValidHistory([{ role: "user", content: "oi" }]));
  assert.doesNotThrow(() => assertValidHistory([{ role: "user", content: "oi" }, use("a"), { role: "user", content: [result("a")] }]));
  assert.doesNotThrow(() =>
    assertValidHistory([
      { role: "user", content: "oi" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }, { type: "tool_use", id: "b", name: "x", input: {} }] },
      { role: "user", content: [result("b"), result("a")] }, // ordem diferente é permitida
    ])
  );
});

test("históricos que a API recusaria são detectados localmente", () => {
  const u = { role: "user", content: "oi" };
  const bad = {
    "vazio": [],
    "primeira mensagem do assistente": [{ role: "assistant", content: "x" }, u],
    "última mensagem do assistente": [u, { role: "assistant", content: "x" }],
    "papéis repetidos": [u, u],
    "conteúdo vazio (texto)": [{ role: "user", content: "  " }],
    "conteúdo vazio (lista)": [{ role: "user", content: [] }],
    "tool_use sem tool_result": [u, use("a"), { role: "user", content: "e agora?" }],
    "tool_result faltando um dos ids": [u, { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }, { type: "tool_use", id: "b", name: "x", input: {} }] }, { role: "user", content: [result("a")] }],
    "tool_result sem tool_use": [u, { role: "assistant", content: "texto" }, { role: "user", content: [result("zzz")] }],
    "tool_result com id trocado": [u, use("a"), { role: "user", content: [result("b")] }],
    "tool_result duplicado": [u, use("a"), { role: "user", content: [result("a"), result("a")] }],
    "tool_result depois de texto": [u, use("a"), { role: "user", content: [{ type: "text", text: "oi" }, result("a")] }],
    "is_error com conteúdo vazio": [u, use("a"), { role: "user", content: [result("a", { is_error: true, content: "" })] }],
    "id de tool_use inválido": [u, use("id com espaço!"), { role: "user", content: [result("id com espaço!")] }],
    "imagem enorme": [u, use("a"), { role: "user", content: [result("a", { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.alloc(5.2 * 1024 * 1024).toString("base64") } }] })] }],
  };
  for (const [name, history] of Object.entries(bad)) {
    assert.throws(() => assertValidHistory(history), /Histórico de mensagens inválido/, name);
  }
});
