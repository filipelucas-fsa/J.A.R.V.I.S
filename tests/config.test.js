import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConfigError, PROVIDERS, createModel, listAvailableModels, resolveModelConfig } from "../src/ai/index.js";
import { Model } from "../src/ai/model.js";
import { OpenAICompatibleModel } from "../src/ai/openaiCompatible.js";
import { createRuntime } from "../src/runtime.js";
import { startMockOpenAI, say } from "./helpers/mockOpenAI.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = (env) => resolveModelConfig(env);
const fails = (env, pattern) => assert.throws(() => cfg(env), (e) => e instanceof ConfigError && pattern.test(e.message), JSON.stringify(env));

test("padrão continua sendo Anthropic (compatível com o .env antigo)", () => {
  const c = cfg({ ANTHROPIC_API_KEY: "k" });
  assert.equal(c.provider, "anthropic");
  assert.equal(c.modelName, "claude-sonnet-5");
  assert.equal(c.vision, true);
  assert.equal(cfg({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-outro" }).modelName, "claude-outro");
  assert.equal(cfg({ ANTHROPIC_API_KEY: "k", MODEL_NAME: "novo" }).modelName, "novo");
  fails({}, /ANTHROPIC_API_KEY/);
  fails({ ANTHROPIC_API_KEY: "   " }, /ANTHROPIC_API_KEY/);
});

test("NVIDIA: endereço, chave e modelo (exemplo do .env)", () => {
  const c = cfg({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvapi-x", MODEL_NAME: "meta/llama-3.1-70b-instruct" });
  assert.equal(c.baseURL, "https://integrate.api.nvidia.com/v1");
  assert.equal(c.apiKey, "nvapi-x");
  assert.equal(c.kind, "openai");
  assert.equal(c.vision, false);
  assert.equal(c.maxTokensParam, "max_tokens");
  assert.equal(c.tools, true);
  fails({ MODEL_PROVIDER: "nvidia", MODEL_NAME: "x" }, /NVIDIA_API_KEY.*MODEL_API_KEY/);
  fails({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k" }, /MODEL_NAME.*npm run models/);
  assert.equal(cfg({ MODEL_PROVIDER: " NVIDIA ", NVIDIA_API_KEY: "k", MODEL_NAME: "m" }).provider, "nvidia");
});

test("MODEL_API_KEY vale para qualquer provedor e tem prioridade", () => {
  assert.equal(cfg({ MODEL_PROVIDER: "nvidia", MODEL_API_KEY: "generica", NVIDIA_API_KEY: "especifica", MODEL_NAME: "m" }).apiKey, "generica");
  assert.equal(cfg({ ANTHROPIC_API_KEY: "a", MODEL_API_KEY: "b" }).apiKey, "b");
});

test("OpenAI, Ollama (sem chave) e servidor compatível qualquer", () => {
  const openai = cfg({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k", MODEL_NAME: "gpt" });
  assert.equal(openai.baseURL, "https://api.openai.com/v1");
  assert.equal(openai.maxTokensParam, "max_completion_tokens");
  const ollama = cfg({ MODEL_PROVIDER: "ollama", MODEL_NAME: "llama3.1" });
  assert.equal(ollama.apiKey, undefined);
  assert.equal(ollama.baseURL, "http://localhost:11434/v1");
  const custom = cfg({ MODEL_PROVIDER: "openai-compatible", MODEL_BASE_URL: "http://localhost:1234/v1/", MODEL_NAME: "qualquer", MODEL_API_KEY: "k" });
  assert.equal(custom.baseURL, "http://localhost:1234/v1");
  fails({ MODEL_PROVIDER: "openai-compatible", MODEL_NAME: "m" }, /MODEL_BASE_URL/);
  assert.equal(cfg({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "m", MODEL_BASE_URL: "https://proxy.interno/v1" }).baseURL, "https://proxy.interno/v1");
});

test("valores inválidos dão mensagens claras", () => {
  const base = { MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "m" };
  fails({ MODEL_PROVIDER: "gemini-nativo", MODEL_API_KEY: "k" }, /desconhecido.*Válidos: anthropic, nvidia/);
  fails({ ...base, MODEL_BASE_URL: "não é url" }, /MODEL_BASE_URL inválida/);
  fails({ ...base, MODEL_BASE_URL: "ftp://x.com/v1" }, /MODEL_BASE_URL inválida/);
  fails({ ...base, MODEL_VISION: "talvez" }, /MODEL_VISION.*true ou false/);
  fails({ ...base, MODEL_TOOLS: "2" }, /MODEL_TOOLS/);
  fails({ ...base, MODEL_SYSTEM_MODE: "xyz" }, /MODEL_SYSTEM_MODE/);
  fails({ ...base, MODEL_MAX_TOKENS_PARAM: "tokens" }, /MODEL_MAX_TOKENS_PARAM/);
  fails({ ...base, MODEL_TIMEOUT_SECONDS: "0" }, /MODEL_TIMEOUT_SECONDS/);
  fails({ ...base, MODEL_TIMEOUT_SECONDS: "abc" }, /MODEL_TIMEOUT_SECONDS/);
  fails({ ...base, MODEL_MAX_RETRIES: "1.5" }, /MODEL_MAX_RETRIES.*inteiro/);
  fails({ ...base, MODEL_MAX_RETRIES: "99" }, /MODEL_MAX_RETRIES/);
  fails({ ...base, MODEL_MAX_RETRIES: "-1" }, /MODEL_MAX_RETRIES/);
});

test("opções: visão, ferramentas, modo do system, timeout e retentativas", () => {
  const c = cfg({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "m", MODEL_VISION: "TRUE", MODEL_TOOLS: "não", MODEL_SYSTEM_MODE: "INLINE", MODEL_TIMEOUT_SECONDS: "30", MODEL_MAX_RETRIES: "0" });
  assert.deepEqual([c.vision, c.tools, c.systemMode, c.timeoutMs, c.maxRetries], [true, false, "inline", 30000, 0]);
  const d = cfg({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "m" });
  assert.deepEqual([d.systemMode, d.timeoutMs, d.maxRetries], ["system", 120000, 2]);
});

test("createModel devolve a classe certa, com rótulo e capacidades", () => {
  const anthropic = createModel(cfg({ ANTHROPIC_API_KEY: "k" }));
  assert.ok(anthropic instanceof Model);
  assert.deepEqual(anthropic.capabilities, { vision: true, tools: true });
  const nvidia = createModel(cfg({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "meta/llama-3.1-70b-instruct", MODEL_VISION: "true" }));
  assert.ok(nvidia instanceof OpenAICompatibleModel);
  assert.equal(nvidia.label, "NVIDIA · meta/llama-3.1-70b-instruct");
  assert.equal(nvidia.capabilities.vision, true);
  for (const name of Object.keys(PROVIDERS)) assert.ok(PROVIDERS[name].kind && PROVIDERS[name].label, name);
});

test("listAvailableModels: servidor compatível e Anthropic (SDK)", async () => {
  const server = await startMockOpenAI({});
  try {
    const ids = await listAvailableModels(cfg({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvapi-test", MODEL_NAME: "m", MODEL_BASE_URL: server.url }));
    assert.deepEqual(ids, ["meta/llama-3.1-70b-instruct", "nvidia/nemotron-mini"]);
  } finally {
    await server.close();
  }

  const anthropicServer = http.createServer((req, res) => {
    res.writeHead(req.headers["x-api-key"] === "k" ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(req.headers["x-api-key"] === "k"
      ? { data: [{ id: "claude-b", type: "model" }, { id: "claude-a", type: "model" }], has_more: false, first_id: "claude-b", last_id: "claude-a" }
      : { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
  });
  await new Promise((resolve) => anthropicServer.listen(0, "127.0.0.1", resolve));
  const original = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropicServer.address().port}`;
  try {
    assert.deepEqual(await listAvailableModels(cfg({ ANTHROPIC_API_KEY: "k" })), ["claude-a", "claude-b"]);
    await assert.rejects(() => listAvailableModels(cfg({ ANTHROPIC_API_KEY: "errada" })), /Chave de API inválida/);
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = original;
    anthropicServer.closeAllConnections?.();
    await new Promise((resolve) => anthropicServer.close(resolve));
  }
});

// ===================== runtime =====================
async function runtimeEnv(extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-rt-"));
  return { dir, env: { ANTHROPIC_API_KEY: "k", WORKSPACE_DIR: dir, AGENT_LOG_FILE: path.join(dir, "..", `${path.basename(dir)}.jsonl`), ...extra }, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}
const NVIDIA = { MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvapi-x", MODEL_NAME: "meta/llama-3.1-70b-instruct", ANTHROPIC_API_KEY: undefined };

test("runtime: ferramentas padrão, e MODEL_TOOLS=false deixa o agente só conversar", async () => {
  const { env, cleanup } = await runtimeEnv(NVIDIA);
  try {
    const runtime = await createRuntime({ env });
    assert.deepEqual(runtime.enabled, ["read_file", "list_directory", "write_file", "edit_file"]);
    assert.equal(runtime.model.label, "NVIDIA · meta/llama-3.1-70b-instruct");
    const chatOnly = await createRuntime({ env: { ...env, MODEL_TOOLS: "false", TOOLS: "execute_command" } });
    assert.deepEqual(chatOnly.enabled, []);
    assert.equal(chatOnly.toolRegistry.list().length, 0);
  } finally {
    await cleanup();
  }
});

test("runtime: 'computer' exige modelo com visão (senão orienta MODEL_VISION=true)", async () => {
  const { env, cleanup } = await runtimeEnv(NVIDIA);
  const driver = async () => ({ getScreenInfo: async () => ({ width: 1, height: 1 }) });
  try {
    await assert.rejects(() => createRuntime({ env: { ...env, TOOLS: "read_file,computer" }, createDriver: driver }), (e) => e instanceof ConfigError && /exige um modelo com visão.*MODEL_VISION=true/.test(e.message));
    const ok = await createRuntime({ env: { ...env, TOOLS: "computer", MODEL_VISION: "true" }, createDriver: driver });
    assert.equal(ok.toolRegistry.list().length, 5);
    const anthropic = await createRuntime({ env: { ...env, MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", TOOLS: "computer" }, createDriver: driver });
    assert.equal(anthropic.toolRegistry.list().length, 5);
  } finally {
    await cleanup();
  }
});

test("runtime: erros de configuração viram ConfigError", async () => {
  const { env, cleanup } = await runtimeEnv();
  try {
    const bad = [
      [{ WORKSPACE_DIR: "/nao/existe/mesmo" }, /WORKSPACE_DIR inválido/],
      [{ MAX_STEPS: "0" }, /MAX_STEPS/],
      [{ MAX_STEPS: "abc" }, /MAX_STEPS/],
      [{ TOOLS: "read_file,voar" }, /Ferramenta desconhecida.*voar/],
      [{ ANTHROPIC_API_KEY: "" }, /ANTHROPIC_API_KEY/],
      [{ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k" }, /MODEL_NAME/],
    ];
    for (const [override, pattern] of bad) {
      await assert.rejects(() => createRuntime({ env: { ...env, ...override } }), (e) => e instanceof ConfigError && pattern.test(e.message), JSON.stringify(override));
    }
    await assert.rejects(() => createRuntime({ env: { ...env, TOOLS: "computer" }, createDriver: async () => { throw new Error("sem tela"); } }), /sem tela/);
  } finally {
    await cleanup();
  }
});

// ===================== programa completo com NVIDIA (servidor de teste) =====================
function runNode(args, env, input) {
  return new Promise((resolve) => {
    const clean = { ...process.env };
    for (const key of Object.keys(clean)) if (/^(ANTHROPIC_|MODEL_|NVIDIA_|OPENAI_|TOOLS$|WORKSPACE_DIR$|MAX_STEPS$|AGENT_LOG_FILE$)/.test(key)) delete clean[key];
    const child = spawn(process.execPath, args, { cwd: projectRoot, env: { ...clean, ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("programa: 'npm start' com NVIDIA de ponta a ponta (servidor de teste no lugar da NVIDIA)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-nv-"));
  await fs.writeFile(path.join(dir, "package.json"), '{"dependencies":{"foo":"1.0.0"}}');
  const server = await startMockOpenAI({ script: [say("Resposta vinda do modelo NVIDIA")] });
  try {
    const env = { MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvapi-test", MODEL_NAME: "meta/llama-3.1-70b-instruct", MODEL_BASE_URL: server.url, WORKSPACE_DIR: dir, AGENT_LOG_FILE: path.join(dir, "..", `${path.basename(dir)}.jsonl`) };
    const r = await runNode(["src/index.js", "olá"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Resposta vinda do modelo NVIDIA/);
    assert.match(r.stderr, /\[modelo\] NVIDIA · meta\/llama-3.1-70b-instruct/);
    assert.equal(server.posts()[0].body.model, "meta/llama-3.1-70b-instruct");

    const wrongKey = await runNode(["src/index.js", "olá"], { ...env, NVIDIA_API_KEY: "errada" });
    assert.equal(wrongKey.code, 1);
    assert.match(wrongKey.stderr, /Chave de API inválida.*NVIDIA/);

    const models = await runNode(["src/listModels.js", "nemotron"], env);
    assert.equal(models.code, 0, models.stderr);
    assert.equal(models.stdout.trim(), "nvidia/nemotron-mini");
    assert.match(models.stderr, /1 modelo/);

    const badModels = await runNode(["src/listModels.js"], { ...env, NVIDIA_API_KEY: "errada" });
    assert.equal(badModels.code, 2);
    const noConfig = await runNode(["src/listModels.js"], { MODEL_PROVIDER: "nvidia" });
    assert.equal(noConfig.code, 1);
    assert.match(noConfig.stderr, /NVIDIA_API_KEY/);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.join(dir, "..", `${path.basename(dir)}.jsonl`), { force: true });
  }
});

// =============== max_tokens, temperature, top_p, reasoning_budget ===============
test("MODEL_MAX_TOKENS, MODEL_TEMPERATURE, MODEL_TOP_P: padrão e configurados", () => {
  const base = { ANTHROPIC_API_KEY: "k" };
  const def = cfg(base);
  assert.equal(def.maxTokens, 4096);
  assert.equal(def.temperature, undefined);
  assert.equal(def.topP, undefined);

  const c = cfg({ ...base, MODEL_MAX_TOKENS: "65536", MODEL_TEMPERATURE: "0.6", MODEL_TOP_P: "0.95" });
  assert.equal(c.maxTokens, 65536);
  assert.equal(c.temperature, 0.6);
  assert.equal(c.topP, 0.95);
});

test("MODEL_REASONING_BUDGET: só vale para provedores no formato OpenAI/NIM", () => {
  const nvidia = cfg({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "m", MODEL_REASONING_BUDGET: "16384" });
  assert.equal(nvidia.reasoningBudget, 16384);
  fails({ ANTHROPIC_API_KEY: "k", MODEL_REASONING_BUDGET: "16384" }, /MODEL_REASONING_BUDGET.*formato OpenAI\/NIM.*não à Anthropic/);
});

test("valores inválidos dos novos parâmetros dão mensagens claras", () => {
  const base = { MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "m" };
  fails({ ...base, MODEL_MAX_TOKENS: "0" }, /MODEL_MAX_TOKENS/);
  fails({ ...base, MODEL_MAX_TOKENS: "1.5" }, /MODEL_MAX_TOKENS/);
  fails({ ...base, MODEL_MAX_TOKENS: "2000000" }, /MODEL_MAX_TOKENS/);
  fails({ ...base, MODEL_TEMPERATURE: "3" }, /MODEL_TEMPERATURE/);
  fails({ ...base, MODEL_TEMPERATURE: "-1" }, /MODEL_TEMPERATURE/);
  fails({ ...base, MODEL_TEMPERATURE: "abc" }, /MODEL_TEMPERATURE/);
  fails({ ...base, MODEL_TOP_P: "1.5" }, /MODEL_TOP_P/);
  fails({ ...base, MODEL_REASONING_BUDGET: "-1" }, /MODEL_REASONING_BUDGET/);
  fails({ ...base, MODEL_REASONING_BUDGET: "1.5" }, /MODEL_REASONING_BUDGET/);
});

test("createModel repassa os novos parâmetros para cada classe de modelo", () => {
  const anthropic = createModel(cfg({ ANTHROPIC_API_KEY: "k", MODEL_MAX_TOKENS: "8000", MODEL_TEMPERATURE: "0.5" }));
  assert.equal(anthropic.maxTokens, 8000);
  assert.equal(anthropic.temperature, 0.5);

  const nvidia = createModel(cfg({
    MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    MODEL_VISION: "true", MODEL_MAX_TOKENS: "65536", MODEL_TEMPERATURE: "0.6", MODEL_TOP_P: "0.95", MODEL_REASONING_BUDGET: "16384",
  }));
  assert.equal(nvidia.maxTokens, 65536);
  assert.equal(nvidia.temperature, 0.6);
  assert.equal(nvidia.topP, 0.95);
  assert.equal(nvidia.reasoningBudget, 16384);
  assert.equal(nvidia.capabilities.vision, true);
});
