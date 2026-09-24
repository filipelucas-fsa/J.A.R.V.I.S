import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildOpenUrlCommand, createWebTools, isInternalHost, parseDdgResults, decodeEntities } from "../src/tools/webTools.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";

// Servidor HTTP local faz o papel de um site de verdade (redirecionamento, tipos, charset, truncamento).
// Por isso as ferramentas são criadas com allowInternalHosts: true AQUI — o padrão é recusar hosts internos.
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    switch (url.pathname) {
      case "/pagina":
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<html><head><title>Minha P&aacute;gina</title><style>.x{color:red}</style></head><body>" +
            '<script>var segredo = "isto nao pode vazar";</script>' +
            "<p>P&atilde;o & queijo &aacute; &#231;</p><p>Segundo</p><ul><li>Um</li><li>Dois</li></ul>" +
            "</body></html>",
        );
        break;
      case "/texto":
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Conteúdo simples 123");
        break;
      case "/pdf":
        res.setHeader("Content-Type", "application/pdf");
        res.end("%PDF-1.4 sim");
        break;
      case "/grande":
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body><p>${"a".repeat(60_000)}</p></body></html>`);
        break;
      case "/latin1":
        res.setHeader("Content-Type", "text/html; charset=iso-8859-1");
        res.end(Buffer.from("<html><body><p>Página com acentuação</p></body></html>", "latin1"));
        break;
      case "/redireciona":
        res.writeHead(302, { Location: "/pagina" });
        res.end();
        break;
      case "/erro404":
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>não achou</body></html>");
        break;
      case "/lento":
        break; // nunca responde: o timeout é quem encerra
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

function webTools(overrides = {}) {
  return createWebTools({ allowInternalHosts: true, ...overrides });
}

const searchTool = (tools) => tools.find((t) => t.name === "web_search");
const fetchTool = (tools) => tools.find((t) => t.name === "web_fetch");
const yes = async () => "yes";

function fakeResponse({ status = 200, contentType = "text/html; charset=utf-8", body = "", statusText = "" } = {}) {
  return {
    ok: status < 400,
    status,
    statusText,
    headers: new Map([["content-type", contentType]]),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body),
    body: null,
  };
}

// ---------- helpers ----------

test("decodeEntities: nomes comuns, numéricos e hexadecimais", () => {
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;"), '&<>"');
  assert.equal(decodeEntities("&aacute;&#231;&#x41;"), "áçA");
  assert.equal(decodeEntities("&desconhecida;"), "&desconhecida;");
});

test("isInternalHost: recusa localhost e redes internas, aceita nomes públicos", () => {
  for (const blocked of ["localhost", "servidor.local", "caixa.internal", "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.9.9", "100.64.1.1", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[ff02::1]"]) {
    assert.equal(isInternalHost(blocked), true, blocked);
  }
  for (const allowed of ["example.com", "fcbarcelona.com", "8.8.8.8", "172.32.0.1", "[2606:4700::1]"]) {
    assert.equal(isInternalHost(allowed), false, allowed);
  }
});

// ---------- web_fetch (servidor real) ----------

test("web_fetch: extrai título e texto, joga fora script/style e decodifica entidades", async () => {
  const out = await fetchTool(webTools()).execute({ url: `${base}/pagina` }, {});
  assert.match(out, /Título: Minha Página/);
  assert.match(out, /Pão & queijo á ç/);
  assert.match(out, /Segundo/);
  const lines = out.split("\n");
  assert.ok(lines.includes("Um") && lines.includes("Dois"), "itens de lista em linhas separadas");
  assert.ok(!out.includes("segredo"), "conteúdo de <script> não pode vazar");
  assert.ok(!out.includes("color:red"), "conteúdo de <style> não pode vazar");
  assert.ok(out.startsWith("Página: "));
});

test("web_fetch: texto puro passa direto, sem tratamento de HTML", async () => {
  const out = await fetchTool(webTools()).execute({ url: `${base}/texto` }, {});
  assert.match(out, /Conteúdo simples 123/);
  assert.ok(!out.includes("Título:"));
});

test("web_fetch: recusa tipos que não são texto (PDF e afins)", async () => {
  await assert.rejects(() => fetchTool(webTools()).execute({ url: `${base}/pdf` }, {}), /não parece ser texto|PDF/);
});

test("web_fetch: segue redirecionamento (302)", async () => {
  const out = await fetchTool(webTools()).execute({ url: `${base}/redireciona` }, {});
  assert.match(out, /Minha Página/);
});

test("web_fetch: charset iso-8859-1 decodifica acentos", async () => {
  const out = await fetchTool(webTools()).execute({ url: `${base}/latin1` }, {});
  assert.match(out, /Página com acentuação/);
});

test("web_fetch: página grande é truncada com aviso", async () => {
  const out = await fetchTool(webTools()).execute({ url: `${base}/grande` }, {});
  assert.match(out, /\[texto truncado: mostrando 30000 de 60000 caracteres\]/);
});

test("web_fetch: erro HTTP chega com o status", async () => {
  await assert.rejects(() => fetchTool(webTools()).execute({ url: `${base}/erro404` }, {}), /erro 404/);
});

test("web_fetch: tempo esgotado tem mensagem clara", async () => {
  await assert.rejects(
    () => fetchTool(webTools({ fetchTimeoutMs: 250 })).execute({ url: `${base}/lento` }, {}),
    /Tempo esgotado \(0s\) ao acessar/,
  );
});

// ---------- web_fetch: validação e SSRF (sem chegar à rede) ----------

test("web_fetch: protocolo que não é http(s) é recusado", async () => {
  for (const url of ["ftp://exemplo.com/arquivo", "file:///C:/Windows/system32.ini", "javascript:alert(1)"]) {
    await assert.rejects(() => fetchTool(webTools()).execute({ url }, {}), /Só é possível acessar http e https/);
  }
});

test("web_fetch: hosts internos são recusados ANTES de qualquer conexão (padrão de produção)", async () => {
  const boom = async () => {
    throw new Error("fetch não deveria ser chamado");
  };
  const tools = createWebTools({ fetchImpl: boom }); // sem allowInternalHosts
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  for (const url of [
    "http://localhost/api",
    "http://127.0.0.1:3000/painel",
    "http://10.0.0.5/privado",
    "http://192.168.0.1/router",
    "http://172.16.0.1/interno",
    "http://[::1]:8080/",
    "http://meu-pc.local/",
  ]) {
    const result = await registry.execute("web_fetch", { url }, { confirm: yes });
    assert.equal(result.ok, false, url);
    assert.match(result.error, /interno|recusado/, url);
    assert.ok(!result.error.includes("fetch não deveria"), `conexão indevida tentada: ${url}`);
  }
});

// ---------- confirmação (via registry, o caminho de produção) ----------

test("web_fetch: exige confirmação; 'always' vale para toda a sessão; pedido mostra a URL", async () => {
  const registry = new ToolRegistry();
  for (const tool of webTools()) registry.register(tool);

  const denied = await registry.execute("web_fetch", { url: `${base}/pagina` }); // sem confirm: negada
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);

  const asks = [];
  const confirm = async (request) => (asks.push(request), "always");
  const first = await registry.execute("web_fetch", { url: `${base}/pagina` }, { confirm });
  assert.equal(first.ok, true, first.error);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].allowSessionApproval, true);
  assert.match(asks[0].description, /Abrir a página/);

  const second = await registry.execute("web_fetch", { url: `${base}/texto` }, { confirm }); // aprovado na sessão
  assert.equal(second.ok, true);
  assert.equal(asks.length, 1, "segunda leitura não pode incomodar de novo");
});

test("web_search: é leitura, roda SEM confirmação (como read_file)", async () => {
  const registry = new ToolRegistry();
  for (const tool of webTools()) registry.register(tool);
  const result = await registry.execute("web_search", { query: "qualquer coisa", max_results: 1 }, {}); // sem confirm
  assert.equal(result.ok, true, result.error);
  assert.match(result.output, /DuckDuckGo/);
});

// ---------- web_search (fetch falso: parsing e erros) ----------

const DDG_HTML = `
  <div class="result"><h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fum&rut=abc">P&atilde;o de queijo especial</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fum&rut=abc">Resumo com <b>negrito</b> & entidade</a></div>
  <div class="result"><h2 class="result__title">
    <a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fexemplo.org%2Fdois&rut=def">Segundo resultado</a></h2>
    <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexemplo.org%2Fdois&rut=def">Resumo dois</a></div>
  <div class="result"><h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://exemplo.net/direto">Terceiro & final</a></h2>
    <a class="result__snippet" href="https://exemplo.net/direto">Resumo três</a></div>
`;

test("parseDdgResults: decodifica redirect uddg, entidades e limita quantidade", () => {
  const all = parseDdgResults(DDG_HTML, 10);
  assert.equal(all.length, 3);
  assert.equal(all[0].url, "https://exemplo.com/um");
  assert.equal(all[0].title, "Pão de queijo especial");
  assert.equal(all[0].snippet, "Resumo com negrito & entidade");
  assert.equal(all[1].url, "https://exemplo.org/dois");
  assert.equal(all[2].url, "https://exemplo.net/direto");
  assert.equal(all[2].title, "Terceiro & final");
  const limited = parseDdgResults(DDG_HTML, 2);
  assert.equal(limited.length, 2);
});

test("web_search: monta a lista numerada com a URL codificada e o User-Agent de navegador", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => (calls.push({ url, options }), fakeResponse({ body: DDG_HTML }));
  const out = await searchTool(webTools({ fetchImpl })).execute({ query: "pão de queijo", max_results: 5 }, {});

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://html.duckduckgo.com/html/?q="), "endpoint errado");
  assert.ok(calls[0].url.includes(encodeURIComponent("pão de queijo")), "query precisa ir codificada");
  assert.match(calls[0].options.headers["User-Agent"], /Mozilla/);

  assert.match(out, /Resultados da busca por "pão de queijo" \(DuckDuckGo\):/);
  assert.match(out, /1\. Pão de queijo especial\n\s+https:\/\/exemplo\.com\/um\n\s+Resumo com negrito & entidade/);
  assert.match(out, /3\. Terceiro & final/);
});

test("web_search: zero resultados devolve orientação, não erro", async () => {
  const fetchImpl = async () => fakeResponse({ body: "<html><body>nada aqui</body></html>" });
  const out = await searchTool(webTools({ fetchImpl })).execute({ query: "xyz" }, {});
  assert.match(out, /não encontrou resultados/);
});

test("web_search: bloqueio (403/429) avisa para esperar; outros status falham claro", async () => {
  const blocked = async () => fakeResponse({ status: 403 });
  await assert.rejects(() => searchTool(webTools({ fetchImpl: blocked })).execute({ query: "q" }, {}), /limitada pelo DuckDuckGo \(403\)/);
  const limited = async () => fakeResponse({ status: 429 });
  await assert.rejects(() => searchTool(webTools({ fetchImpl: limited })).execute({ query: "q" }, {}), /limitada pelo DuckDuckGo \(429\)/);
  const broken = async () => fakeResponse({ status: 500 });
  await assert.rejects(() => searchTool(webTools({ fetchImpl: broken })).execute({ query: "q" }, {}), /A busca falhou \(status 500\)/);
});

test("web_search: falha de rede e timeout têm mensagens claras", async () => {
  const dead = async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ENOTFOUND" };
    throw error;
  };
  await assert.rejects(() => searchTool(webTools({ fetchImpl: dead })).execute({ query: "q" }, {}), /ENOTFOUND/);

  const hanging = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  await assert.rejects(
    () => searchTool(webTools({ fetchImpl: hanging, searchTimeoutMs: 150 })).execute({ query: "q" }, {}),
    /Tempo esgotado \(0s\)/,
  );
});

// ---------- open_url (abrir abas sem confirmação) ----------

const urlTool = (tools) => tools.find((t) => t.name === "open_url");

function fakeChild() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    removeListener(event, fn) {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
    },
    unref() {},
    emit(event, arg) {
      for (const fn of listeners.get(event) ?? []) fn(arg);
    },
  };
}

test("open_url: NÃO exige confirmação (é como buscar: leitura simples)", () => {
  assert.ok(!urlTool(createWebTools()).requiresConfirmation);
});

test("open_url: comando de abertura por sistema (no Windows a URL vai entre aspas contra o '&')", () => {
  const win = buildOpenUrlCommand("win32", "https://exemplo.com/?a=1&b=2");
  assert.equal(win.command, "cmd.exe");
  assert.deepEqual(win.args, ["/c", "start", "", '"https://exemplo.com/?a=1&b=2"']);
  assert.equal(win.options.windowsVerbatimArguments, true, "aspas controladas por nós: o & não pode virar comando");

  assert.deepEqual(buildOpenUrlCommand("darwin", "https://exemplo.com"), { command: "open", args: ["https://exemplo.com"] });
  assert.deepEqual(buildOpenUrlCommand("linux", "https://exemplo.com"), { command: "xdg-open", args: ["https://exemplo.com"] });
  assert.deepEqual(buildOpenUrlCommand("plan9", "https://exemplo.com"), { command: "xdg-open", args: ["https://exemplo.com"] }, "SO desconhecido: xdg-open");
});

test("open_url: executa SEM confirm e devolve texto; só http(s) público passa", async () => {
  const spawned = [];
  const tools = webTools({
    platform: "linux",
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      const child = fakeChild();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);

  const r = await registry.execute("open_url", { url: "https://www.youtube.com" }, {}); // sem confirm
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /Abri https:\/\/www\.youtube\.com\//);
  assert.equal(spawned[0].command, "xdg-open");
  assert.deepEqual(spawned[0].args, ["https://www.youtube.com/"]);
  assert.equal(spawned[0].options.detached, true, "navegador desanexado do agente");

  // hosts internos e protocolos estranhos: bloqueados antes de qualquer spawn (padrão de produção)
  const bloqueado = createWebTools({ allowInternalHosts: false, spawnImpl: () => { throw new Error("não deveria spawnar"); } });
  const reg2 = new ToolRegistry();
  for (const tool of bloqueado) reg2.register(tool);
  assert.match((await reg2.execute("open_url", { url: "http://192.168.0.1/admin" })).error, /hosts internos/);
  assert.match((await reg2.execute("open_url", { url: "file:///C:/algo" })).error, /http e https/);
});

test("open_url: navegador que não abre vira mensagem clara", async () => {
  const tools = webTools({
    platform: "linux",
    spawnImpl: () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("error", { code: "ENOENT" }));
      return child;
    },
  });
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const r = await registry.execute("open_url", { url: "https://exemplo.com" }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /não foi possível abrir o navegador/i);
  assert.match(r.error, /xdg-utils/);
});
