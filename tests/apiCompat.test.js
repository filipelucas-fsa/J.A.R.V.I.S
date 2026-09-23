// Testes de compatibilidade: o SDK REAL fala com um servidor que aplica as regras rígidas da API.
// Se o agente enviar algo que a API real recusaria, o servidor devolve 400 e o teste falha.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.js";
import { Model, ModelError } from "../src/ai/model.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { buildToolRegistry } from "../src/tools/index.js";
import { startMockApi, reply, say, callTool, apiError, toolUse, text, pngSize } from "./helpers/mockApi.js";
import { makePng, fakeDriver } from "./helpers/fakeComputer.js";

const yes = async () => "yes";

// Sobe o servidor, roda o teste e sempre desliga o servidor.
async function withApi(options, fn) {
  const api = await startMockApi(options);
  try {
    return await fn(api);
  } finally {
    await api.close();
  }
}
const makeModel = (api, o = {}) => new Model({ apiKey: "test-key", modelName: "claude-teste", baseURL: api.url, maxRetries: 0, timeoutMs: 5000, ...o });
const userMessage = [{ role: "user", content: "oi" }];
const lastMessage = (api, n = 1) => api.requests.at(-n).body.messages.at(-1);
const countImages = (body) => JSON.stringify(body.messages).split('"type":"image"').length - 1;

async function fixtureWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-api-"));
  await fs.writeFile(path.join(dir, "package.json"), '{"name":"demo","dependencies":{"foo":"1.0.0"}}');
  return dir;
}
async function fullRegistry(ws, driver = fakeDriver()) {
  return buildToolRegistry({
    workspaceDir: ws,
    enabled: ["read_file", "list_directory", "write_file", "edit_file", "execute_command", "computer"],
    createDriver: async () => driver,
  });
}

// ===================== forma das requisições =====================
test("requisição: campos, cabeçalhos e definições de TODAS as ferramentas são aceitos pela API", async () => {
  const ws = await fixtureWorkspace();
  try {
    await withApi({ script: [say("oi!")] }, async (api) => {
      const registry = await fullRegistry(ws);
      const agent = new Agent({ model: makeModel(api), toolRegistry: registry, confirm: yes });
      assert.equal(await agent.run("olá"), "oi!");

      const { headers, body } = api.requests[0];
      assert.equal(headers["x-api-key"], "test-key");
      assert.ok(headers["anthropic-version"], "falta o cabeçalho anthropic-version");
      assert.match(headers["content-type"], /application\/json/);
      assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "system", "tools"]);
      assert.equal(body.model, "claude-teste");
      assert.equal(body.tools.length, 10);
      for (const tool of body.tools) {
        assert.deepEqual(Object.keys(tool).sort(), ["description", "input_schema", "name"], tool.name);
        assert.equal(tool.input_schema.type, "object");
        assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
      }
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("sem ferramentas o campo 'tools' nem é enviado", async () => {
  await withApi({ script: [say("ok")] }, async (api) => {
    await makeModel(api).ask(userMessage, {});
    assert.ok(!("tools" in api.requests[0].body));
    assert.ok(!("system" in api.requests[0].body));
  });
});

// ===================== fluxo completo =====================
test("fluxo completo: modelo pede read_file, agente executa, API aceita o histórico", async () => {
  const ws = await fixtureWorkspace();
  try {
    await withApi({ script: [callTool("toolu_01", "read_file", { path: "package.json" }), say("Dependência: foo")] }, async (api) => {
      const agent = new Agent({ model: makeModel(api), toolRegistry: await fullRegistry(ws), confirm: yes });
      assert.equal(await agent.run("Leia o package.json"), "Dependência: foo");
      assert.equal(api.requests.length, 2);
      const result = lastMessage(api).content[0];
      assert.equal(result.type, "tool_result");
      assert.equal(result.tool_use_id, "toolu_01");
      assert.match(result.content, /"foo":"1.0.0"/);
      assert.equal(api.remaining(), 0);
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("screenshot 4K: a imagem enviada cabe nos limites (sem redimensionamento automático da API)", async () => {
  const ws = await fixtureWorkspace();
  try {
    const driver = fakeDriver({ screen: { width: 1920, height: 1080 }, capture: { width: 3840, height: 2160 } });
    await withApi({ script: [callTool("toolu_01", "screenshot", {}), say("vi a tela")] }, async (api) => {
      const agent = new Agent({ model: makeModel(api), toolRegistry: await fullRegistry(ws, driver), confirm: yes });
      assert.equal(await agent.run("olhe a tela"), "vi a tela");
      const [, image] = lastMessage(api).content[0].content;
      const size = pngSize(Buffer.from(image.source.data, "base64"));
      assert.ok(Math.max(size.width, size.height) <= 1568 && size.width < 3840);
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("CONTROLE: um screenshot 4K sem redimensionar SERIA recusado com 400 (prova que o servidor é rígido)", async () => {
  await withApi({ script: [say("nunca chega")] }, async (api) => {
    const big = makePng(3840, 2160).toString("base64");
    const messages = [
      { role: "user", content: "olhe" },
      { role: "assistant", content: [toolUse("toolu_01", "screenshot", {})] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "shot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: big } }] }] },
    ];
    const tools = [{ name: "screenshot", description: "d", input_schema: { type: "object", properties: {} } }];
    await assert.rejects(() => makeModel(api).ask(messages, { tools }), (error) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.status, 400);
      assert.match(error.message, /Uma imagem \(screenshot\) ultrapassou os limites/);
      return true;
    });
  });
});

test("histórico com muitos screenshots: só os mais recentes seguem no contexto", async () => {
  const ws = await fixtureWorkspace();
  try {
    const script = [];
    for (const [i, key] of ["a", "b", "c"].entries()) {
      script.push(callTool(`toolu_s${i}`, "screenshot", {}), callTool(`toolu_k${i}`, "keyboard_press", { keys: [key] }));
    }
    script.push(callTool("toolu_s9", "screenshot", {}), say("fim"));
    await withApi({ script }, async (api) => {
      const agent = new Agent({ model: makeModel(api), toolRegistry: await fullRegistry(ws), confirm: yes, maxImagesInHistory: 2, maxSteps: 12 });
      assert.equal(await agent.run("x"), "fim");
      assert.equal(countImages(api.requests.at(-1).body), 2); // 4 capturas feitas, 2 mantidas
      assert.match(JSON.stringify(api.requests.at(-1).body), /screenshot antigo removido/);
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ===================== erros da API =====================
test("401: chave inválida gera mensagem clara e NÃO faz retentativas", async () => {
  await withApi({}, async (api) => {
    const model = new Model({ apiKey: "chave-errada", modelName: "m", baseURL: api.url, maxRetries: 2 });
    await assert.rejects(() => model.ask(userMessage), (error) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.status, 401);
      assert.equal(error.retryable, false);
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      return true;
    });
    assert.equal(api.requests.length, 0); // o servidor recusa antes de registrar; nenhuma repetição inútil
  });
});

test("404: modelo inexistente aponta para ANTHROPIC_MODEL e não repete", async () => {
  await withApi({ models: ["claude-real"] }, async (api) => {
    const model = makeModel(api, { modelName: "claude-inexistente", maxRetries: 2 });
    await assert.rejects(() => model.ask(userMessage), (error) => {
      assert.equal(error.status, 404);
      assert.match(error.message, /claude-inexistente/);
      assert.match(error.message, /ANTHROPIC_MODEL/);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(api.requests.length, 1);
  });
});

test("erros 4xx: cada código tem mensagem própria, dica útil e não é repetido", async () => {
  const cases = [
    [apiError(400, "invalid_request_error", "Your credit balance is too low to access the API"), /créditos|cobrança/i, false],
    [apiError(400, "invalid_request_error", "messages.3: tool_use ids were found without tool_result"), /histórico de ferramentas/i, false],
    [apiError(400, "invalid_request_error", "campo estranho"), /bug de compatibilidade/, false],
    [apiError(402, "billing_error", "billing"), /cobrança/i, false],
    [apiError(403, "permission_error", "no access to model"), /Sem permissão \(403\)/, false],
    [apiError(413, "request_too_large", "too large"), /grande demais/, false],
  ];
  for (const [step, pattern, retryable] of cases) {
    await withApi({ script: [step] }, async (api) => {
      await assert.rejects(() => makeModel(api, { maxRetries: 2 }).ask(userMessage), (error) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.status, step.status);
        assert.match(error.message, pattern);
        assert.equal(error.retryable, retryable);
        return true;
      });
      assert.equal(api.requests.length, 1, `não deveria repetir o ${step.status}`);
    });
  }
});

test("429 com retry-after: o SDK espera e tenta de novo até dar certo", async () => {
  await withApi({ script: [apiError(429, "rate_limit_error", "slow down", { "retry-after-ms": "10", "retry-after": "1" }), say("passou")] }, async (api) => {
    const result = await makeModel(api, { maxRetries: 2 }).ask(userMessage);
    assert.equal(result.text, "passou");
    assert.equal(api.requests.length, 2);
  });
});

test("429 persistente: erro temporário (retryable) com o tempo de espera na mensagem", async () => {
  await withApi({ script: [apiError(429, "rate_limit_error", "slow", { "retry-after": "30" })] }, async (api) => {
    await assert.rejects(() => makeModel(api).ask(userMessage), (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /Limite de uso\/taxa atingido \(429\).*30s/);
      return true;
    });
  });
});

test("529 sobrecarga: tenta de novo e depois informa como erro temporário", async () => {
  await withApi({ script: [apiError(529, "overloaded_error", "Overloaded"), apiError(529, "overloaded_error", "Overloaded")] }, async (api) => {
    await assert.rejects(() => makeModel(api, { maxRetries: 1 }).ask(userMessage), (error) => {
      assert.equal(error.status, 529);
      assert.equal(error.retryable, true);
      assert.match(error.message, /sobrecarregada/);
      return true;
    });
    assert.equal(api.requests.length, 2); // 1 tentativa + 1 nova
  });
});

test("500 seguido de sucesso: recuperação automática", async () => {
  await withApi({ script: [apiError(500, "api_error", "internal", { "retry-after-ms": "10" }), say("recuperou")] }, async (api) => {
    assert.equal((await makeModel(api, { maxRetries: 1 }).ask(userMessage)).text, "recuperou");
    assert.equal(api.requests.length, 2);
  });
});

test("504 e outros 5xx: mensagem de erro interno, marcados como temporários", async () => {
  await withApi({ script: [apiError(504, "timeout_error", "timeout")] }, async (api) => {
    await assert.rejects(() => makeModel(api).ask(userMessage), (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /Erro interno na API \(504\)/);
      return true;
    });
  });
});

test("erro 4xx desconhecido (ex.: 418) mantém a mensagem original da API", async () => {
  await withApi({ script: [apiError(418, "invalid_request_error", "sou um bule")] }, async (api) => {
    await assert.rejects(() => makeModel(api).ask(userMessage), (e) => /Erro da API \(418\): sou um bule/.test(e.message) && e.retryable === false);
  });
});

test("request id do erro aparece na mensagem (útil para suporte)", async () => {
  await withApi({ script: [apiError(500, "api_error", "x", { "request-id": "req_ABC123" })] }, async (api) => {
    await assert.rejects(() => makeModel(api).ask(userMessage), /req_ABC123/);
  });
});

// ===================== falhas de rede e respostas estranhas =====================
test("timeout: a API não responde", async () => {
  await withApi({ script: [{ hang: true }] }, async (api) => {
    const started = Date.now();
    await assert.rejects(() => makeModel(api, { timeoutMs: 300 }).ask(userMessage), (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /Tempo esgotado/);
      return true;
    });
    assert.ok(Date.now() - started < 3000);
  });
});

test("conexão recusada (servidor fora do ar)", async () => {
  const api = await startMockApi({});
  const model = makeModel(api);
  await api.close();
  await assert.rejects(() => model.ask(userMessage), (error) => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.retryable, true);
    assert.match(error.message, /conectar/);
    return true;
  });
});

test("conexão derrubada no meio da requisição", async () => {
  await withApi({ script: [{ destroy: true }] }, async (api) => {
    await assert.rejects(() => makeModel(api).ask(userMessage), (e) => e instanceof ModelError && e.retryable === true);
  });
});

test("resposta 200 que não é JSON ou não tem 'content' vira ModelError claro", async () => {
  await withApi({ script: [{ raw: "<html>proxy corporativo</html>" }] }, async (api) => {
    await assert.rejects(() => makeModel(api).ask(userMessage), (e) => e instanceof ModelError);
  });
  await withApi({ script: [{ raw: '{"foo": 1}' }] }, async (api) => {
    await assert.rejects(() => makeModel(api).ask(userMessage), /formato inesperado/);
  });
  await withApi({ script: [{ raw: "null" }] }, async (api) => {
    await assert.rejects(() => makeModel(api).ask(userMessage), (e) => e instanceof ModelError);
  });
});

// ===================== comportamentos estranhos do modelo =====================
async function runAgent(script, options = {}, check) {
  const { tools, agentOptions = {} } = options;
  // "confirm" ausente (undefined de propósito) é diferente de "não informado": o primeiro testa o padrão de negar.
  const confirm = "confirm" in options ? options.confirm : yes;
  const ws = await fixtureWorkspace();
  try {
    await withApi({ script }, async (api) => {
      const registry = tools ?? (await fullRegistry(ws));
      const agent = new Agent({ model: makeModel(api), toolRegistry: registry, confirm, ...agentOptions });
      await check({ api, agent, ws, registry });
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
}

test("modelo pede ferramenta inexistente: erro volta ao modelo e a conversa continua", async () => {
  await runAgent([callTool("toolu_01", "apagar_tudo", {}), say("entendi")], {}, async ({ api, agent }) => {
    assert.equal(await agent.run("x"), "entendi");
    const result = lastMessage(api).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /'apagar_tudo' não existe.*Disponíveis/);
  });
});

test("modelo envia parâmetros inválidos: is_error com explicação", async () => {
  await runAgent([callTool("toolu_01", "read_file", { path: 123, extra: true }), say("ok")], {}, async ({ api, agent }) => {
    await agent.run("x");
    const result = lastMessage(api).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /Parâmetros inválidos/);
  });
});

test("duas ferramentas no mesmo turno: uma mensagem com os dois resultados", async () => {
  const both = reply([text("vou fazer duas coisas"), toolUse("toolu_a", "list_directory", {}), toolUse("toolu_b", "read_file", { path: "package.json" })], "tool_use");
  await runAgent([both, say("feito")], {}, async ({ api, agent }) => {
    assert.equal(await agent.run("x"), "feito");
    const results = lastMessage(api).content;
    assert.deepEqual(results.map((r) => r.tool_use_id), ["toolu_a", "toolu_b"]);
    assert.match(results[0].content, /package.json/);
  });
});

test("blocos desconhecidos (thinking) são devolvidos intactos no histórico", async () => {
  const withThinking = reply(
    [{ type: "thinking", thinking: "hmm", signature: "assinatura-xyz" }, text("vou ler"), toolUse("toolu_01", "read_file", { path: "package.json" })],
    "tool_use"
  );
  await runAgent([withThinking, say("ok")], {}, async ({ api, agent }) => {
    assert.equal(await agent.run("x"), "ok");
    const echoed = api.requests[1].body.messages[1].content;
    assert.deepEqual(echoed[0], { type: "thinking", thinking: "hmm", signature: "assinatura-xyz" });
  });
});

test("resposta cortada por max_tokens no meio de um tool_use: NÃO executa e pede para refazer", async () => {
  const cut = reply([text("vou escrever"), toolUse("toolu_01", "write_file", { path: "grande.txt" })], "max_tokens");
  await runAgent([cut, say("refeito")], {}, async ({ api, agent, ws }) => {
    assert.equal(await agent.run("x"), "refeito");
    const result = lastMessage(api).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /cortada por limite de tokens/);
    assert.equal(await fs.access(path.join(ws, "grande.txt")).then(() => true, () => false), false);
  });
});

test("stop_reason 'max_tokens' na resposta final, 'refusal' e conteúdo vazio", async () => {
  await runAgent([reply([text("parte da resposta")], "max_tokens")], {}, async ({ agent }) => {
    const out = await agent.run("x");
    assert.match(out, /parte da resposta/);
    assert.match(out, /resposta cortada/);
  });
  await runAgent([reply([text("Não posso ajudar com isso.")], "refusal")], {}, async ({ agent }) => {
    assert.equal(await agent.run("x"), "Não posso ajudar com isso.");
  });
  await runAgent([reply([], "refusal")], {}, async ({ agent }) => {
    assert.match(await agent.run("x"), /recusou/);
  });
  await runAgent([reply([], "end_turn")], {}, async ({ agent }) => {
    assert.match(await agent.run("x"), /não retornou texto/);
  });
});

test("id de tool_use inválido: erro local claro, sem enviar histórico ruim à API", async () => {
  await runAgent([callTool("id inválido!", "read_file", { path: "package.json" })], {}, async ({ api, agent }) => {
    await assert.rejects(() => agent.run("x"), /Histórico de mensagens inválido.*id inválido/);
    assert.equal(api.requests.length, 1); // a resposta ruim foi recebida, mas nunca reenviada
  });
});

test("loop: mesma chamada falhando sem parar é interrompida após 5 repetições", async () => {
  const script = Array.from({ length: 8 }, (_, i) => callTool(`toolu_${i}`, "read_file", { path: "nao-existe.txt" }));
  await runAgent(script, {}, async ({ api, agent }) => {
    assert.match(await agent.run("x"), /repetiu a mesma ação 5 vezes/);
    assert.equal(api.requests.length, 5);
    assert.match(api.requests[3].body.messages.at(-1).content[0].content, /repetiu esta mesma chamada 3 vezes/);
  });
});

test("limite de passos", async () => {
  const script = Array.from({ length: 6 }, (_, i) => callTool(`toolu_${i}`, "read_file", { path: `arquivo${i}.txt` }));
  await runAgent(script, { agentOptions: { maxSteps: 3 } }, async ({ api, agent }) => {
    assert.match(await agent.run("x"), /Parei após 3 passos/);
    assert.equal(api.requests.length, 3);
  });
});

test("usuário NEGA uma escrita: modelo é avisado e o arquivo não existe", async () => {
  await runAgent([callTool("toolu_01", "write_file", { path: "novo.txt", content: "oi" }), say("ok, não escrevi")], { confirm: async () => "no" }, async ({ api, agent, ws }) => {
    assert.equal(await agent.run("x"), "ok, não escrevi");
    const result = lastMessage(api).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /NEGOU/);
    assert.equal(await fs.access(path.join(ws, "novo.txt")).then(() => true, () => false), false);
  });
});

test("agente SEM confirm nega ações perigosas por padrão", async () => {
  await runAgent([callTool("toolu_01", "execute_command", { command: "echo oi" }), say("ok")], { confirm: undefined }, async ({ api, agent }) => {
    await agent.run("x");
    assert.match(lastMessage(api).content[0].content, /NEGADA/);
  });
});

test("saídas gigantes e vazias são tratadas antes de enviar", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "gigante", description: "d", inputSchema: { type: "object", properties: {} }, execute: async () => "x".repeat(500_000) });
  registry.register({ name: "vazia", description: "d", inputSchema: { type: "object", properties: {} }, execute: async () => "" });
  registry.register({ name: "falha", description: "d", inputSchema: { type: "object", properties: {} }, execute: async () => { throw new Error(""); } });
  const script = [
    reply([toolUse("t1", "gigante", {}), toolUse("t2", "vazia", {}), toolUse("t3", "falha", {})], "tool_use"),
    say("ok"),
  ];
  await runAgent(script, { tools: registry }, async ({ api, agent }) => {
    assert.equal(await agent.run("x"), "ok");
    const [big, empty, failed] = lastMessage(api).content;
    assert.ok(big.content.length < 51_000);
    assert.match(big.content, /saída truncada/);
    assert.equal(empty.content, "(sem saída)");
    assert.equal(failed.is_error, true);
    assert.ok(failed.content.length > 0);
  });
});

// ===================== interrupção =====================
test("stop() durante a execução de uma ferramenta cancela e não faz nova requisição", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "lenta", description: "d", inputSchema: { type: "object", properties: {} },
    execute: (_input, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve("terminou"), 10_000);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelada")); });
    }),
  });
  await runAgent([callTool("toolu_01", "lenta", {}), say("nunca")], { tools: registry }, async ({ api, agent }) => {
    const running = agent.run("x");
    setTimeout(() => agent.stop(), 150);
    assert.match(await running, /interrompida pelo usuário/);
    assert.equal(api.requests.length, 1);
    assert.equal(api.remaining(), 1);
  });
});

test("stop() durante a espera pela API aborta a requisição", async () => {
  await runAgent([{ hang: true }], {}, async ({ agent }) => {
    const started = Date.now();
    const running = agent.run("x");
    setTimeout(() => agent.stop(), 150);
    assert.match(await running, /interrompida pelo usuário/);
    assert.ok(Date.now() - started < 3000);
  });
});

test("o agente pode ser reutilizado depois de um stop()", async () => {
  await runAgent([{ hang: true }, say("segunda tarefa ok")], {}, async ({ agent }) => {
    const first = agent.run("a");
    setTimeout(() => agent.stop(), 100);
    await first;
    assert.equal(await agent.run("b"), "segunda tarefa ok");
  });
});

test("temperature e top_p, quando configurados, são enviados à Anthropic (e omitidos quando não configurados)", async () => {
  await withApi({ script: [say("ok"), say("ok2")] }, async (api) => {
    await makeModel(api).ask(userMessage); // sem configurar: não deve enviar
    assert.ok(!("temperature" in api.requests[0].body));
    assert.ok(!("top_p" in api.requests[0].body));

    await makeModel(api, { temperature: 0.6, topP: 0.95 }).ask(userMessage);
    assert.equal(api.requests[1].body.temperature, 0.6);
    assert.equal(api.requests[1].body.top_p, 0.95);
  });
});
