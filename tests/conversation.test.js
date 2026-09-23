import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.js";
import { assertValidHistory } from "../src/agent/history.js";
import { Model } from "../src/ai/model.js";
import { OpenAICompatibleModel } from "../src/ai/openaiCompatible.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { buildToolRegistry } from "../src/tools/index.js";
import * as anthropic from "./helpers/mockApi.js";
import * as openai from "./helpers/mockOpenAI.js";

const yes = async () => "yes";

function fakeModel(responses) {
  const calls = [];
  return {
    calls,
    async ask(messages) {
      calls.push(structuredClone(messages));
      const next = responses.shift();
      if (!next) throw new Error("sem resposta");
      return next;
    },
  };
}
const answer = (text) => ({ text, stopReason: "end_turn", content: [{ type: "text", text }], toolCalls: [] });
const useTool = (id, name, input) => ({ text: "", stopReason: "tool_use", content: [{ type: "tool_use", id, name, input }], toolCalls: [{ id, name, input }] });

const echoRegistry = () => {
  const registry = new ToolRegistry();
  registry.register({ name: "eco", description: "d", inputSchema: { type: "object", properties: { t: { type: "string" } }, required: ["t"] }, execute: async ({ t }) => `eco:${t}` });
  return registry;
};
const agentWith = (responses, options = {}) => {
  const model = fakeModel(responses);
  return { model, agent: new Agent({ model, toolRegistry: echoRegistry(), keepHistory: true, ...options }) };
};

test("com keepHistory, a segunda pergunta enxerga a primeira (e o histórico é válido)", async () => {
  const { model, agent } = agentWith([answer("são 3 arquivos"), answer("o segundo é b.txt")]);
  assert.equal(await agent.run("quantos arquivos?"), "são 3 arquivos");
  assert.equal(await agent.run("e o segundo?"), "o segundo é b.txt");
  assert.deepEqual(model.calls[1], [
    { role: "user", content: "quantos arquivos?" },
    { role: "assistant", content: "são 3 arquivos" },
    { role: "user", content: "e o segundo?" },
  ]);
  assert.doesNotThrow(() => assertValidHistory(model.calls[1]));
});

test("sem keepHistory (padrão), cada tarefa começa do zero", async () => {
  const model = fakeModel([answer("a"), answer("b")]);
  const agent = new Agent({ model, toolRegistry: echoRegistry() });
  await agent.run("um");
  await agent.run("dois");
  assert.equal(model.calls[1].length, 1);
});

test("chamadas de ferramenta de tarefas anteriores continuam no histórico, em pares válidos", async () => {
  const { model, agent } = agentWith([useTool("t1", "eco", { t: "x" }), answer("feito"), answer("de nada")]);
  await agent.run("faça");
  await agent.run("obrigado");
  const second = model.calls[2];
  assert.deepEqual(second.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(second[2].content[0].tool_use_id, "t1");
  assert.doesNotThrow(() => assertValidHistory(second));
});

test("tarefa interrompida, com erro, em loop ou sem terminar NÃO deixa rastro no histórico", async () => {
  const { model, agent } = agentWith([answer("ok 1")]);
  await agent.run("primeira");
  const saved = structuredClone(agent.history);

  // erro do modelo no meio
  model.ask = async () => { throw new Error("falha de rede"); };
  await assert.rejects(() => agent.run("segunda"), /falha de rede/);
  assert.deepEqual(agent.history, saved);

  // limite de passos
  const looping = new Agent({ model: fakeModel(Array.from({ length: 5 }, (_, i) => useTool(`t${i}`, "eco", { t: `v${i}` }))), toolRegistry: echoRegistry(), keepHistory: true, maxSteps: 2 });
  assert.match(await looping.run("x"), /Parei após 2 passos/);
  assert.deepEqual(looping.history, []);

  // stop() no meio de uma ferramenta lenta
  const slow = new ToolRegistry();
  slow.register({ name: "lenta", description: "d", inputSchema: { type: "object", properties: {} }, execute: (_i, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelada")))) });
  const stoppable = new Agent({ model: fakeModel([useTool("s1", "lenta", {}), answer("nunca")]), toolRegistry: slow, keepHistory: true });
  const running = stoppable.run("faça algo lento");
  setTimeout(() => stoppable.stop(), 50);
  assert.match(await running, /interrompida/);
  assert.deepEqual(stoppable.history, []);
});

test("recusa do modelo e resposta cortada CONTAM como resposta (ficam no histórico)", async () => {
  const { agent } = agentWith([{ text: "não posso", stopReason: "refusal", content: [], toolCalls: [] }]);
  await agent.run("faça algo ruim");
  assert.equal(agent.history.length, 2);
  assert.equal(agent.history[1].content, "não posso");
});

test("maxTurns: só as últimas trocas ficam, sempre cortando em fronteira de troca", async () => {
  const responses = [];
  for (let i = 0; i < 5; i++) responses.push(useTool(`t${i}`, "eco", { t: String(i) }), answer(`resposta ${i}`));
  const { model, agent } = agentWith(responses, { maxTurns: 2 });
  for (let i = 0; i < 5; i++) await agent.run(`pergunta ${i}`);
  const lastRequest = model.calls.at(-1);
  const questions = lastRequest.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content);
  // durante a tarefa atual: as 2 trocas anteriores + a pergunta em andamento; o corte acontece ao terminar
  assert.deepEqual(questions, ["pergunta 2", "pergunta 3", "pergunta 4"]);
  assert.doesNotThrow(() => assertValidHistory(lastRequest));
  assert.equal(agent.history[0].content, "pergunta 3"); // depois de terminar: só as 2 últimas trocas
  assert.equal(agent.history.filter((m) => m.role === "user" && typeof m.content === "string").length, 2);
});

test("histórico gigante é aparado mesmo com poucas trocas (limite de tamanho)", async () => {
  const big = "x".repeat(400_000);
  const { agent } = agentWith([answer(big), answer(big), answer("fim")], { maxTurns: 50 });
  await agent.run("a");
  await agent.run("b");
  await agent.run("c");
  assert.ok(JSON.stringify(agent.history).length <= 700_000);
  assert.equal(agent.history.at(-1).content, "fim");
  assert.equal(agent.history[0].role, "user");
});

test("resetConversation esquece tudo; não pode ser chamado durante uma tarefa", async () => {
  const { agent } = agentWith([answer("a"), answer("b")]);
  await agent.run("um");
  agent.resetConversation();
  assert.deepEqual(agent.history, []);

  let release;
  const slowModel = { ask: () => new Promise((resolve) => { release = () => resolve(answer("ok")); }) };
  const busy = new Agent({ model: slowModel, toolRegistry: echoRegistry(), keepHistory: true });
  const running = busy.run("x");
  assert.throws(() => busy.resetConversation(), /enquanto o agente trabalha/);
  await assert.rejects(() => busy.run("y"), /já está executando/);
  release();
  await running;
  assert.doesNotThrow(() => busy.resetConversation());
});

test("uma tarefa depois de um erro funciona normalmente (o estado 'running' é liberado)", async () => {
  const model = { ask: async () => { throw new Error("boom"); } };
  const agent = new Agent({ model, toolRegistry: echoRegistry(), keepHistory: true });
  await assert.rejects(() => agent.run("a"), /boom/);
  model.ask = async () => answer("agora sim");
  assert.equal(await agent.run("b"), "agora sim");
});

// ---- multi-turno contra os servidores RÍGIDOS (Anthropic e formato OpenAI) ----
async function ws() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-conv-"));
  await fs.writeFile(path.join(dir, "a.txt"), "conteúdo A");
  return dir;
}

test("Anthropic (servidor rígido): duas tarefas com ferramenta na mesma conversa são aceitas", async () => {
  const dir = await ws();
  const server = await anthropic.startMockApi({ script: [
    anthropic.callTool("toolu_1", "read_file", { path: "a.txt" }), anthropic.say("A contém: conteúdo A"),
    anthropic.callTool("toolu_2", "list_directory", {}), anthropic.say("há um arquivo"),
  ] });
  try {
    const registry = await buildToolRegistry({ workspaceDir: dir, enabled: ["read_file", "list_directory"] });
    const model = new Model({ apiKey: "test-key", modelName: "m", baseURL: server.url, maxRetries: 0 });
    const agent = new Agent({ model, toolRegistry: registry, confirm: yes, keepHistory: true });
    assert.equal(await agent.run("leia a.txt"), "A contém: conteúdo A");
    assert.equal(await agent.run("e o que há na pasta?"), "há um arquivo");
    const lastBody = server.requests.at(-1).body;
    assert.equal(lastBody.messages.filter((m) => m.role === "user" && typeof m.content === "string").length, 2);
    assert.equal(server.remaining(), 0);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("formato OpenAI/NVIDIA (servidor rígido): duas tarefas com ferramenta na mesma conversa são aceitas", async () => {
  const dir = await ws();
  const server = await openai.startMockOpenAI({ script: [
    openai.callTool("c1", "read_file", { path: "a.txt" }), openai.say("A contém: conteúdo A"),
    openai.callTool("c2", "list_directory", {}), openai.say("há um arquivo"),
  ] });
  try {
    const registry = await buildToolRegistry({ workspaceDir: dir, enabled: ["read_file", "list_directory"] });
    const model = new OpenAICompatibleModel({ apiKey: "nvapi-test", baseURL: server.url, modelName: "m", maxRetries: 0 });
    const agent = new Agent({ model, toolRegistry: registry, confirm: yes, keepHistory: true });
    await agent.run("leia a.txt");
    assert.equal(await agent.run("e o que há na pasta?"), "há um arquivo");
    const roles = server.posts().at(-1).body.messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant", "user", "assistant", "tool"]);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
