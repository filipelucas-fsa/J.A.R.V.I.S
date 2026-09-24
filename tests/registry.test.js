import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/toolRegistry.js";

// Ferramenta MOCK: só existe para testar o registry.
const mockTool = () => ({
  name: "mock_sum",
  description: "Soma dois números inteiros (ferramenta de teste).",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "integer", description: "primeiro número" },
      b: { type: "integer", description: "segundo número" },
      label: { type: "string", description: "rótulo opcional" },
    },
    required: ["a", "b"],
  },
  execute: async ({ a, b, label = "soma" }) => `${label}: ${a + b}`,
});

test("registra e localiza uma ferramenta", () => {
  const registry = new ToolRegistry();
  registry.register(mockTool());
  assert.equal(registry.get("mock_sum").name, "mock_sum");
  assert.equal(registry.list().length, 1);
});

test("getDefinitions não expõe a função execute", () => {
  const registry = new ToolRegistry();
  registry.register(mockTool());
  const [definition] = registry.getDefinitions();
  assert.deepEqual(Object.keys(definition).sort(), ["description", "input_schema", "name"]);
});

test("executa a ferramenta mock e retorna o resultado", async () => {
  const registry = new ToolRegistry();
  registry.register(mockTool());
  assert.deepEqual(await registry.execute("mock_sum", { a: 2, b: 3 }), { ok: true, output: "soma: 5", images: [] });
  assert.deepEqual(await registry.execute("mock_sum", { a: 2, b: 3, label: "x" }), { ok: true, output: "x: 5", images: [] });
});

test("ferramenta inexistente retorna erro claro e lista as disponíveis", async () => {
  const registry = new ToolRegistry();
  registry.register(mockTool());
  const result = await registry.execute("nao_existe", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /'nao_existe' não existe/);
  assert.match(result.error, /mock_sum/);
});

test("ferramenta inexistente com nomes especiais do JavaScript", async () => {
  const registry = new ToolRegistry();
  for (const name of ["constructor", "__proto__", "toString"]) {
    assert.equal((await registry.execute(name, {})).ok, false);
  }
});

test("parâmetros inválidos", async () => {
  const registry = new ToolRegistry();
  registry.register(mockTool());

  const missing = await registry.execute("mock_sum", { a: 1 });
  assert.match(missing.error, /'b' é obrigatório/);

  const wrongType = await registry.execute("mock_sum", { a: "1", b: 2 });
  assert.match(wrongType.error, /'a' deve ser do tipo integer/);

  const notInteger = await registry.execute("mock_sum", { a: 1.5, b: 2 });
  assert.match(notInteger.error, /'a' deve ser do tipo integer/);

  const unknown = await registry.execute("mock_sum", { a: 1, b: 2, extra: true });
  assert.match(unknown.error, /'extra' não existe/);

  const proto = await registry.execute("mock_sum", JSON.parse('{"a":1,"b":2,"constructor":1}'));
  assert.equal(proto.ok, false);

  for (const bad of [null, "texto", [1, 2]]) {
    const result = await registry.execute("mock_sum", bad);
    assert.match(result.error, /devem ser um objeto/);
  }
});

test("erro lançado dentro da ferramenta vira resultado de erro (não derruba o agente)", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "quebra",
    description: "sempre falha",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("boom");
    },
  });
  const result = await registry.execute("quebra", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});

test("register rejeita duplicadas e definições inválidas", () => {
  const registry = new ToolRegistry();
  registry.register(mockTool());
  assert.throws(() => registry.register(mockTool()), /já registrada/);

  const base = mockTool();
  assert.throws(() => registry.register({ ...base, name: "nome inválido!" }), /'name'/);
  assert.throws(() => registry.register({ ...base, name: "a", description: "" }), /description/);
  assert.throws(() => registry.register({ ...base, name: "b", execute: null }), /execute/);
  assert.throws(() => registry.register({ ...base, name: "c", inputSchema: null }), /inputSchema/);
  assert.throws(
    () => registry.register({ ...base, name: "d", inputSchema: { type: "object", properties: { x: { type: "array" } } } }),
    /tipo não suportado/
  );
  assert.throws(
    () => registry.register({ ...base, name: "e", inputSchema: { type: "object", properties: {}, required: ["x"] } }),
    /não o declara/
  );
  assert.throws(() => registry.register(null), /objeto/);
});

// =============== Etapa 5+: schemas ricos, confirmação, log, imagens ===============
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActionLog } from "../src/agent/actionLog.js";

const richTool = () => ({
  name: "rich",
  description: "tool com schema rico",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["a", "b"] },
      n: { type: "integer", minimum: 1, maximum: 5 },
      tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
      text: { type: "string", maxLength: 5 },
      flag: { type: "boolean" },
    },
    required: ["mode"],
  },
  execute: async () => "ok",
});

test("validação de enum, limites, arrays e tamanho de texto", async () => {
  const registry = new ToolRegistry();
  registry.register(richTool());
  const run = (input) => registry.execute("rich", input);

  assert.equal((await run({ mode: "a" })).ok, true);
  assert.equal((await run({ mode: "b", n: 5, tags: ["x", "y"], text: "12345", flag: true })).ok, true);

  assert.match((await run({ mode: "c" })).error, /um dos valores: a, b/);
  assert.match((await run({ mode: 1 })).error, /'mode' deve ser do tipo string/);
  assert.match((await run({ mode: "a", n: 0 })).error, />= 1/);
  assert.match((await run({ mode: "a", n: 6 })).error, /<= 5/);
  assert.match((await run({ mode: "a", n: 2.5 })).error, /integer/);
  assert.match((await run({ mode: "a", n: NaN })).error, /integer/);
  assert.match((await run({ mode: "a", n: Infinity })).error, /integer/);
  assert.match((await run({ mode: "a", tags: [] })).error, /ao menos 1/);
  assert.match((await run({ mode: "a", tags: ["a", "b", "c"] })).error, /no máximo 2/);
  assert.match((await run({ mode: "a", tags: ["a", 1] })).error, /item 1 deve ser do tipo string/);
  assert.match((await run({ mode: "a", tags: "x" })).error, /tipo array/);
  assert.match((await run({ mode: "a", text: "123456" })).error, /no máximo 5 caracteres/);
  assert.match((await run({ mode: "a", flag: "true" })).error, /boolean/);
  assert.match((await run({ mode: "a", n: null })).error, /integer/);
});

test("register rejeita schemas mal definidos (evita erro 400 depois)", () => {
  const registry = new ToolRegistry();
  const withProps = (name, properties) => ({ ...richTool(), name, inputSchema: { type: "object", properties } });
  assert.throws(() => registry.register(withProps("a", { x: { type: "string", enum: [] } })), /enum/);
  assert.throws(() => registry.register(withProps("b", { x: { type: "array" } })), /tipo não suportado/);
  assert.throws(() => registry.register(withProps("c", { x: { type: "array", items: { type: "array" } } })), /tipo não suportado/);
  assert.throws(() => registry.register(withProps("d", { x: { type: "boolean", enum: [true] } })), /enum/);
  assert.throws(() => registry.register(withProps("e", { x: { type: "object" } })), /tipo não suportado/);
  assert.throws(() => registry.register({ ...richTool(), name: "f", prepare: "não é função" }), /prepare/);
  assert.throws(() => registry.register({ ...richTool(), name: "g", coerceInput: "não é função" }), /coerceInput/);
});

test("coerceInput: limpeza antes da validação (modelos que mandam números como texto)", async () => {
  const registry = new ToolRegistry();
  const executed = [];
  registry.register({
    name: "coord",
    description: "aceita número enviado como texto",
    coerceInput: (input) => {
      const out = { ...input };
      for (const key of ["x", "y"]) {
        if (typeof out[key] === "string" && Number.isFinite(Number(out[key]))) out[key] = Number(out[key]);
      }
      return out;
    },
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
    execute: async (input) => (executed.push(input), `(${input.x}, ${input.y})`),
  });

  assert.equal((await registry.execute("coord", { x: "130", y: "677" })).ok, true, "texto vira número e passa");
  assert.deepEqual(executed.at(-1), { x: 130, y: 677 }, "a ferramenta recebe o valor limpo");
  assert.match((await registry.execute("coord", { x: "abc", y: 5 })).error, /deve ser do tipo number/, "o que não vira número, a validação recusa");
  assert.equal((await registry.execute("coord", { x: 1, y: 2 })).ok, true, "número normal continua igual");
});

const dangerous = (calls, extra = {}) => ({
  name: "danger",
  description: "faz algo perigoso",
  requiresConfirmation: true,
  allowSessionApproval: true,
  inputSchema: { type: "object", properties: { x: { type: "string" } } },
  prepare: async ({ x }) => `vai fazer ${x}`,
  execute: async ({ x }) => {
    calls.push(x);
    return "feito";
  },
  ...extra,
});

test("SEM confirm, ferramenta perigosa é negada por padrão e não executa", async () => {
  const calls = [];
  const registry = new ToolRegistry();
  registry.register(dangerous(calls));
  const result = await registry.execute("danger", { x: "a" });
  assert.equal(result.ok, false);
  assert.equal(result.denied, true);
  assert.match(result.error, /NEGADA/);
  assert.deepEqual(calls, []);
});

test("confirm 'yes' executa e recebe descrição, ferramenta e input", async () => {
  const calls = [];
  const asks = [];
  const registry = new ToolRegistry();
  registry.register(dangerous(calls));
  const result = await registry.execute("danger", { x: "a" }, { confirm: async (r) => (asks.push(r), "yes") });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["a"]);
  assert.deepEqual(asks[0], { tool: "danger", description: "vai fazer a", input: { x: "a" }, allowSessionApproval: true });
});

test("respostas que não são um 'yes' claro negam (fail-safe)", async () => {
  for (const answer of ["no", "sim", "y", "YES", true, 1, null, undefined, "", {}, "always-ish"]) {
    const calls = [];
    const registry = new ToolRegistry();
    registry.register(dangerous(calls));
    const result = await registry.execute("danger", { x: "a" }, { confirm: async () => answer });
    assert.equal(result.denied, true, `resposta ${JSON.stringify(answer)} deveria negar`);
    assert.deepEqual(calls, []);
  }
});

test("confirm que lança erro nega", async () => {
  const calls = [];
  const registry = new ToolRegistry();
  registry.register(dangerous(calls));
  const result = await registry.execute("danger", { x: "a" }, { confirm: async () => { throw new Error("terminal fechou"); } });
  assert.equal(result.denied, true);
  assert.deepEqual(calls, []);
});

test("'always' aprova a sessão; resetApprovals volta a perguntar", async () => {
  const calls = [];
  let asked = 0;
  const confirm = async () => (asked++, "always");
  const registry = new ToolRegistry();
  registry.register(dangerous(calls));

  await registry.execute("danger", { x: "1" }, { confirm });
  await registry.execute("danger", { x: "2" }, { confirm });
  assert.equal(asked, 1);
  assert.deepEqual(calls, ["1", "2"]);

  registry.resetApprovals();
  await registry.execute("danger", { x: "3" }, { confirm });
  assert.equal(asked, 2);
});

test("'always' em ferramenta que não permite aprovação de sessão vale só uma vez", async () => {
  const calls = [];
  let asked = 0;
  const registry = new ToolRegistry();
  registry.register(dangerous(calls, { allowSessionApproval: false }));
  const confirm = async () => (asked++, "always");
  await registry.execute("danger", { x: "1" }, { confirm });
  await registry.execute("danger", { x: "2" }, { confirm });
  assert.equal(asked, 2);
  assert.deepEqual(calls, ["1", "2"]);
});

test("prepare que lança e parâmetros inválidos NÃO incomodam o usuário", async () => {
  const calls = [];
  let asked = 0;
  const confirm = async () => (asked++, "yes");
  const registry = new ToolRegistry();
  registry.register(dangerous(calls, { prepare: async ({ x }) => { if (x === "ruim") throw new Error("caminho proibido"); return "ok"; } }));

  const rejected = await registry.execute("danger", { x: "ruim" }, { confirm });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /caminho proibido/);

  const invalid = await registry.execute("danger", { x: 123 }, { confirm });
  assert.equal(invalid.ok, false);
  assert.equal(asked, 0);
  assert.deepEqual(calls, []);
});

test("ferramenta pode retornar texto + imagens", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "shot", description: "d", inputSchema: { type: "object", properties: {} },
    execute: async () => ({ text: "captura", images: [{ mediaType: "image/png", data: "AAAA" }] }),
  });
  registry.register({
    name: "shot_bad", description: "d", inputSchema: { type: "object", properties: {} },
    execute: async () => ({ text: "x", images: "não é lista" }),
  });
  registry.register({
    name: "num", description: "d", inputSchema: { type: "object", properties: {} },
    execute: async () => 42,
  });
  const ok = await registry.execute("shot", {});
  assert.deepEqual(ok, { ok: true, output: "captura", images: [{ mediaType: "image/png", data: "AAAA" }] });
  assert.match((await registry.execute("shot_bad", {})).error, /images/);
  assert.equal((await registry.execute("num", {})).output, "42");
});

test("log de ações: registra todos os desfechos e oculta parâmetros sensíveis", async () => {
  const entries = [];
  const registry = new ToolRegistry({ actionLog: { record: (e) => entries.push(e) } });
  registry.register(dangerous([], { name: "typer", redact: ["x"] }));
  registry.register({ name: "boom", description: "d", inputSchema: { type: "object", properties: {} }, execute: async () => { throw new Error("x"); } });

  await registry.execute("typer", { x: "minha-senha-123" }, { confirm: async () => "yes" });
  await registry.execute("typer", { x: "outra-senha" });
  await registry.execute("typer", { x: 1 });
  await registry.execute("boom", {});
  await registry.execute("fantasma", { a: 1 });

  assert.deepEqual(entries.map((e) => e.outcome), ["ok", "denied", "invalid_params", "error", "unknown_tool"]);
  assert.ok(entries.every((e) => typeof e.ms === "number"));
  assert.equal(entries[0].input.x, "[oculto: 15 caracteres]");
  assert.ok(!JSON.stringify(entries).includes("minha-senha-123"));
  assert.ok(!JSON.stringify(entries).includes("outra-senha"));
});

test("ActionLog grava JSON Lines e não derruba o agente se não puder gravar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-test-"));
  try {
    const file = path.join(dir, "sub", "actions.jsonl");
    const log = new ActionLog(file);
    log.record({ tool: "a", outcome: "ok", detail: "x".repeat(2000) });
    log.record({ tool: "b", outcome: "error" });
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].tool, "a");
    assert.ok(lines[0].detail.length <= 501);
    assert.ok(lines[0].time);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // caminho impossível: um ARQUIVO no lugar da pasta
    const blocker = path.join(dir, "arquivo");
    fs.writeFileSync(blocker, "x");
    const broken = new ActionLog(path.join(blocker, "actions.jsonl"));
    const originalError = console.error;
    const warnings = [];
    console.error = (m) => warnings.push(m);
    try {
      assert.doesNotThrow(() => { broken.record({ a: 1 }); broken.record({ a: 2 }); });
    } finally {
      console.error = originalError;
    }
    assert.equal(warnings.length, 1); // avisa uma única vez
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
