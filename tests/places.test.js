// Testes da camada de lugares: provider (Google Places, Text Search New), ferramenta
// find_places e registro em TOOLS=places. Tudo com servidor local imitando o Google —
// nenhum custo, nenhuma chave real.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGooglePlacesProvider } from "../src/places/googlePlaces.js";
import { createPlacesTools } from "../src/tools/placesTools.js";
import { buildToolRegistry, DEFAULT_TOOLS, parseToolNames, TOOL_NAMES } from "../src/tools/index.js";
import { ConfigError } from "../src/ai/index.js";
import { createRuntime } from "../src/runtime.js";

// ===================== servidor que imita o Google Places =====================

const place = (overrides = {}) => ({
  displayName: { text: "Barbearia do Zé" },
  primaryTypeDisplayName: { text: "Barbearia" },
  formattedAddress: "Rua das Acácias, 123, Feira de Santana",
  nationalPhoneNumber: "+55 75 99999-0000",
  websiteUri: "https://barbeariadoze.com",
  rating: 4.6,
  userRatingCount: 120,
  googleMapsUri: "https://maps.app.goo.gl/exemplo",
  businessStatus: "OPERATIONAL",
  ...overrides,
});

async function startMockPlaces({ apiKey = "g-key-test", script = [] } = {}) {
  const requests = [];
  const queue = [...script];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(400, { error: { code: 400, message: "invalid JSON", status: "INVALID_ARGUMENT" } });
      }
      requests.push({ url: req.url, headers: req.headers, body });
      if (apiKey && req.headers["x-goog-api-key"] !== apiKey) {
        return send(403, { error: { code: 403, message: "API key not valid. Please pass a valid API key.", status: "PERMISSION_DENIED" } });
      }
      const step = queue.shift();
      if (!step) return send(500, { error: { code: 500, message: "mock: script esgotado", status: "INTERNAL" } });
      if (step.status) return send(step.status, step.body);
      send(200, step); // resposta de sucesso: { places: [...] }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    // O provider chama o endereço real do Google; o fetch injetado redireciona ao mock.
    fetchImpl: (url, init) => fetch(origin + new URL(url).pathname, init),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

async function withPlaces(serverOptions, fn) {
  const mock = await startMockPlaces(serverOptions);
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}

const provider = (mock, extra = {}) =>
  createGooglePlacesProvider({ apiKey: "g-key-test", fetchImpl: mock.fetchImpl, timeoutMs: 5000, ...extra });
const busca = (query) => [{ role: "user", content: query }];

// ===================== provider =====================

test("provider: requisição correta (chave no header, field mask, textQuery e limite)", async () => {
  await withPlaces({ script: [{ places: [place()] }] }, async (mock) => {
    const resultado = await provider(mock).searchPlaces({ query: "barbearias em Feira de Santana", maxResults: 7 });
    assert.equal(resultado.length, 1);

    const request = mock.requests[0];
    assert.equal(request.headers["x-goog-api-key"], "g-key-test", "chave vai no header, nunca na URL");
    assert.ok(request.headers["x-goog-fieldmask"].includes("places.websiteUri"), "field mask inclui o site");
    assert.ok(request.headers["x-goog-fieldmask"].includes("places.nationalPhoneNumber"));
    assert.equal(request.body.textQuery, "barbearias em Feira de Santana");
    assert.equal(request.body.maxResultCount, 7);
    assert.ok(!("key" in request.body), "chave não vai no corpo");
  });
});

test("provider: normaliza os campos (e campos ausentes viram vazio/null)", async () => {
  await withPlaces({ script: [{ places: [place(), {}] }] }, async (mock) => {
    const [completo, vazio] = await provider(mock).searchPlaces({ query: "padarias" });
    assert.deepEqual(
      { ...completo },
      {
        name: "Barbearia do Zé", category: "Barbearia", address: "Rua das Acácias, 123, Feira de Santana",
        phone: "+55 75 99999-0000", website: "https://barbeariadoze.com", rating: 4.6, reviews: 120,
        mapsUri: "https://maps.app.goo.gl/exemplo", status: "OPERATIONAL",
      }
    );
    assert.deepEqual({ ...vazio }, { name: "", category: "", address: "", phone: "", website: "", rating: null, reviews: null, mapsUri: "", status: "" });
  });
});

test("provider: validações de entrada e teto de resultados", async () => {
  await withPlaces({ script: [{ places: [] }, { places: [] }] }, async (mock) => {
    const p = provider(mock);
    await assert.rejects(() => p.searchPlaces({ query: "   " }), /busca não pode ser vazia/);
    await assert.rejects(() => p.searchPlaces({ query: "x".repeat(401) }), /longa demais/);
    await p.searchPlaces({ query: "ok", maxResults: 999 }); // teto aplica sem erro
    assert.equal(mock.requests.at(-1).body.maxResultCount, 10, "limitado a 10");
    await p.searchPlaces({ query: "ok", maxResults: 0 });
    assert.equal(mock.requests.at(-1).body.maxResultCount, 5, "valor inválido cai no padrão 5");
  });
});

test("provider: erros do Google viram mensagens acionáveis (sem vazar a chave)", async () => {
  const casos = [
    [403, { error: { code: 403, message: "API key not valid.", status: "PERMISSION_DENIED" } }, /Chave do Google Places inválida.*GOOGLE_PLACES_API_KEY/s],
    [429, { error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" } }, /Cota do Google Places atingida.*faturamento/s],
    [500, { error: { code: 500, message: "boom", status: "INTERNAL" } }, /Erro no servidor do Google Places/],
    [400, { error: { code: 400, message: "field mask?", status: "INVALID_ARGUMENT" } }, /recusada pelo Google \(400\)/],
  ];
  for (const [status, body, pattern] of casos) {
    await withPlaces({ script: [{ status, body }] }, async (mock) => {
      await assert.rejects(() => provider(mock).searchPlaces({ query: "q" }), (e) => pattern.test(e.message) && !e.message.includes("g-key-test"), JSON.stringify([status, body]));
    });
  }
});

test("provider: cancelamento (Ctrl+C) propaga sem erro confuso", async () => {
  await withPlaces({ script: [{ places: [] }] }, async (mock) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => provider(mock).searchPlaces({ query: "q", signal: controller.signal }), /cancelada/);
  });
});

test("provider: sem chave, recusa na hora", () => {
  assert.throws(() => createGooglePlacesProvider({}), /GOOGLE_PLACES_API_KEY/);
});

// ===================== ferramenta find_places =====================

test("ferramenta: lista formatada com sinais de lead (telefone/site ausentes explícitos)", async () => {
  await withPlaces({
    script: [{ places: [place(), place({ displayName: { text: "Padaria Ana" }, websiteUri: undefined, nationalPhoneNumber: undefined })] }],
  }, async (mock) => {
    const [findPlaces] = createPlacesTools({ apiKey: "g-key-test", fetchImpl: mock.fetchImpl });
    const texto = await findPlaces.execute({ query: "padarias", max_results: 2 }, {});

    assert.match(texto, /Estabelecimentos encontrados para "padarias"/);
    assert.match(texto, /1\. Barbearia do Zé/);
    assert.match(texto, /Website: https:\/\/barbeariadoze\.com/);
    assert.match(texto, /2\. Padaria Ana/);
    assert.match(texto, /Telefone: não encontrado/);
    assert.match(texto, /Website: não encontrado/);
    assert.match(texto, /Avaliação: 4\.6 \(120 avaliações\)/);
    assert.match(texto, /presença digital fraca/, "dica para o modelo analisar com web_search");
  });
});

test("ferramenta: status de fechado aparece; sem resultados orienta", async () => {
  await withPlaces({ script: [{ places: [place({ businessStatus: "CLOSED_TEMPORARILY" })] }] }, async (mock) => {
    const [findPlaces] = createPlacesTools({ apiKey: "g-key-test", fetchImpl: mock.fetchImpl });
    const texto = await findPlaces.execute({ query: "restaurantes" }, {});
    assert.match(texto, /Status: fechado temporariamente/);
    assert.ok(!texto.includes("funcionando"), "OPERATIONAL não ocupa espaço");
  });

  await withPlaces({ script: [{ places: [] }] }, async (mock) => {
    const [findPlaces] = createPlacesTools({ apiKey: "g-key-test", fetchImpl: mock.fetchImpl });
    const texto = await findPlaces.execute({ query: "fábricas de unicórnios" }, {});
    assert.match(texto, /não encontrou estabelecimentos/);
  });
});

test("ferramenta: erro do Google chega ao modelo com a mensagem clara", async () => {
  await withPlaces({ script: [{ status: 429, body: { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } } }] }, async (mock) => {
    const [findPlaces] = createPlacesTools({ apiKey: "g-key-test", fetchImpl: mock.fetchImpl });
    await assert.rejects(() => findPlaces.execute({ query: "q" }, {}), /Cota do Google Places/);
  });
});

// ===================== registro (TOOLS=places) =====================

test("parseToolNames aceita 'places'; o padrão segue sem places", () => {
  assert.deepEqual(parseToolNames("read_file,places"), ["read_file", "places"]);
  assert.ok(TOOL_NAMES.includes("places"));
  assert.ok(!DEFAULT_TOOLS.includes("places"), "ninguém ganha a ferramenta paga por acidente");
});

test("buildToolRegistry: places sem a fábrica (sem chave) dá erro claro", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "places-reg-"));
  try {
    await assert.rejects(
      () => buildToolRegistry({ workspaceDir: dir, enabled: ["read_file", "places"] }),
      /TOOLS=places exige GOOGLE_PLACES_API_KEY/
    );
    const registry = await buildToolRegistry({
      workspaceDir: dir,
      enabled: ["read_file", "places"],
      createPlacesTools: () => createPlacesTools({ apiKey: "k", fetchImpl: () => Promise.reject(new Error("nunca chamada")) }),
    });
    assert.deepEqual(registry.list().map((tool) => tool.name), ["read_file", "find_places"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runtime: TOOLS=places com chave registra find_places; sem chave, ConfigError na inicialização", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "places-rt-"));
  const envBase = {
    MODEL_PROVIDER: "nvidia",
    NVIDIA_API_KEY: "nvapi-x",
    MODEL_NAME: "meta/llama-3.1-70b-instruct",
    WORKSPACE_DIR: dir,
    AGENT_LOG_FILE: path.join(dir, "..", `${path.basename(dir)}.jsonl`),
  };
  try {
    const runtime = await createRuntime({ env: { ...envBase, TOOLS: "read_file,places", GOOGLE_PLACES_API_KEY: "g-key" } });
    assert.ok(runtime.enabled.includes("places"));
    assert.ok(runtime.toolRegistry.list().some((tool) => tool.name === "find_places"));

    await assert.rejects(
      () => createRuntime({ env: { ...envBase, TOOLS: "read_file,places" } }),
      (e) => e instanceof ConfigError && /GOOGLE_PLACES_API_KEY/.test(e.message)
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.join(dir, "..", `${path.basename(dir)}.jsonl`), { force: true });
  }
});
