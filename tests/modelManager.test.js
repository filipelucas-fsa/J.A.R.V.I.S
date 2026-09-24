// Testes do ModelManager: cadeia de modelos com fallback e cooldown.
// Os modelos falsos implementam a mesma interface ask() dos adaptadores reais; os testes
// de integração usam o servidor mock OpenAI (HTTP de verdade, sem gastar API).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isFallbackEligible, ModelManager } from "../src/ai/manager.js";
import { ConfigError, createModelManager, resolveModelChain } from "../src/ai/index.js";
import { ModelError } from "../src/ai/errors.js";
import { Agent } from "../src/agent/agent.js";
import { buildToolRegistry } from "../src/tools/index.js";
import { createRuntime } from "../src/runtime.js";
import { createClock } from "./helpers/fakeClock.js";
import { startMockOpenAI, say, openaiError } from "./helpers/mockOpenAI.js";

// ===================== ajudares =====================

function fakeModel({ label, ask, capabilities, disabled } = {}) {
  const calls = [];
  return {
    label: label ?? "Fake · modelo",
    capabilities: capabilities ?? { vision: false, tools: true },
    disabled: Boolean(disabled),
    calls,
    async ask(messages, options = {}) {
      calls.push({ messages, options });
      return ask(messages, options, calls.length);
    },
  };
}

const resposta = (text = "ok") => ({ text, stopReason: "end_turn", content: [{ type: "text", text }], toolCalls: [] });
const falha = (props = {}) => {
  throw new ModelError(props.message ?? "erro do modelo", props);
};
const userMessage = [{ role: "user", content: "oi" }];

function manager(models, { clock, cooldownSeconds = 60, cooldownMaxSeconds = 900, log = () => {} } = {}) {
  const entries = models.map((model) => ({ instance: model, config: {}, disabled: model.disabled }));
  return new ModelManager({ entries, cooldownSeconds, cooldownMaxSeconds, log, clock });
}
const pega = async (promise) => {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
};

// ===================== isFallbackEligible =====================

test("isFallbackEligible: temporários e 404 trocam de modelo; config/compat não trocam", () => {
  assert.equal(isFallbackEligible(new ModelError("429", { retryable: true, status: 429 })), true);
  assert.equal(isFallbackEligible(new ModelError("timeout", { retryable: true })), true);
  assert.equal(isFallbackEligible(new ModelError("404", { status: 404 })), true, "404 = modelo específico indisponível");
  assert.equal(isFallbackEligible(new ModelError("401", { status: 401 })), false);
  assert.equal(isFallbackEligible(new ModelError("400", { status: 400 })), false);
  assert.equal(isFallbackEligible(new ModelError("403", { status: 403 })), false);
  assert.equal(isFallbackEligible(new ModelError("413", { status: 413 })), false);
  assert.equal(isFallbackEligible(new Error("bug qualquer")), false);
  assert.equal(isFallbackEligible(new ModelError("cancelada", { message: "Requisição cancelada." })), false);
});

// ===================== ordem da cadeia =====================

test("primário responde: a reserva nunca é chamada e recebe as mesmas opções", async () => {
  const reservaNunca = fakeModel({ ask: () => resposta("reserva") });
  let recebido = null;
  const primario = fakeModel({ label: "NVIDIA · principal", ask: (messages, options) => { recebido = { messages, options }; return resposta("resposta do principal"); } });
  const m = manager([primario, reservaNunca]);

  const signal = new AbortController().signal;
  const resultado = await m.ask(userMessage, { system: "instruções", tools: [{ name: "x" }], signal });

  assert.equal(resultado.text, "resposta do principal");
  assert.equal(reservaNunca.calls.length, 0);
  assert.equal(recebido.options.system, "instruções");
  assert.equal(recebido.options.tools.length, 1);
  assert.equal(recebido.options.signal, signal);
  assert.deepEqual(m.status().map((s) => s.state), ["active", "active"]);
});

// ===================== fallback por tipo de erro =====================

test("429 no primário: reserva responde, primário entra em cooldown e é pulado", async () => {
  const clock = createClock();
  const primario = fakeModel({ label: "NVIDIA · principal", ask: () => falha({ status: 429, retryable: true, message: "Limite de uso/taxa atingido (429) em NVIDIA." }) });
  const reserva = fakeModel({ label: "NVIDIA · reserva", ask: () => resposta("da reserva") });
  const m = manager([primario, reserva], { clock });

  assert.equal((await m.ask(userMessage, {})).text, "da reserva");
  const status = m.status();
  assert.equal(status[0].state, "cooldown");
  assert.equal(status[0].cooldownSecondsLeft, 60);
  assert.equal(status[0].lastError, "Limite de uso/taxa atingido (429) em NVIDIA.");
  assert.equal(status[1].state, "active");

  // durante o cooldown a reserva atende sem incomodar o primário
  await m.ask(userMessage, {});
  assert.equal(primario.calls.length, 1);
  assert.equal(reserva.calls.length, 2);
});

test("cooldown expira: o primário volta ao topo da preferência", async () => {
  const clock = createClock();
  let falhar = true;
  const primario = fakeModel({ ask: () => (falhar ? falha({ status: 429, retryable: true }) : resposta("principal de volta")) });
  const reserva = fakeModel({ ask: () => resposta("reserva") });
  const m = manager([primario, reserva], { clock });

  await m.ask(userMessage, {}); // primário falha, reserva responde
  clock.advance(60_000); // cooldown de 60s expira
  falhar = false;
  assert.equal((await m.ask(userMessage, {})).text, "principal de volta");
  assert.equal(primario.calls.length, 2, "primário testado de novo primeiro");
});

test("cooldown exponencial: falhas seguidas dobram o descanso", async () => {
  const clock = createClock();
  const primario = fakeModel({ ask: () => falha({ status: 429, retryable: true }) });
  const reserva = fakeModel({ ask: () => resposta("reserva") });
  const m = manager([primario, reserva], { clock });

  await m.ask(userMessage, {});
  assert.equal(m.status()[0].cooldownSecondsLeft, 60); // 1ª falha: 60s

  clock.advance(60_000); // expira…
  await m.ask(userMessage, {}); // …e falha de novo
  assert.equal(m.status()[0].cooldownSecondsLeft, 120, "2ª falha seguida dobra");

  clock.advance(120_000);
  await m.ask(userMessage, {});
  assert.equal(m.status()[0].cooldownSecondsLeft, 240, "3ª dobra de novo");

  // sucesso da reserva zera o estado DELA, mas o primário continua em cooldown
  assert.equal(m.status()[1].state, "active");
});

test("retry-after do servidor tem prioridade sobre o cooldown padrão", async () => {
  const clock = createClock();
  const primario = fakeModel({ ask: () => falha({ status: 429, retryable: true, retryAfterMs: 5000 }) });
  const reserva = fakeModel({ ask: () => resposta("reserva") });
  const m = manager([primario, reserva], { clock });

  await m.ask(userMessage, {});
  assert.equal(m.status()[0].cooldownSecondsLeft, 5, "servidor pediu 5s");
});

test("MODEL_COOLDOWN_SECONDS=0 desliga o descanso", async () => {
  const clock = createClock();
  const primario = fakeModel({ ask: () => falha({ status: 429, retryable: true }) });
  const reserva = fakeModel({ ask: () => resposta("reserva") });
  const m = manager([primario, reserva], { clock, cooldownSeconds: 0 });

  await m.ask(userMessage, {});
  assert.equal(m.status()[0].state, "active", "sem cooldown: primário volta a ser tentado");
  await m.ask(userMessage, {});
  assert.equal(primario.calls.length, 2);
});

test("404: cai para a reserva com aviso no log", async () => {
  const logs = [];
  const primario = fakeModel({ label: "NVIDIA · principal", ask: () => falha({ status: 404, message: "Modelo ou endereço não encontrado (404) em NVIDIA." }) });
  const reserva = fakeModel({ ask: () => resposta("da reserva") });
  const m = manager([primario, reserva], { log: (line) => logs.push(line) });

  assert.equal((await m.ask(userMessage, {})).text, "da reserva");
  assert.ok(logs.some((line) => line.includes("NVIDIA · principal") && line.includes("modelo não disponível (404)")), logs.join("\n"));
  assert.equal(m.status()[0].state, "cooldown", "404 também dá descanso ao modelo");
});

test("401: falha imediata com o MESMO erro — reserva nem é consultada", async () => {
  const err401 = new ModelError("Chave de API inválida ou ausente (401) para NVIDIA. Confira a chave no .env.", { status: 401 });
  const primario = fakeModel({ ask: () => { throw err401; } });
  const reserva = fakeModel({ ask: () => resposta("reserva") });
  const m = manager([primario, reserva]);

  const { ok, error } = await pega(m.ask(userMessage, {}));
  assert.equal(ok, false);
  assert.strictEqual(error, err401, "mesmo objeto, mensagem intacta");
  assert.equal(reserva.calls.length, 0);
});

test("timeout (temporário sem status): cai para a reserva", async () => {
  const primario = fakeModel({ ask: () => falha({ retryable: true, message: "Tempo esgotado (120s) esperando NVIDIA." }) });
  const reserva = fakeModel({ ask: () => resposta("reserva") });
  const m = manager([primario, reserva]);

  assert.equal((await m.ask(userMessage, {})).text, "reserva");
  assert.equal(m.status()[0].lastError, "Tempo esgotado (120s) esperando NVIDIA.");
});

test("cancelamento (Ctrl+C): propaga na hora, sem fallback", async () => {
  const primario = fakeModel({ ask: (messages, options) => (options.signal?.aborted ? falha({ message: "Requisição cancelada." }) : resposta("lenta")) });
  const reserva = fakeModel({ ask: () => resposta("reserva") });
  const m = manager([primario, reserva]);

  const controller = new AbortController();
  controller.abort();
  const { ok, error } = await pega(m.ask(userMessage, { signal: controller.signal }));
  assert.equal(ok, false);
  assert.match(error.message, /cancelada/);
  assert.equal(primario.calls.length, 0);
  assert.equal(reserva.calls.length, 0);
});

test("erro inesperado (não é ModelError): propagado sem tratamento", async () => {
  const primario = fakeModel({ ask: () => { throw new TypeError("bug interno"); } });
  const m = manager([primario]);
  const { ok, error } = await pega(m.ask(userMessage, {}));
  assert.ok(error instanceof TypeError);
  assert.equal(ok, false);
});

// ===================== cadeia inteira =====================

test("todos falham: erro agregado menciona cada modelo tentado", async () => {
  const primario = fakeModel({ label: "NVIDIA · principal", ask: () => falha({ status: 429, retryable: true, message: "Limite de uso (429)." }) });
  const reserva = fakeModel({ label: "Ollama · reserva", ask: () => falha({ retryable: true, message: "Não foi possível conectar a Ollama." }) });
  const m = manager([primario, reserva]);

  const { ok, error } = await pega(m.ask(userMessage, {}));
  assert.equal(ok, false);
  assert.ok(error instanceof ModelError);
  assert.match(error.message, /Limite de uso \(429\)\./);
  assert.match(error.message, /Modelos reserva também falharam/);
  assert.match(error.message, /Ollama · reserva: Não foi possível conectar a Ollama\./);
  assert.equal(error.status, 429);
});

test("cadeia com um único modelo: o erro original é preservado (compatibilidade)", async () => {
  const err429 = new ModelError("Limite de uso/taxa atingido (429) em NVIDIA.", { status: 429, retryable: true });
  const primario = fakeModel({ ask: () => { throw err429; } });
  const m = manager([primario]);

  const { ok, error } = await pega(m.ask(userMessage, {}));
  assert.equal(ok, false);
  assert.strictEqual(error, err429, "mesmo objeto, sem resumo, sem mensagem nova");
});

test("todos em cooldown: melhor esforço — tenta na ordem de quem volta mais cedo", async () => {
  const clock = createClock();
  const ordem = [];
  const primario = fakeModel({ label: "NVIDIA · principal", ask: () => { ordem.push("principal"); return falha({ status: 429, retryable: true, retryAfterMs: 10_000 }); } });
  const reserva = fakeModel({ label: "NVIDIA · reserva", ask: () => { ordem.push("reserva"); return falha({ status: 429, retryable: true }); } });
  const m = manager([primario, reserva], { clock });

  await pega(m.ask(userMessage, {})); // ambos entram em cooldown (10s e 60s)
  assert.deepEqual(ordem, ["principal", "reserva"]);

  ordem.length = 0;
  const { ok, error } = await pega(m.ask(userMessage, {})); // melhor esforço: principal (volta primeiro) primeiro
  assert.deepEqual(ordem, ["principal", "reserva"], "tenta na ordem de quem volta mais cedo");
  assert.equal(primario.calls.length, 2);
  assert.equal(reserva.calls.length, 2);
  assert.equal(ok, false);
  assert.match(error.message, /Modelos reserva também falharam/, "falha agregada quando todos falham de novo");
});

test("entrada desativada é pulada; cadeia toda desativada avisa", async () => {
  const desativado = fakeModel({ ask: () => resposta("nunca") });
  const m = manager([{ ...desativado, disabled: true }]);
  const { ok, error } = await pega(m.ask(userMessage, {}));
  assert.equal(ok, false);
  assert.match(error.message, /Nenhum modelo disponível/);
  assert.equal(desativado.calls.length, 0);
});

// ===================== status, pick e label =====================

test("pick({vision}) seleciona por capacidade (só os disponíveis)", async () => {
  const clock = createClock();
  const comVisao = fakeModel({ label: "A · vision", capabilities: { vision: true, tools: true } });
  const semVisao = fakeModel({ label: "B · texto", capabilities: { vision: false, tools: true } });
  const m = manager([comVisao, semVisao], { clock });

  assert.deepEqual(m.pick({ vision: true }).map((i) => i.label), ["A · vision"]);
  assert.deepEqual(m.pick({ vision: false }).map((i) => i.label), ["B · texto"]);
  assert.deepEqual(m.pick().length, 2, "sem filtro: todos");
});

test("label: cadeia de 1 é idêntica ao adaptador; com reservas mostra o total", () => {
  const so = manager([fakeModel({ label: "NVIDIA · meta/llama-3.1-70b-instruct" })]);
  assert.equal(so.label, "NVIDIA · meta/llama-3.1-70b-instruct");
  const dois = manager([fakeModel({ label: "A" }), fakeModel({ label: "B" })]);
  assert.equal(dois.label, "A (+1 reserva)");
  const tres = manager([fakeModel({ label: "A" }), fakeModel({ label: "B" }), fakeModel({ label: "C" })]);
  assert.equal(tres.label, "A (+2 reservas)");
});

test("capacidades do manager vêm do modelo principal", () => {
  const m = manager([fakeModel({ capabilities: { vision: true, tools: false } }), fakeModel({})]);
  assert.deepEqual(m.capabilities, { vision: true, tools: false });
});

test("manager sem modelos recusa na construção", () => {
  assert.throws(() => new ModelManager({ entries: [] }), /pelo menos um modelo/);
});

// ===================== resolveModelChain (configuração) =====================

const chain = (env) => resolveModelChain(env);
const failsChain = (env, pattern) => assert.throws(() => chain(env), (e) => e instanceof ConfigError && pattern.test(e.message), JSON.stringify(env));
const NVIDIA_ENV = { MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvapi-x", MODEL_NAME: "meta/llama-3.1-70b-instruct" };

test("sem FALLBACK_MODELS: cadeia de um modelo, comportamento original", () => {
  const c = chain(NVIDIA_ENV);
  assert.equal(c.models.length, 1);
  assert.equal(c.models[0].modelName, "meta/llama-3.1-70b-instruct");
  assert.equal(c.cooldownSeconds, 60);
  assert.equal(c.cooldownMaxSeconds, 900);
  // FALLBACK_MODELS vazio conta como não definido
  assert.equal(chain({ ...NVIDIA_ENV, FALLBACK_MODELS: "  " }).models.length, 1);
});

test("FALLBACK_MODELS: monta a cadeia na ordem, com chaves e endereços certos", () => {
  const env = {
    ...NVIDIA_ENV,
    FALLBACK_MODELS: "nvidia:meta/llama-3.3-70b-instruct, ollama:llama3.1 ,anthropic:claude-sonnet-5",
    ANTHROPIC_API_KEY: "sk-x",
    MODEL_TIMEOUT_SECONDS: "30",
  };
  const c = chain(env);
  assert.equal(c.models.length, 4);

  const [principal, nvidia2, ollama, anthropic] = c.models;
  assert.equal(principal.provider, "nvidia");
  assert.equal(nvidia2.provider, "nvidia");
  assert.equal(nvidia2.modelName, "meta/llama-3.3-70b-instruct");
  assert.equal(nvidia2.apiKey, "nvapi-x");
  assert.equal(nvidia2.baseURL, "https://integrate.api.nvidia.com/v1");
  assert.equal(ollama.provider, "ollama");
  assert.equal(ollama.baseURL, "http://localhost:11434/v1");
  assert.equal(ollama.apiKey, undefined);
  assert.equal(anthropic.provider, "anthropic");
  assert.equal(anthropic.apiKey, "sk-x");
  assert.equal(anthropic.kind, "anthropic");
  assert.equal(anthropic.vision, true, "preset Anthropic aceita imagens");
  // ajustes globais herdados
  assert.equal(nvidia2.timeoutMs, 30_000);
  assert.equal(ollama.timeoutMs, 30_000);
});

test("reserva do mesmo provider usa o mesmo endereço do principal (NIM local/LM Studio)", () => {
  const c = chain({ ...NVIDIA_ENV, MODEL_BASE_URL: "http://localhost:8000/v1", FALLBACK_MODELS: "nvidia:nvidia/nemotron-mini" });
  assert.equal(c.models[1].baseURL, "http://localhost:8000/v1");
});

test("tags entre colchetes: [+vision] e [-tools]", () => {
  const c = chain({ ...NVIDIA_ENV, FALLBACK_MODELS: "nvidia:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning[+vision]" });
  assert.equal(c.models[1].vision, true);
  assert.equal(c.models[1].tools, true, "sem tag, tools é o padrão");
});

test("reserva repetida (igual ao principal ou duplicada) é ignorada", () => {
  const c = chain({ ...NVIDIA_ENV, FALLBACK_MODELS: "nvidia:meta/llama-3.1-70b-instruct, nvidia:meta/llama-3.1-70b-instruct, ollama:llama3.1" });
  assert.equal(c.models.length, 2, "primário + ollama");
});

test("configuração inválida da cadeia dá mensagens claras", () => {
  failsChain({ ...NVIDIA_ENV, FALLBACK_MODELS: "sem-dois-pontos" }, /FALLBACK_MODELS: entrada .* provider:modelo/);
  failsChain({ ...NVIDIA_ENV, FALLBACK_MODELS: "gemini:modelo" }, /FALLBACK_MODELS: provider 'gemini' desconhecido/);
  failsChain({ ...NVIDIA_ENV, FALLBACK_MODELS: "nvidia:" }, /não informa o nome do modelo/);
  failsChain({ ...NVIDIA_ENV, FALLBACK_MODELS: "nvidia:modelo[vision]" }, /tag 'vision' inválida/);
  failsChain({ ...NVIDIA_ENV, FALLBACK_MODELS: "nvidia:modelo[+vision" }, /não fecham com ']'/);
  failsChain({ ...NVIDIA_ENV, FALLBACK_MODELS: "openai:gpt-4o" }, /FALLBACK_MODELS: defina OPENAI_API_KEY/);
  failsChain({ ...NVIDIA_ENV, FALLBACK_MODELS: "nvidia:m[-tools]" }, /não aceita ferramentas.*MODEL_TOOLS=false/);
  failsChain({ ...NVIDIA_ENV, MODEL_COOLDOWN_SECONDS: "30", MODEL_COOLDOWN_MAX_SECONDS: "10" }, /MODEL_COOLDOWN_MAX_SECONDS deve ser maior ou igual/);
  failsChain({ ...NVIDIA_ENV, MODEL_COOLDOWN_SECONDS: "abc" }, /MODEL_COOLDOWN_SECONDS/);
});

test("primary sem ferramentas (MODEL_TOOLS=false) + reserva [-tools] é aceito", () => {
  const c = chain({ ...NVIDIA_ENV, MODEL_TOOLS: "false", FALLBACK_MODELS: "nvidia:m[-tools]" });
  assert.equal(c.models[0].tools, false);
  assert.equal(c.models[1].tools, false);
});

test("openai-compatible como reserva exige MODEL_BASE_URL; com ele, compartilha o servidor", () => {
  failsChain({ ...NVIDIA_ENV, FALLBACK_MODELS: "openai-compatible:qualquer" }, /openai-compatible precisa de MODEL_BASE_URL/);
  const c = chain({
    MODEL_PROVIDER: "openai-compatible",
    MODEL_BASE_URL: "http://localhost:1234/v1",
    MODEL_NAME: "qwen3",
    MODEL_API_KEY: "k",
    FALLBACK_MODELS: "openai-compatible:llama3.1",
  });
  assert.equal(c.models.length, 2);
  assert.equal(c.models[1].baseURL, "http://localhost:1234/v1");
  assert.equal(c.models[1].modelName, "llama3.1");
});

test("MODEL_COOLDOWN configurável (0 = desligado)", () => {
  const c = chain({ ...NVIDIA_ENV, MODEL_COOLDOWN_SECONDS: "0" });
  assert.equal(c.cooldownSeconds, 0);
  assert.equal(c.cooldownMaxSeconds, 900);
  const d = chain({ ...NVIDIA_ENV, MODEL_COOLDOWN_SECONDS: "5", MODEL_COOLDOWN_MAX_SECONDS: "30" });
  assert.deepEqual([d.cooldownSeconds, d.cooldownMaxSeconds], [5, 30]);
});

// ===================== createModelManager (fábrica) =====================

test("createModelManager: adaptores reais, label e aviso de visão", async () => {
  const logs = [];
  const c = chain({ ...NVIDIA_ENV, FALLBACK_MODELS: "nvidia:meta/llama-3.3-70b-instruct,ollama:llama3.1" });
  const m = createModelManager({
    models: c.models,
    cooldownSeconds: c.cooldownSeconds,
    cooldownMaxSeconds: c.cooldownMaxSeconds,
    requireVision: true, // simula TOOLS=computer: sem visão, todos desativados
    log: (line) => logs.push(line),
  });

  assert.equal(m.label, "NVIDIA · meta/llama-3.1-70b-instruct (+2 reservas)");
  assert.ok(m.status().every((s) => s.state === "disabled"));
  assert.ok(logs.some((line) => line.includes("desativada nesta sessão")), logs.join("\n"));
  const { ok, error } = await pega(m.ask(userMessage, {}));
  assert.equal(ok, false);
  assert.match(error.message, /Nenhum modelo disponível/);

  const semComputer = createModelManager({ models: c.models });
  assert.ok(semComputer.status().every((s) => s.state === "active"));
});

// ===================== integração: HTTP real (servidor mock no formato OpenAI) =====================

test("integração HTTP: 429 real no primário, reserva responde de verdade", async () => {
  const server = await startMockOpenAI({
    script: [openaiError(429, "rate limited", { "retry-after": "5" }), say("Resposta vinda da reserva")],
  });
  try {
    const env = {
      MODEL_PROVIDER: "nvidia",
      NVIDIA_API_KEY: "nvapi-test",
      MODEL_NAME: "meta/llama-3.1-70b-instruct",
      MODEL_BASE_URL: server.url,
      MODEL_MAX_RETRIES: "0", // sem retentativa interna: o teste exercita o FALLBACK, não o retry
      FALLBACK_MODELS: "nvidia:nvidia/nemotron-mini",
    };
    const c = chain(env);
    const m = createModelManager({ models: c.models, log: () => {} });

    const respostaObtida = await m.ask(userMessage, {});
    assert.equal(respostaObtida.text, "Resposta vinda da reserva");
    assert.equal(server.posts()[0].body.model, "meta/llama-3.1-70b-instruct", "1ª tentativa: primário");
    assert.equal(server.posts()[1].body.model, "nvidia/nemotron-mini", "2ª tentativa: reserva");
    assert.equal(m.status()[0].state, "cooldown");
    assert.equal(m.status()[0].cooldownSecondsLeft, 5, "honrou o retry-after: 5s do servidor");
    assert.equal(m.status()[1].state, "active");
  } finally {
    await server.close();
  }
});

// ===================== integração: Agent e runtime =====================

test("o Agent funciona com o manager no lugar do modelo (prova de compatibilidade)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mm-"));
  try {
    const registry = await buildToolRegistry({ workspaceDir: dir, enabled: [] });
    const primario = fakeModel({ ask: () => falha({ status: 429, retryable: true }) });
    const reserva = fakeModel({ ask: () => resposta("pronto, feito!") });
    const agent = new Agent({ model: manager([primario, reserva]), toolRegistry: registry, confirm: async () => "yes" });

    assert.equal(await agent.run("oi"), "pronto, feito!");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runtime: FALLBACK_MODELS monta a cadeia e o painel vê o label com reservas", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-rt-mm-"));
  try {
    const runtime = await createRuntime({
      env: {
        ...NVIDIA_ENV,
        WORKSPACE_DIR: dir,
        AGENT_LOG_FILE: path.join(dir, "..", `${path.basename(dir)}.jsonl`),
        FALLBACK_MODELS: "nvidia:meta/llama-3.3-70b-instruct",
      },
    });
    assert.equal(runtime.model.label, "NVIDIA · meta/llama-3.1-70b-instruct (+1 reserva)");
    assert.equal(runtime.modelChain.models.length, 2);
    assert.equal(runtime.modelConfig.modelName, "meta/llama-3.1-70b-instruct", "compat: modelConfig segue sendo o primário");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.join(dir, "..", `${path.basename(dir)}.jsonl`), { force: true });
  }
});
