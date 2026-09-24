import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCliConfirm } from "../src/cli/confirm.js";
import { parseToolNames, buildToolRegistry, DEFAULT_TOOLS, TOOL_NAMES } from "../src/tools/index.js";
import { createNutDriver } from "../src/computer/nutDriver.js";
import { startMockApi, callTool, say, apiError } from "./helpers/mockApi.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ===================== confirmação no terminal =====================
function fakeRl(answers) {
  const prompts = [];
  return {
    prompts,
    question: async (prompt) => {
      prompts.push(prompt);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
const ask = (confirm, allow = false) => confirm({ tool: "write_file", description: "linha 1\nlinha 2", allowSessionApproval: allow });
const quiet = { isInteractive: () => true, write: () => {} };

test("confirmação: só um 'sim' claro aprova; qualquer outra coisa nega", async () => {
  for (const yesAnswer of ["s", "sim", "y", "yes", "S", "  SIM  ", "Yes"]) {
    assert.equal(await ask(createCliConfirm(fakeRl([yesAnswer]), quiet)), "yes", yesAnswer);
  }
  for (const noAnswer of ["n", "não", "nao", "", "   ", "talvez", "ok", "claro", "sí", "1", "true", "todas"]) {
    assert.equal(await ask(createCliConfirm(fakeRl([noAnswer]), quiet)), "no", JSON.stringify(noAnswer));
  }
});

test("confirmação: 't' só vale quando a ferramenta permite aprovação de sessão", async () => {
  assert.equal(await ask(createCliConfirm(fakeRl(["t"]), quiet), true), "always");
  assert.equal(await ask(createCliConfirm(fakeRl(["todas"]), quiet), true), "always");
  assert.equal(await ask(createCliConfirm(fakeRl(["t"]), quiet), false), "no");
});

test("confirmação: mostra ferramenta e descrição e as opções corretas", async () => {
  const written = [];
  const rl = fakeRl(["n", "n"]);
  const confirm = createCliConfirm(rl, { isInteractive: () => true, write: (t) => written.push(t) });
  await ask(confirm, false);
  await ask(confirm, true);
  assert.match(written[0], /write_file/);
  assert.match(written[0], /   linha 1\n   linha 2/);
  assert.doesNotMatch(rl.prompts[0], /\[t\]odas/); // sem aprovação de sessão: a opção nem é oferecida
  assert.match(rl.prompts[1], /\[t\]odas/);
});

test("confirmação: sem terminal interativo nega SEM perguntar; erro do readline nega", async () => {
  const rl = fakeRl(["s"]);
  const confirm = createCliConfirm(rl, { isInteractive: () => false, write: () => {} });
  assert.equal(await ask(confirm), "no");
  assert.equal(rl.prompts.length, 0);

  assert.equal(await ask(createCliConfirm(fakeRl([new Error("readline closed")]), quiet)), "no");
});

test("confirmação: cancel() (Ctrl+C) solta uma pergunta pendente e nega", async () => {
  const rl = {
    question: (_prompt, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const confirm = createCliConfirm(rl, quiet);
  const pending = ask(confirm);
  setTimeout(() => confirm.cancel(), 50);
  assert.equal(await pending, "no");
  assert.doesNotThrow(() => confirm.cancel()); // sem pergunta pendente: não faz nada
});

// ===================== fábrica de ferramentas =====================
test("parseToolNames: padrão seguro, lista, espaços, duplicados e nomes inválidos", () => {
  for (const empty of [undefined, "", "   "]) assert.deepEqual(parseToolNames(empty), DEFAULT_TOOLS);
  assert.ok(!DEFAULT_TOOLS.includes("execute_command") && !DEFAULT_TOOLS.includes("computer"));
  assert.deepEqual(parseToolNames("read_file, edit_file ,read_file"), ["read_file", "edit_file"]);
  assert.deepEqual(parseToolNames(TOOL_NAMES.join(",")), TOOL_NAMES);
  assert.throws(() => parseToolNames("read_file,mouse"), /desconhecida.*'mouse'.*Válidas/);
  assert.throws(() => parseToolNames("READ_FILE"), /desconhecida/);
});

test("buildToolRegistry: só registra o que foi pedido; driver só é criado para 'computer'", async () => {
  let driverCalls = 0;
  const createDriver = async () => (driverCalls++, { getScreenInfo: async () => ({ width: 1, height: 1 }) });
  const basic = await buildToolRegistry({ workspaceDir: "/tmp", enabled: DEFAULT_TOOLS, createDriver });
  assert.deepEqual(basic.list().map((t) => t.name), DEFAULT_TOOLS);
  assert.equal(driverCalls, 0);

  const all = await buildToolRegistry({ workspaceDir: "/tmp", enabled: TOOL_NAMES, createDriver });
  assert.deepEqual(all.list().map((t) => t.name), ["read_file", "list_directory", "write_file", "edit_file", "execute_command", "screenshot", "mouse_move", "mouse_click", "keyboard_type", "keyboard_press", "web_search", "web_fetch"]);
  assert.equal(driverCalls, 1);

  const dangerousNames = ["write_file", "edit_file", "execute_command", "screenshot", "mouse_move", "mouse_click", "keyboard_type", "keyboard_press", "web_fetch"];
  for (const name of dangerousNames) assert.equal(all.get(name).requiresConfirmation, true, name);
  for (const name of ["read_file", "list_directory", "web_search"]) assert.ok(!all.get(name).requiresConfirmation, name);

  await assert.rejects(() => buildToolRegistry({ workspaceDir: "/tmp", enabled: ["computer"], createDriver: async () => { throw new Error("sem tela"); } }), /sem tela/);
});

test("driver real: sem ambiente gráfico dá erro claro em vez de derrubar o processo (segfault)", async (t) => {
  if (process.platform !== "linux") return t.skip("checagem específica de Linux");
  const saved = { d: process.env.DISPLAY, w: process.env.WAYLAND_DISPLAY };
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    await assert.rejects(() => createNutDriver(), /Sem ambiente gráfico/);
  } finally {
    if (saved.d !== undefined) process.env.DISPLAY = saved.d;
    if (saved.w !== undefined) process.env.WAYLAND_DISPLAY = saved.w;
  }
});

test("driver real: biblioteca opcional não instalada dá instrução de instalação", async (t) => {
  let installed = true;
  try { import.meta.resolve("@nut-tree-fork/nut-js"); } catch { installed = false; }
  if (installed) return t.skip("nut-js instalada aqui: não dá para testar a ausência com segurança");
  const saved = process.env.DISPLAY;
  process.env.DISPLAY = ":99";
  try {
    await assert.rejects(() => createNutDriver(), /npm install @nut-tree-fork\/nut-js/);
  } finally {
    if (saved === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = saved;
  }
});

// ===================== programa inteiro (processo real) =====================
function runCli({ args = ["tarefa"], env = {}, input, signalAfterMs }) {
  return new Promise((resolve) => {
    const clean = { ...process.env };
    for (const key of Object.keys(clean)) if (/^(ANTHROPIC_|MODEL_|NVIDIA_|OPENAI_|VOICE_|WAKE_|TOOLS$|WORKSPACE_DIR$|MAX_STEPS$|AGENT_LOG_FILE$|DISPLAY$|WAYLAND_DISPLAY$)/.test(key)) delete clean[key];
    const child = spawn(process.execPath, ["src/index.js", ...args], { cwd: projectRoot, env: { ...clean, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    if (input !== undefined) child.stdin.write(input);
    if (input !== undefined) child.stdin.end();
    if (signalAfterMs) setTimeout(() => child.kill("SIGINT"), signalAfterMs);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function cliFixture(script, extraEnv = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-"));
  await fs.writeFile(path.join(dir, "package.json"), '{"dependencies":{"foo":"1.0.0"}}');
  const api = await startMockApi({ script });
  const logFile = path.join(dir, "..", `${path.basename(dir)}-actions.jsonl`);
  const env = { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: api.url, WORKSPACE_DIR: dir, AGENT_LOG_FILE: logFile, ...extraEnv };
  const cleanup = async () => { await api.close(); await fs.rm(dir, { recursive: true, force: true }); await fs.rm(logFile, { force: true }); };
  const readLog = async () => (await fs.readFile(logFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { dir, api, env, cleanup, readLog };
}

test("programa: lê arquivo via ferramenta, imprime só a resposta em stdout e grava o log", async () => {
  const f = await cliFixture([callTool("toolu_01", "read_file", { path: "package.json" }), say("Dependência: foo")]);
  try {
    const r = await runCli({ env: f.env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "Dependência: foo");
    assert.match(r.stderr, /\[workspace\]/);
    assert.match(r.stderr, /\[ferramentas\] read_file, list_directory, write_file, edit_file/);
    const log = await f.readLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].tool, "read_file");
    assert.equal(log[0].outcome, "ok");
  } finally {
    await f.cleanup();
  }
});

test("programa: sem terminal interativo, escrita é NEGADA automaticamente e nada é criado", async () => {
  const f = await cliFixture([callTool("toolu_01", "write_file", { path: "novo.txt", content: "oi" }), say("não consegui escrever")]);
  try {
    const r = await runCli({ env: f.env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /ação negada automaticamente/);
    assert.equal(await fs.access(path.join(f.dir, "novo.txt")).then(() => true, () => false), false);
    assert.equal((await f.readLog())[0].outcome, "denied");
  } finally {
    await f.cleanup();
  }
});

test("programa: tarefa lida da entrada padrão", async () => {
  const f = await cliFixture([say("recebi pelo stdin")]);
  try {
    const r = await runCli({ args: [], env: f.env, input: "minha tarefa\n" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /recebi pelo stdin/);
    assert.equal(f.api.requests[0].body.messages[0].content, "minha tarefa");
  } finally {
    await f.cleanup();
  }
});

test("programa: configurações inválidas terminam com código 1 e mensagem clara, sem chamar a API", async () => {
  const f = await cliFixture([say("nunca")]);
  try {
    // 'computer' só é inválido quando o driver real não pode carregar (biblioteca ausente / sem ambiente gráfico).
    let nutInstalled = true;
    try { import.meta.resolve("@nut-tree-fork/nut-js"); } catch { nutInstalled = false; }
    const cases = [
      [{ ANTHROPIC_API_KEY: "" }, /ANTHROPIC_API_KEY/],
      [{ TOOLS: "read_file,mouse" }, /Ferramenta desconhecida.*mouse/],
      [{ MAX_STEPS: "abc" }, /MAX_STEPS/],
      [{ MAX_STEPS: "0" }, /MAX_STEPS/],
      [{ MAX_STEPS: "1.5" }, /MAX_STEPS/],
      [{ WORKSPACE_DIR: "/caminho/que/nao/existe" }, /WORKSPACE_DIR inválido/],
      [{ WORKSPACE_DIR: path.join(f.dir, "package.json") }, /WORKSPACE_DIR inválido/],
    ];
    if (!nutInstalled) cases.push([{ TOOLS: "computer" }, /ambiente gráfico|nut-js/]);
    for (const [override, pattern] of cases) {
      const r = await runCli({ env: { ...f.env, ...override } });
      assert.equal(r.code, 1, JSON.stringify(override));
      assert.match(r.stderr, pattern, JSON.stringify(override));
    }
    const noTask = await runCli({ args: [], env: f.env, input: "\n" });
    assert.equal(noTask.code, 1);
    assert.match(noTask.stderr, /nenhuma tarefa/);
    assert.equal(f.api.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("programa: erros da API chegam ao usuário com instrução (401 e 404)", async () => {
  const f = await cliFixture([], {});
  try {
    const wrongKey = await runCli({ env: { ...f.env, ANTHROPIC_API_KEY: "outra-chave" } });
    assert.equal(wrongKey.code, 1);
    assert.match(wrongKey.stderr, /Chave de API inválida.*ANTHROPIC_API_KEY/);
  } finally {
    await f.cleanup();
  }
  const g = await cliFixture([apiError(404, "not_found_error", "model: x")]);
  try {
    const r = await runCli({ env: { ...g.env, ANTHROPIC_MODEL: "modelo-fantasma" } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /modelo-fantasma.*ANTHROPIC_MODEL/);
  } finally {
    await g.cleanup();
  }
});

test("programa: Ctrl+C durante a espera pela API interrompe com calma (código 0)", async (t) => {
  if (process.platform === "win32") return t.skip("SIGINT via kill() não é equivalente no Windows");
  const f = await cliFixture([{ hang: true }]);
  try {
    const started = Date.now();
    const r = await runCli({ env: f.env, signalAfterMs: 700 });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /interrompida pelo usuário/);
    assert.match(r.stderr, /interrompendo/);
    assert.ok(Date.now() - started < 8000);
  } finally {
    await f.cleanup();
  }
});

test("programa: tentativa de ler .env é negada e o segredo nunca chega à API", async () => {
  const f = await cliFixture([callTool("toolu_01", "read_file", { path: ".env" }), say("ok")]);
  try {
    await fs.writeFile(path.join(f.dir, ".env"), "ANTHROPIC_API_KEY=SEGREDO-NUNCA-ENVIAR");
    const r = await runCli({ env: f.env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!JSON.stringify(f.api.requests).includes("SEGREDO-NUNCA-ENVIAR"));
    assert.match(JSON.stringify(f.api.requests[1].body.messages), /sensível/);
  } finally {
    await f.cleanup();
  }
});
