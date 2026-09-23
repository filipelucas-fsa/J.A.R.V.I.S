// Adaptador para qualquer servidor no formato OpenAI (NVIDIA, OpenAI, Ollama...). Contra um servidor RÍGIDO.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.js";
import { ModelError } from "../src/ai/errors.js";
import {
  OpenAICompatibleModel, toOpenAIMessages, toOpenAITools, fromOpenAIResponse, extractErrorMessage, describeHttpError,
} from "../src/ai/openaiCompatible.js";
import { buildToolRegistry } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { startMockOpenAI, chat, say, callTool, toolCall, httpError, openaiError, nvidiaError } from "./helpers/mockOpenAI.js";
import { fakeDriver } from "./helpers/fakeComputer.js";

const yes = async () => "yes";
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ===================== tradução do histórico (ida) =====================
const toolConversation = (result = { type: "tool_result", tool_use_id: "call_1", content: "conteúdo do arquivo" }) => [
  { role: "user", content: "leia o arquivo" },
  { role: "assistant", content: [{ type: "text", text: "vou ler" }, { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.txt" } }] },
  { role: "user", content: [result] },
];

test("toOpenAIMessages: conversa com ferramenta vira assistant.tool_calls + role tool", () => {
  assert.deepEqual(toOpenAIMessages(toolConversation(), { system: "seja útil" }), [
    { role: "system", content: "seja útil" },
    { role: "user", content: "leia o arquivo" },
    { role: "assistant", content: "vou ler", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "conteúdo do arquivo" },
  ]);
});

test("toOpenAIMessages: assistant só com tool_use tem content null; blocos 'thinking' são ignorados", () => {
  const messages = [
    { role: "user", content: "x" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "tool_use", id: "c", name: "t", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "ok" }] },
  ];
  const out = toOpenAIMessages(messages);
  assert.equal(out[1].content, null);
  assert.equal(out[1].tool_calls[0].function.arguments, "{}");
  assert.ok(!JSON.stringify(out).includes("thinking"));
});

test("toOpenAIMessages: erros de ferramenta ganham prefixo [ERRO]", () => {
  const out = toOpenAIMessages(toolConversation({ type: "tool_result", tool_use_id: "call_1", content: "falhou", is_error: true }));
  assert.equal(out.at(-1).content, "[ERRO] falhou");
});

test("toOpenAIMessages: screenshot vira mensagem de usuário com image_url (modelo com visão)", () => {
  const result = { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "Screenshot 10x10" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } }] };
  const out = toOpenAIMessages(toolConversation(result), { vision: true });
  assert.deepEqual(out.at(-2), { role: "tool", tool_call_id: "call_1", content: "Screenshot 10x10" });
  assert.deepEqual(out.at(-1).content[1], { type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL}` } });
  assert.equal(out.at(-1).role, "user");
});

test("toOpenAIMessages: sem visão a imagem é trocada por um aviso em texto", () => {
  const result = { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "Screenshot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } }] };
  const out = toOpenAIMessages(toolConversation(result), { vision: false });
  assert.equal(out.length, 3); // user, assistant, tool: nenhuma mensagem extra com imagem
  assert.match(out.at(-1).content, /imagem omitida/);
  assert.ok(!JSON.stringify(out).includes(PIXEL));
});

test("toOpenAIMessages: modos de instrução do sistema (system, inline, none)", () => {
  const messages = [{ role: "user", content: "oi" }];
  assert.deepEqual(toOpenAIMessages(messages, { system: "S", systemMode: "system" }), [{ role: "system", content: "S" }, { role: "user", content: "oi" }]);
  assert.deepEqual(toOpenAIMessages(messages, { system: "S", systemMode: "inline" }), [{ role: "user", content: "S\n\noi" }]);
  assert.deepEqual(toOpenAIMessages(messages, { system: "S", systemMode: "none" }), [{ role: "user", content: "oi" }]);
  assert.deepEqual(toOpenAIMessages(messages, {}), [{ role: "user", content: "oi" }]);
});

test("toOpenAITools converte input_schema em parameters", () => {
  const tools = [{ name: "t", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } }];
  assert.deepEqual(toOpenAITools(tools), [{ type: "function", function: { name: "t", description: "d", parameters: tools[0].input_schema } }]);
});

// ===================== tradução da resposta (volta) =====================
const wrap = (message, finish_reason = "stop") => ({ choices: [{ message, finish_reason }] });

test("fromOpenAIResponse: texto simples", () => {
  const r = fromOpenAIResponse(wrap({ role: "assistant", content: "olá" }));
  assert.deepEqual(r, { text: "olá", stopReason: "end_turn", content: [{ type: "text", text: "olá" }], toolCalls: [] });
});

test("fromOpenAIResponse: tool_calls viram toolCalls e blocos tool_use (histórico interno)", () => {
  const r = fromOpenAIResponse(wrap({ content: null, tool_calls: [toolCall("abc", "read_file", { path: "x" })] }, "tool_calls"));
  assert.equal(r.stopReason, "tool_use");
  assert.deepEqual(r.toolCalls, [{ id: "abc", name: "read_file", input: { path: "x" } }]);
  assert.deepEqual(r.content, [{ type: "tool_use", id: "abc", name: "read_file", input: { path: "x" } }]);
});

test("fromOpenAIResponse: finish_reason 'stop' COM tool_calls (Ollama e outros) continua sendo uso de ferramenta", () => {
  const r = fromOpenAIResponse(wrap({ content: "", tool_calls: [toolCall("a", "t", {})] }, "stop"));
  assert.equal(r.stopReason, "tool_use");
  assert.equal(r.toolCalls.length, 1);
});

test("fromOpenAIResponse: argumentos malformados, ausentes ou de tipo errado", () => {
  const cases = [
    ['{"path": "x"', /JSON inválido/],
    ["não é json", /JSON inválido/],
    ["[1,2]", /objeto JSON/],
    ["42", /objeto JSON/],
    ["null", /objeto JSON/],
  ];
  for (const [args, pattern] of cases) {
    const r = fromOpenAIResponse(wrap({ tool_calls: [toolCall("a", "t", args)] }, "tool_calls"));
    assert.match(r.toolCalls[0].parseError, pattern, args);
    assert.deepEqual(r.toolCalls[0].input, {});
  }
  for (const args of ["", undefined, null]) {
    const r = fromOpenAIResponse(wrap({ tool_calls: [{ id: "a", type: "function", function: { name: "t", arguments: args } }] }, "tool_calls"));
    assert.deepEqual(r.toolCalls[0], { id: "a", name: "t", input: {} });
  }
  const asObject = fromOpenAIResponse(wrap({ tool_calls: [{ id: "a", type: "function", function: { name: "t", arguments: { x: 1 } } }] }, "tool_calls"));
  assert.deepEqual(asObject.toolCalls[0].input, { x: 1 });
  const noName = fromOpenAIResponse(wrap({ tool_calls: [{ id: "a", type: "function", function: { arguments: "{}" } }] }, "tool_calls"));
  assert.match(noName.toolCalls[0].parseError, /nome da ferramenta/);
});

test("fromOpenAIResponse: ids ausentes, inválidos ou repetidos são normalizados e únicos", () => {
  const r = fromOpenAIResponse(wrap({ tool_calls: [
    { type: "function", function: { name: "t", arguments: "{}" } },
    { id: "call:com espaço.e/símbolos", type: "function", function: { name: "t", arguments: "{}" } },
    { id: "dup", type: "function", function: { name: "t", arguments: "{}" } },
    { id: "dup", type: "function", function: { name: "t", arguments: "{}" } },
  ] }, "tool_calls"));
  const ids = r.toolCalls.map((c) => c.id);
  assert.equal(new Set(ids).size, 4);
  assert.ok(ids.every((id) => /^[a-zA-Z0-9_-]+$/.test(id)), ids.join(","));
  assert.equal(ids[0], "call_0");
});

test("fromOpenAIResponse: mapeamento de finish_reason", () => {
  const stop = (reason, extra = {}) => fromOpenAIResponse(wrap({ content: "x", ...extra }, reason)).stopReason;
  assert.equal(stop("stop"), "end_turn");
  assert.equal(stop("length"), "max_tokens");
  assert.equal(stop("content_filter"), "refusal");
  assert.equal(stop(null), "end_turn");
  assert.equal(stop("algo_novo"), "end_turn");
  assert.equal(stop("tool_calls"), "end_turn"); // disse que chamou ferramenta, mas não há chamadas: tratamos como texto
  assert.equal(fromOpenAIResponse(wrap({ tool_calls: [toolCall("a", "t", {})] }, "length")).stopReason, "max_tokens"); // cortado
});

test("fromOpenAIResponse: <think>, refusal, content em partes, content nulo", () => {
  assert.equal(fromOpenAIResponse(wrap({ content: "<think>raciocínio interno</think>Resposta final" })).text, "Resposta final");
  assert.equal(fromOpenAIResponse(wrap({ content: "<think>a</think>x<think>b</think>y" })).text, "xy");
  const refused = fromOpenAIResponse(wrap({ content: null, refusal: "não posso" }));
  assert.equal(refused.stopReason, "refusal");
  assert.equal(refused.text, "não posso");
  assert.equal(fromOpenAIResponse(wrap({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).text, "a\nb");
  const empty = fromOpenAIResponse(wrap({ content: null }));
  assert.deepEqual(empty.content, []);
  assert.equal(empty.text, "");
});

test("fromOpenAIResponse: resposta sem choices vira ModelError (com detalhe, se houver)", () => {
  for (const bad of [{}, { choices: [] }, null, undefined, { choices: "x" }]) {
    assert.throws(() => fromOpenAIResponse(bad), (e) => e instanceof ModelError && /sem 'choices'/.test(e.message));
  }
  assert.throws(() => fromOpenAIResponse({ error: { message: "model overloaded" } }), /model overloaded/);
});

// ===================== mensagens de erro =====================
test("extractErrorMessage entende os formatos de cada provedor", () => {
  assert.equal(extractErrorMessage('{"error":{"message":"chave ruim","type":"x"}}'), "chave ruim");
  assert.equal(extractErrorMessage('{"error":"texto direto"}'), "texto direto");
  assert.equal(extractErrorMessage('{"status":404,"title":"Not Found","detail":"Function abc: Not found for account xyz"}'), "Function abc: Not found for account xyz");
  assert.equal(extractErrorMessage('{"message":"algo"}'), "algo");
  assert.equal(extractErrorMessage('{"title":"Bad Request"}'), "Bad Request");
  assert.match(extractErrorMessage('{"detail":[{"loc":["body"],"msg":"field required"}]}'), /field required/);
  assert.equal(extractErrorMessage("<html>  502 Bad   Gateway </html>"), "<html> 502 Bad Gateway </html>");
  assert.equal(extractErrorMessage(""), "(sem detalhes)");
  assert.equal(extractErrorMessage(null), "(sem detalhes)");
  assert.ok(extractErrorMessage("x".repeat(5000)).length <= 300);
});

test("describeHttpError: cada status tem orientação própria e classificação temporário/permanente", () => {
  const d = (status, detail = "x", extra = {}) => describeHttpError(status, detail, { modelName: "meu-modelo", provider: "NVIDIA", ...extra });
  assert.match(d(401).message, /Chave de API inválida/);
  assert.match(d(402).message, /cobrança/);
  assert.match(d(403).message, /Sem permissão/);
  assert.match(d(404).message, /meu-modelo.*habilitado na sua conta.*MODEL_BASE_URL/s);
  assert.match(d(413).message, /grande demais/);
  assert.match(d(429, "x", { retryAfter: 7 }).message, /7s/);
  for (const s of [401, 402, 403, 404, 413, 400, 422]) assert.equal(d(s).retryable, false, String(s));
  for (const s of [429, 500, 502, 503, 504, 529]) assert.equal(d(s).retryable, true, String(s));
  assert.match(d(400, "tools are not supported").message, /MODEL_TOOLS=false/);
  assert.match(d(400, "System role not supported").message, /MODEL_SYSTEM_MODE=inline/);
  assert.match(d(400, "image input not allowed").message, /MODEL_VISION=false/);
  assert.match(d(400, "Unsupported parameter: 'max_tokens'").message, /MODEL_MAX_TOKENS_PARAM/);
  assert.match(d(400, "maximum context length is 8192 tokens").message, /contexto/);
  assert.match(d(422, "algo estranho").message, /incompatibilidade/);
  assert.match(d(418).message, /Erro de NVIDIA \(418\)/);
});

// ===================== contra o servidor rígido =====================
async function withServer(options, fn) {
  const server = await startMockOpenAI(options);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}
const modelFor = (server, o = {}) =>
  new OpenAICompatibleModel({ apiKey: "nvapi-test", baseURL: server.url, modelName: "meta/llama-3.1-70b-instruct", provider: "NVIDIA", maxRetries: 0, retryBaseMs: 5, timeoutMs: 5000, ...o });
const hello = [{ role: "user", content: "oi" }];

async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-oai-"));
  await fs.writeFile(path.join(dir, "package.json"), '{"dependencies":{"foo":"1.0.0"}}');
  return dir;
}
async function withAgent(script, { serverOptions = {}, modelOptions = {}, enabled = ["read_file", "list_directory", "write_file", "edit_file", "execute_command", "computer"], confirm = yes, driver } = {}, fn) {
  const ws = await workspace();
  try {
    await withServer({ script, ...serverOptions }, async (server) => {
      const registry = await buildToolRegistry({ workspaceDir: ws, enabled, createDriver: async () => driver ?? fakeDriver() });
      const agent = new Agent({ model: modelFor(server, modelOptions), toolRegistry: registry, confirm });
      await fn({ server, agent, ws });
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
}
const lastBody = (server) => server.posts().at(-1).body;

test("requisição: URL, cabeçalhos, campos e ferramentas no formato OpenAI", async () => {
  await withServer({ script: [say("oi")] }, async (server) => {
    const tools = [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }];
    await modelFor(server).ask(hello, { system: "sistema", tools });
    const { headers, body, url } = server.posts()[0];
    assert.equal(url, "/v1/chat/completions");
    assert.equal(headers.authorization, "Bearer nvapi-test");
    assert.match(headers["content-type"], /application\/json/);
    assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "tools"]);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.tools[0].type, "function");
  });
});

test("sem ferramentas o campo 'tools' não é enviado; sem chave não há cabeçalho Authorization (Ollama)", async () => {
  await withServer({ script: [say("oi")], apiKey: null }, async (server) => {
    await modelFor(server, { apiKey: undefined }).ask(hello);
    assert.ok(!("tools" in server.posts()[0].body));
    assert.equal(server.posts()[0].headers.authorization, undefined);
  });
});

test("URL base com barra final funciona", async () => {
  await withServer({ script: [say("ok")] }, async (server) => {
    assert.equal((await modelFor(server, { baseURL: server.url + "///" }).ask(hello)).text, "ok");
  });
});

test("fluxo completo: modelo pede read_file, agente executa, servidor rígido aceita o histórico", async () => {
  await withAgent([callTool("call_abc", "read_file", { path: "package.json" }), say("Dependência: foo")], {}, async ({ server, agent }) => {
    assert.equal(await agent.run("Leia o package.json"), "Dependência: foo");
    const messages = lastBody(server).messages;
    assert.equal(messages.at(-1).role, "tool");
    assert.equal(messages.at(-1).tool_call_id, "call_abc");
    assert.match(messages.at(-1).content, /"foo":"1.0.0"/);
    assert.equal(server.remaining(), 0);
  });
});

test("ferramentas em paralelo: uma mensagem 'tool' para cada chamada", async () => {
  const parallel = chat(null, { tool_calls: [toolCall("c1", "list_directory", {}), toolCall("c2", "read_file", { path: "package.json" })] });
  await withAgent([parallel, say("feito")], {}, async ({ server, agent }) => {
    assert.equal(await agent.run("x"), "feito");
    const tail = lastBody(server).messages.slice(-2);
    assert.deepEqual(tail.map((m) => [m.role, m.tool_call_id]), [["tool", "c1"], ["tool", "c2"]]);
  });
});

test("Ollama-style: finish_reason 'stop' com tool_calls funciona de ponta a ponta", async () => {
  const ollama = chat("", { tool_calls: [toolCall("call_1", "read_file", { path: "package.json" })], finish_reason: "stop" });
  await withAgent([ollama, say("ok")], {}, async ({ agent }) => {
    assert.equal(await agent.run("x"), "ok");
  });
});

test("argumentos malformados: o erro volta ao modelo para ele corrigir e a conversa continua", async () => {
  await withAgent([callTool("c1", "read_file", '{"path": "package.json"'), callTool("c2", "read_file", { path: "package.json" }), say("consegui")], {}, async ({ server, agent }) => {
    assert.equal(await agent.run("x"), "consegui");
    const firstResult = server.posts()[1].body.messages.at(-1);
    assert.match(firstResult.content, /\[ERRO\].*argumentos.*JSON inválido/s);
    assert.match(server.posts()[2].body.messages.at(-1).content, /foo/);
  });
});

test("ferramenta inexistente e parâmetros inválidos voltam como erro com [ERRO]", async () => {
  await withAgent([callTool("c1", "apagar_tudo", {}), callTool("c2", "read_file", { path: 5 }), say("ok")], {}, async ({ server, agent }) => {
    await agent.run("x");
    assert.match(server.posts()[1].body.messages.at(-1).content, /\[ERRO\].*não existe/s);
    assert.match(server.posts()[2].body.messages.at(-1).content, /\[ERRO\].*inválidos/s);
  });
});

test("screenshot com modelo de visão: imagem chega como image_url válida (o servidor confere)", async () => {
  const driver = fakeDriver({ screen: { width: 1920, height: 1080 }, capture: { width: 3840, height: 2160 } });
  await withAgent([callTool("c1", "screenshot", {}), say("vi")], { driver, modelOptions: { vision: true } }, async ({ server, agent }) => {
    assert.equal(await agent.run("olhe a tela"), "vi");
    const tail = lastBody(server).messages.slice(-2);
    assert.equal(tail[0].role, "tool");
    assert.equal(tail[1].role, "user");
    assert.equal(tail[1].content[1].type, "image_url");
  });
});

test("screenshot com modelo SEM visão: nenhuma imagem é enviada", async () => {
  await withAgent([callTool("c1", "screenshot", {}), say("não consigo ver")], { modelOptions: { vision: false } }, async ({ server, agent }) => {
    await agent.run("olhe a tela");
    assert.ok(!JSON.stringify(lastBody(server)).includes("image_url"));
    assert.match(lastBody(server).messages.at(-1).content, /imagem omitida/);
  });
});

test("modo de instruções 'inline' funciona com servidor que rejeita o papel system", async () => {
  await withServer({ script: [say("ok")], allowSystem: false }, async (server) => {
    const r = await modelFor(server, { systemMode: "inline" }).ask(hello, { system: "sou o sistema" });
    assert.equal(r.text, "ok");
    assert.equal(server.posts()[0].body.messages[0].content, "sou o sistema\n\noi");
  });
});

test("servidor que rejeita 'system' dá orientação para MODEL_SYSTEM_MODE=inline", async () => {
  await withServer({ allowSystem: false }, async (server) => {
    await assert.rejects(() => modelFor(server).ask(hello, { system: "s" }), (e) => e instanceof ModelError && e.status === 400 && /MODEL_SYSTEM_MODE=inline/.test(e.message));
  });
});

test("modelo sem suporte a ferramentas: 400 com orientação; sem ferramentas (MODEL_TOOLS=false) funciona", async () => {
  await withServer({ supportsTools: false, script: [say("só conversa")] }, async (server) => {
    const tools = [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }];
    await assert.rejects(() => modelFor(server).ask(hello, { tools }), /MODEL_TOOLS=false/);
    assert.equal((await modelFor(server).ask(hello)).text, "só conversa");
  });
});

test("parâmetro de limite de tokens: max_completion_tokens quando configurado; erro orientado quando errado", async () => {
  await withServer({ tokenParam: "max_completion_tokens", script: [say("ok")] }, async (server) => {
    await assert.rejects(() => modelFor(server).ask(hello), /MODEL_MAX_TOKENS_PARAM/);
    assert.equal((await modelFor(server, { maxTokensParam: "max_completion_tokens" }).ask(hello)).text, "ok");
    assert.equal(server.posts().at(-1).body.max_completion_tokens, 4096);
  });
});

// ---------- falhas ----------
const failWith = async (step, options = {}, modelOptions = {}) => {
  let error;
  await withServer({ script: [step], ...options }, async (server) => {
    try {
      await modelFor(server, modelOptions).ask(hello);
    } catch (e) {
      error = e;
    }
    error.requests = server.posts().length;
  });
  return error;
};

test("401 (chave errada) e 404 no formato da NVIDIA ({title, detail})", async () => {
  await withServer({}, async (server) => {
    const error = await modelFor(server, { apiKey: "outra-chave" }).ask(hello).catch((e) => e);
    assert.ok(error instanceof ModelError);
    assert.equal(error.status, 401);
    assert.match(error.message, /Chave de API inválida.*NVIDIA/);
  });
  const notFound = await failWith(nvidiaError(404, "Not Found", "Function 'abc': Not found for account 'xyz'"), {}, { maxRetries: 2 });
  assert.equal(notFound.status, 404);
  assert.match(notFound.message, /habilitado na sua conta/);
  assert.match(notFound.message, /Function 'abc': Not found for account/);
  assert.equal(notFound.retryable, false);
  assert.equal(notFound.requests, 1); // erro permanente: não repete
});

test("400 no formato OpenAI mostra a mensagem original do servidor", async () => {
  const error = await failWith(openaiError(400, "campo estranho no corpo"));
  assert.match(error.message, /Requisição recusada por NVIDIA \(400\): campo estranho no corpo/);
});

test("429 com Retry-After: espera e tenta de novo até dar certo", async () => {
  await withServer({ script: [openaiError(429, "slow down", { "retry-after": "0" }), say("passou")] }, async (server) => {
    assert.equal((await modelFor(server, { maxRetries: 2 }).ask(hello)).text, "passou");
    assert.equal(server.posts().length, 2);
  });
});

test("500 e 503 seguidos de sucesso; 503 persistente vira erro temporário após as retentativas", async () => {
  await withServer({ script: [nvidiaError(500, "Internal", "boom"), nvidiaError(503, "Unavailable", "busy"), say("recuperou")] }, async (server) => {
    assert.equal((await modelFor(server, { maxRetries: 2 }).ask(hello)).text, "recuperou");
    assert.equal(server.posts().length, 3);
  });
  const error = await failWith(nvidiaError(503, "Unavailable", "busy"), {}, { maxRetries: 0 });
  assert.equal(error.retryable, true);
  assert.match(error.message, /Erro no servidor de NVIDIA \(503\): busy/);
  await withServer({ script: [nvidiaError(503, "x", "a"), nvidiaError(503, "x", "b")] }, async (server) => {
    const e = await modelFor(server, { maxRetries: 1 }).ask(hello).catch((err) => err);
    assert.equal(e.retryable, true);
    assert.equal(server.posts().length, 2);
  });
});

test("timeout, conexão recusada e conexão derrubada", async () => {
  const timeout = await failWith({ hang: true }, {}, { timeoutMs: 250 });
  assert.equal(timeout.retryable, true);
  assert.match(timeout.message, /Tempo esgotado/);

  const server = await startMockOpenAI({});
  const model = modelFor(server);
  await server.close();
  const refused = await model.ask(hello).catch((e) => e);
  assert.ok(refused instanceof ModelError);
  assert.equal(refused.retryable, true);
  assert.match(refused.message, /Não foi possível conectar a NVIDIA/);

  const dropped = await failWith({ destroy: true });
  assert.equal(dropped.retryable, true);
  assert.match(dropped.message, /conectar/);
});

test("resposta 200 que não é JSON (URL base errada devolvendo HTML) aponta para MODEL_BASE_URL", async () => {
  const error = await failWith({ raw: "<html><body>Welcome to nginx</body></html>" });
  assert.match(error.message, /não é JSON/);
  assert.match(error.message, /MODEL_BASE_URL/);
  assert.equal(error.retryable, false);
  const wrongPath = await withServer({}, async (server) => modelFor(server, { baseURL: server.origin }).ask(hello).catch((e) => e));
  assert.equal(wrongPath.status, 404);
  assert.match(wrongPath.message, /termina em \/v1/);
});

test("JSON 200 sem choices vira ModelError", async () => {
  const error = await failWith({ raw: '{"id":"x","object":"error"}' });
  assert.match(error.message, /sem 'choices'/);
});

test("a chave de API nunca aparece nas mensagens de erro, mesmo se o servidor a repetir", async () => {
  const error = await failWith(openaiError(400, "Incorrect API key provided: nvapi-test. Find it at ..."));
  assert.ok(!error.message.includes("nvapi-test"));
  assert.match(error.message, /\*\*\*/);
  const html = await failWith({ raw: "<html>key=nvapi-test</html>" });
  assert.ok(!html.message.includes("nvapi-test"));
});

test("usuário cancela: durante a espera pela resposta e durante a espera entre retentativas", async () => {
  await withServer({ script: [{ hang: true }] }, async (server) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await modelFor(server).ask(hello, { signal: controller.signal }).catch((e) => e);
    assert.ok(error instanceof ModelError);
    assert.match(error.message, /cancelada/);
  });
  await withServer({ script: [openaiError(429, "slow", { "retry-after": "20" }), say("nunca")] }, async (server) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const error = await modelFor(server, { maxRetries: 3 }).ask(hello, { signal: controller.signal }).catch((e) => e);
    assert.match(error.message, /cancelada/);
    assert.ok(Date.now() - started < 3000);
    assert.equal(server.posts().length, 1);
  });
});

test("usuário nega uma escrita: o modelo recebe o [ERRO] e o arquivo não existe", async () => {
  await withAgent([callTool("c1", "write_file", { path: "novo.txt", content: "oi" }), say("ok")], { confirm: async () => "no" }, async ({ server, agent, ws }) => {
    await agent.run("x");
    assert.match(lastBody(server).messages.at(-1).content, /\[ERRO\].*NEGOU/s);
    assert.equal(await fs.access(path.join(ws, "novo.txt")).then(() => true, () => false), false);
  });
});

// ---------- /models ----------
test("listModels: lista ordenada, e erros bem explicados", async () => {
  await withServer({}, async (server) => {
    assert.deepEqual(await modelFor(server).listModels(), ["meta/llama-3.1-70b-instruct", "nvidia/nemotron-mini"]);
    const bad = await modelFor(server, { apiKey: "errada" }).listModels().catch((e) => e);
    assert.equal(bad.status, 401);
    assert.match(bad.message, /Chave de API inválida/);
    const offPath = await modelFor(server, { baseURL: server.origin + "/outro" }).listModels().catch((e) => e);
    assert.equal(offPath.status, 404);
  });
  const server = await startMockOpenAI({});
  const model = modelFor(server);
  await server.close();
  await assert.rejects(() => model.listModels(), /Não foi possível conectar/);
});

test("registry vazio (MODEL_TOOLS=false) não envia 'tools' ao servidor", async () => {
  await withServer({ script: [say("só texto")], supportsTools: false }, async (server) => {
    const agent = new Agent({ model: modelFor(server), toolRegistry: new ToolRegistry() });
    assert.equal(await agent.run("oi"), "só texto");
    assert.ok(!("tools" in server.posts()[0].body));
  });
});

test("respostas vazias e finish_reason length/content_filter no agente", async () => {
  await withAgent([chat(null)], {}, async ({ agent }) => assert.match(await agent.run("x"), /não retornou texto/));
  await withAgent([chat("parte", { finish_reason: "length" })], {}, async ({ agent }) => assert.match(await agent.run("x"), /resposta cortada/));
  await withAgent([chat("", { finish_reason: "content_filter" })], {}, async ({ agent }) => assert.match(await agent.run("x"), /recusou/));
  await withAgent([httpError(200, undefined)].map(() => chat("<think>x</think>Resposta")), {}, async ({ agent }) => assert.equal(await agent.run("x"), "Resposta"));
});

// =============== Cenário real: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning ===============
// Réplica do exemplo oficial da NVIDIA (build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning):
// mensagem com texto + imagem, max_tokens=65536, reasoning_budget=16384, temperature=0.6, top_p=0.95.
const NEMOTRON_OMNI = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const nemotronModel = (server, extra = {}) => new OpenAICompatibleModel({
  apiKey: "nvapi-test", baseURL: server.url, modelName: NEMOTRON_OMNI, provider: "NVIDIA", maxRetries: 0,
  maxTokens: 65536, temperature: 0.6, topP: 0.95, reasoningBudget: 16384, vision: true, ...extra,
});

test("Nemotron Omni Reasoning: envia exatamente os parâmetros do exemplo oficial da NVIDIA", async () => {
  await withServer({ script: [say("Descrição da imagem")] }, async (server) => {
    await nemotronModel(server).ask(hello);
    const body = server.posts()[0].body;
    assert.equal(body.model, NEMOTRON_OMNI);
    assert.equal(body.max_tokens, 65536);
    assert.equal(body.temperature, 0.6);
    assert.equal(body.top_p, 0.95);
    assert.equal(body.reasoning_budget, 16384);
  });
});

test("Nemotron Omni Reasoning: bloco <think> (raciocínio) é removido; só o texto final sobra", async () => {
  const withThinking = chat("<think>\nO usuário perguntou sobre a imagem. Vou analisar os elementos visíveis...\nEncontrei um gato laranja sobre um teclado.\n</think>\nA imagem mostra um gato laranja deitado sobre um teclado de computador.");
  await withServer({ script: [withThinking] }, async (server) => {
    const r = await nemotronModel(server).ask(hello);
    assert.equal(r.text, "A imagem mostra um gato laranja deitado sobre um teclado de computador.");
    assert.ok(!/<think>|usuário perguntou/.test(r.text));
  });
});

test("Nemotron Omni Reasoning: fluxo completo com screenshot (o agente 'vê' a imagem de verdade)", async () => {
  const ws = await workspace();
  try {
    const driver = fakeDriver({ screen: { width: 1920, height: 1080 }, capture: { width: 1920, height: 1080 } });
    const script = [
      callTool("call_1", "screenshot", {}),
      chat("<think>Vejo uma tela de trabalho.</think>Vejo o VS Code aberto com um arquivo JavaScript."),
    ];
    await withServer({ script }, async (server) => {
      const registry = await buildToolRegistry({ workspaceDir: ws, enabled: ["computer"], createDriver: async () => driver });
      const agent = new Agent({ model: nemotronModel(server), toolRegistry: registry, confirm: yes });
      const answer = await agent.run("O que tem na minha tela?");
      assert.equal(answer, "Vejo o VS Code aberto com um arquivo JavaScript.");

      // confere que a imagem (base64) chegou de verdade no formato image_url, como no exemplo da NVIDIA
      const toolResultMsg = server.posts().at(-1).body.messages.find((m) => m.role === "user" && Array.isArray(m.content));
      const image = toolResultMsg.content.find((c) => c.type === "image_url");
      assert.match(image.image_url.url, /^data:image\/png;base64,/);
      // e os parâmetros do exemplo continuam presentes mesmo com ferramentas em uso
      assert.equal(server.posts()[0].body.reasoning_budget, 16384);
      assert.equal(server.posts()[0].body.max_tokens, 65536);
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("Nemotron Omni Reasoning: 404 (modelo/conta) e 400 (parâmetro não suportado) continuam com mensagem clara", async () => {
  await withServer({ script: [nvidiaError(404, "Not Found", `Function '${NEMOTRON_OMNI}': Not found for account`)] }, async (server) => {
    const error = await nemotronModel(server).ask(hello).catch((e) => e);
    assert.equal(error.status, 404);
    assert.match(error.message, new RegExp(NEMOTRON_OMNI.replace(/[/.]/g, "\\$&")));
  });
  await withServer({ script: [openaiError(400, "reasoning_budget is not supported by this deployment")] }, async (server) => {
    const error = await nemotronModel(server).ask(hello).catch((e) => e);
    assert.equal(error.status, 400);
    assert.match(error.message, /reasoning_budget/);
  });
});
