import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, buildSystemPrompt } from "../src/agent/agent.js";
import { Model } from "../src/ai/model.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { createReadFileTool } from "../src/tools/readFile.js";

// Modelo falso que responde com uma lista de respostas pré-definidas
// e guarda uma cópia de cada chamada para inspeção.
function fakeModel(responses) {
  const calls = [];
  return {
    calls,
    async ask(messages, options) {
      calls.push({ messages: structuredClone(messages), options });
      const next = responses.shift();
      if (!next) throw new Error("fakeModel: sem mais respostas");
      return next;
    },
  };
}
const askTool = (id, name, input) => ({
  text: "",
  stopReason: "tool_use",
  content: [{ type: "tool_use", id, name, input }],
  toolCalls: [{ id, name, input }],
});
const answer = (text) => ({
  text,
  stopReason: "end_turn",
  content: [{ type: "text", text }],
  toolCalls: [],
});

const mockRegistry = () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "mock_echo",
    description: "devolve o texto recebido (teste)",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async ({ text }) => `eco: ${text}`,
  });
  return registry;
};

test("etapa 1: sem pedido de ferramenta, devolve a resposta direta", async () => {
  const model = fakeModel([answer("olá!")]);
  const agent = new Agent({ model, toolRegistry: mockRegistry() });
  assert.equal(await agent.run("oi"), "olá!");
  assert.equal(model.calls.length, 1);
  assert.deepEqual(model.calls[0].messages, [{ role: "user", content: "oi" }]);
  assert.equal(model.calls[0].options.tools[0].name, "mock_echo");
});

test("loop: modelo pede ferramenta, agente executa e devolve o resultado", async () => {
  const model = fakeModel([askTool("tu_1", "mock_echo", { text: "abc" }), answer("pronto")]);
  const agent = new Agent({ model, toolRegistry: mockRegistry() });

  assert.equal(await agent.run("use a ferramenta"), "pronto");
  assert.equal(model.calls.length, 2);

  const history = model.calls[1].messages;
  assert.equal(history.length, 3);
  assert.equal(history[1].role, "assistant");
  assert.deepEqual(history[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tu_1", content: "eco: abc" }],
  });
});

test("ferramenta inexistente pedida pelo modelo: erro vai ao modelo e o loop continua", async () => {
  const model = fakeModel([askTool("tu_1", "fantasma", {}), answer("ok, não existe")]);
  const agent = new Agent({ model, toolRegistry: mockRegistry() });

  assert.equal(await agent.run("x"), "ok, não existe");
  const [result] = model.calls[1].messages[2].content;
  assert.equal(result.is_error, true);
  assert.match(result.content, /'fantasma' não existe/);
});

test("parâmetros inválidos pedidos pelo modelo viram is_error", async () => {
  const model = fakeModel([askTool("tu_1", "mock_echo", { text: 42 }), answer("ok")]);
  const agent = new Agent({ model, toolRegistry: mockRegistry() });
  await agent.run("x");
  const [result] = model.calls[1].messages[2].content;
  assert.equal(result.is_error, true);
  assert.match(result.content, /deve ser do tipo string/);
});

test("várias ferramentas no mesmo turno geram um único user com todos os resultados", async () => {
  const twoCalls = {
    text: "",
    stopReason: "tool_use",
    content: [
      { type: "tool_use", id: "a", name: "mock_echo", input: { text: "1" } },
      { type: "tool_use", id: "b", name: "mock_echo", input: { text: "2" } },
    ],
    toolCalls: [
      { id: "a", name: "mock_echo", input: { text: "1" } },
      { id: "b", name: "mock_echo", input: { text: "2" } },
    ],
  };
  const model = fakeModel([twoCalls, answer("fim")]);
  const agent = new Agent({ model, toolRegistry: mockRegistry() });
  await agent.run("x");
  const results = model.calls[1].messages[2].content;
  assert.deepEqual(results.map((r) => r.tool_use_id), ["a", "b"]);
});

test("limite de passos impede loop infinito", async () => {
  const forever = Array.from({ length: 10 }, (_, i) => askTool(`t${i}`, "mock_echo", { text: "x" }));
  const model = fakeModel(forever);
  const agent = new Agent({ model, toolRegistry: mockRegistry(), maxSteps: 3 });
  assert.match(await agent.run("x"), /Parei após 3 passos/);
  assert.equal(model.calls.length, 3);
});

test("erro do modelo (rede/API) sobe para quem chamou o agente", async () => {
  const model = { ask: async () => { throw new Error("falha de rede"); } };
  const agent = new Agent({ model, toolRegistry: mockRegistry() });
  await assert.rejects(() => agent.run("x"), /falha de rede/);
});

// ---- Agente + read_file real (só o modelo é falso) ----
let base;
before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-e2e-"));
  await fs.writeFile(path.join(base, "package.json"), '{"dependencies":{"foo":"1.0.0"}}');
  await fs.writeFile(path.join(path.dirname(base), "agent-e2e-secret.txt"), "SEGREDO");
});
after(async () => {
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(path.join(path.dirname(base), "agent-e2e-secret.txt"), { force: true });
});

test("agente + read_file: lê arquivo do workspace", async () => {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool({ workspaceDir: base }));
  const model = fakeModel([askTool("tu_1", "read_file", { path: "package.json" }), answer("li")]);
  const logs = [];
  const agent = new Agent({ model, toolRegistry: registry, log: (l) => logs.push(l) });

  await agent.run("Leia package.json");
  const [result] = model.calls[1].messages[2].content;
  assert.ok(!result.is_error);
  assert.equal(result.content, '{"dependencies":{"foo":"1.0.0"}}');
  assert.ok(logs.some((l) => l.includes("read_file")));
});

test("agente + read_file: tentativa de sair do workspace chega ao modelo como erro", async () => {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool({ workspaceDir: base }));
  const model = fakeModel([askTool("tu_1", "read_file", { path: "../agent-e2e-secret.txt" }), answer("negado")]);
  const agent = new Agent({ model, toolRegistry: registry });

  await agent.run("Leia ../agent-e2e-secret.txt");
  const [result] = model.calls[1].messages[2].content;
  assert.equal(result.is_error, true);
  assert.match(result.content, /fora do diretório de trabalho/);
  assert.ok(!JSON.stringify(model.calls).includes("SEGREDO"));
});

test("prompt do sistema informa o sistema operacional com o comando certo para abrir sites", () => {
  const windows = buildSystemPrompt("win32");
  assert.match(windows, /Windows/);
  assert.match(windows, /start chrome https:\/\/exemplo\.com/);
  assert.match(windows, /'google-chrome'.*não existem aqui/); // os comandos de outro sistema aparecem só para serem negados
  assert.match(buildSystemPrompt("darwin"), /open -a "Google Chrome"/);
  assert.match(buildSystemPrompt("linux"), /google-chrome https:\/\/exemplo\.com/);
  assert.ok(!/start chrome|open -a/.test(buildSystemPrompt("linux")));
  const unknown = buildSystemPrompt("plan9");
  assert.ok(!/start chrome|google-chrome|open -a/.test(unknown)); // SO desconhecido: sem dica, sem chute
  assert.equal(buildSystemPrompt(), buildSystemPrompt(os.platform())); // padrão: o sistema desta máquina
});

test("agente envia ao modelo o prompt com o sistema operacional informado", async () => {
  const model = fakeModel([answer("ok")]);
  const agent = new Agent({ model, toolRegistry: mockRegistry(), platform: "linux" });
  await agent.run("oi");
  assert.match(model.calls[0].options.system, /google-chrome/);
  assert.doesNotMatch(model.calls[0].options.system, /start chrome/);
});

// ---- Model (com o cliente da API substituído por um stub) ----
test("Model: envia tools só quando existem e extrai toolCalls", async () => {
  const model = new Model({ apiKey: "x", modelName: "m" });
  const sent = [];
  model.client = {
    messages: {
      create: async (params) => {
        sent.push(params);
        return {
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "vou ler" },
            { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
          ],
        };
      },
    },
  };

  const withoutTools = await model.ask([{ role: "user", content: "oi" }], { system: "s" });
  assert.ok(!("tools" in sent[0]));
  assert.equal(withoutTools.text, "vou ler");
  assert.deepEqual(withoutTools.toolCalls, [{ id: "t1", name: "read_file", input: { path: "a" } }]);
  assert.equal(withoutTools.stopReason, "tool_use");

  await model.ask([{ role: "user", content: "oi" }], { tools: [{ name: "t" }] });
  assert.deepEqual(sent[1].tools, [{ name: "t" }]);
  assert.equal(sent[1].model, "m");
});
