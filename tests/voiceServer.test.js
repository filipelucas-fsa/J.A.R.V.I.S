import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPanelBridge } from "../src/voice/bridge.js";
import { SERVED_FILES, createVoiceServer } from "../src/voice/server.js";
import { TtsError } from "../src/voice/ttsProxy.js";

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "voice", "web");

// Requisição HTTP "crua": permite escolher Host, Origin e caminhos literais (o fetch normaliza e restringe cabeçalhos).
function raw(server, { method = "GET", path: url = "/", headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path: url, headers: { host: host ?? `127.0.0.1:${server.port}`, ...(payload !== undefined ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString("utf8"), json: () => JSON.parse(buffer.toString("utf8")) });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const JSON_HEADERS = { "content-type": "application/json" };

function fakeRunner(impl = async () => "resposta") {
  const runner = { calls: [], stops: 0, resets: 0, async run(text) { runner.calls.push(text); return impl(text, runner); }, stop() { runner.stops++; }, resetConversation() { runner.resets++; } };
  return runner;
}

async function start({ runner = fakeRunner(), bridge = createPanelBridge({ confirmTimeoutMs: 300 }), tts = null, config = { wakeWords: ["jarvis"], silenceMs: 10000 } } = {}) {
  const server = await createVoiceServer({ runner, bridge, tts, config });
  const login = async () => {
    const r = await raw(server, { path: `/?token=${server.token}` });
    return { cookie: r.headers["set-cookie"][0].split(";")[0], response: r };
  };
  return { server, runner, bridge, login };
}
async function withServer(options, fn) {
  const ctx = await start(options);
  try {
    const { cookie } = await ctx.login();
    return await fn({ ...ctx, cookie, auth: { cookie } });
  } finally {
    await ctx.server.close();
  }
}

// Cliente de eventos (SSE)
function openEvents(server, cookie) {
  const events = [];
  let request;
  const ready = new Promise((resolve, reject) => {
    request = http.get({ host: "127.0.0.1", port: server.port, path: "/api/events", headers: { host: `127.0.0.1:${server.port}`, cookie } }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name) events.push({ name, data: JSON.parse(data) });
        }
      });
      resolve(res);
    });
    request.on("error", reject);
  });
  const waitFor = async (predicate, timeoutMs = 3000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`evento não chegou. Recebidos: ${events.map((e) => e.name).join(", ")}`);
  };
  return { events, ready, waitFor, close: () => request.destroy() };
}

// ===================== acesso e cabeçalhos =====================
test("sem token ou com token errado: acesso negado; com o token certo: cookie seguro e redirecionamento", async () => {
  const { server, login } = await start();
  try {
    assert.equal((await raw(server, { path: "/" })).status, 401);
    assert.equal((await raw(server, { path: "/?token=errado" })).status, 401);
    assert.equal((await raw(server, { path: "/?token=" })).status, 401);
    assert.equal((await raw(server, { path: "/", headers: { cookie: "agent_sid=errado" } })).status, 401);

    const { response } = await login();
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, "/");
    const cookie = response.headers["set-cookie"][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.ok(!cookie.includes("Domain="));
  } finally {
    await server.close();
  }
});

test("token: longo, aleatório e diferente a cada servidor", async () => {
  const a = await start();
  const b = await start();
  try {
    assert.match(a.server.token, /^[0-9a-f]{48}$/);
    assert.notEqual(a.server.token, b.server.token);
    assert.equal(a.server.url, `http://127.0.0.1:${a.server.port}/?token=${a.server.token}`);
  } finally {
    await a.server.close();
    await b.server.close();
  }
});

test("página principal: HTML do painel com cabeçalhos de segurança e sem CORS", async () => {
  await withServer({}, async ({ server, auth }) => {
    const r = await raw(server, { path: "/", headers: auth });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.equal(r.text, await fs.readFile(path.join(webDir, "index.html"), "utf8"));
    const csp = r.headers["content-security-policy"];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /media-src 'self' blob:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["cache-control"], "no-store");
    for (const p of ["/", "/api/config", "/static/boot.js"]) {
      const x = await raw(server, { path: p, headers: auth });
      assert.equal(x.headers["access-control-allow-origin"], undefined, p);
    }
  });
});

test("o HTML não usa scripts nem estilos inline (compatível com a CSP)", async () => {
  const html = await fs.readFile(path.join(webDir, "index.html"), "utf8");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "script inline");
  assert.ok(!/\sstyle="/i.test(html), "atributo style inline");
  assert.ok(!/\son[a-z]+="/i.test(html), "manipulador inline (onclick...)");
  assert.ok(!/https?:\/\//i.test(html), "recurso externo");
  const css = await fs.readFile(path.join(webDir, "style.css"), "utf8");
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(css), "CSS carrega recurso externo");
});

test("DNS rebinding: Host desconhecido é recusado", async () => {
  await withServer({}, async ({ server, auth }) => {
    for (const host of ["evil.com", `evil.com:${server.port}`, "127.0.0.1", `192.168.0.5:${server.port}`, `127.0.0.1.evil.com:${server.port}`]) {
      const r = await raw(server, { path: "/api/config", headers: auth, host });
      assert.equal(r.status, 403, host);
    }
    assert.equal((await raw(server, { path: "/api/config", headers: auth, host: `localhost:${server.port}` })).status, 200);
  });
});

test("requisições de outros sites (Origin / Sec-Fetch-Site) são recusadas, mesmo com cookie", async () => {
  await withServer({}, async ({ server, auth }) => {
    const evil = { ...auth, ...JSON_HEADERS, origin: "http://evil.com" };
    assert.equal((await raw(server, { method: "POST", path: "/api/message", headers: evil, body: { text: "apague tudo" } })).status, 403);
    assert.equal((await raw(server, { path: "/api/config", headers: { ...auth, origin: "https://evil.com" } })).status, 403);
    assert.equal((await raw(server, { path: "/api/config", headers: { ...auth, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await raw(server, { path: "/api/config", headers: { ...auth, "sec-fetch-site": "same-site" } })).status, 403);
    const ok = { ...auth, ...JSON_HEADERS, origin: `http://127.0.0.1:${server.port}`, "sec-fetch-site": "same-origin" };
    assert.equal((await raw(server, { method: "POST", path: "/api/message", headers: ok, body: { text: "oi" } })).status, 202);
    assert.equal((await raw(server, { path: "/api/config", headers: { ...auth, "sec-fetch-site": "none" } })).status, 200);
  });
});

test("toda a API exige o cookie", async () => {
  const { server, runner } = await start();
  try {
    const endpoints = [["GET", "/api/config"], ["GET", "/api/events"], ["POST", "/api/message"], ["POST", "/api/confirm"], ["POST", "/api/stop"], ["POST", "/api/reset"], ["POST", "/api/tts"], ["GET", "/static/boot.js"]];
    for (const [method, p] of endpoints) {
      const r = await raw(server, { method, path: p, headers: JSON_HEADERS, body: method === "POST" ? { text: "x", id: "a", decision: "yes" } : undefined });
      assert.equal(r.status, 401, `${method} ${p}`);
    }
    assert.deepEqual(runner.calls, []);
    assert.equal(runner.stops + runner.resets, 0);
  } finally {
    await server.close();
  }
});

// ===================== arquivos estáticos =====================
test("estáticos: só a lista fixa é servida, com o tipo certo", async () => {
  await withServer({}, async ({ server, auth }) => {
    for (const [name, type] of [["style.css", /text\/css/], ["boot.js", /javascript/], ["panel.js", /javascript/], ["voiceController.js", /javascript/], ["wakeWord.js", /javascript/], ["browserRecognizer.js", /javascript/], ["speech.js", /javascript/], ["voiceOutput.js", /javascript/]]) {
      const r = await raw(server, { path: `/static/${name}`, headers: auth });
      assert.equal(r.status, 200, name);
      assert.match(r.headers["content-type"], type, name);
      assert.equal(r.text, await fs.readFile(path.join(webDir, name), "utf8"));
    }
  });
});

test("estáticos: caminhos maliciosos e arquivos fora da lista dão 404", async () => {
  await withServer({}, async ({ server, auth }) => {
    for (const p of ["/static/../../package.json", "/static/..%2f..%2fpackage.json", "/static/%2e%2e/%2e%2e/package.json", "/static/index.html", "/static/.env", "/static/", "/static/nao-existe.js", "/static/panel.js/../../../etc/passwd", "/static/constructor", "/static/__proto__", "/static/toString", "/nao-existe", "/static"]) {
      const r = await raw(server, { path: p, headers: auth });
      assert.equal(r.status, 404, p);
      assert.ok(!r.text.includes("dependencies"), p);
    }
  });
});

test("todos os módulos que o painel importa estão na lista de estáticos (nada 404 no navegador)", async () => {
  const served = new Set(SERVED_FILES);
  const files = (await fs.readdir(webDir)).filter((f) => f.endsWith(".js"));
  for (const extra of ["style.css"]) assert.ok(served.has(extra), extra);
  for (const f of files) {
    assert.ok(served.has(f), `${f} existe em web/ mas não é servido`);
    const source = await fs.readFile(path.join(webDir, f), "utf8");
    for (const m of source.matchAll(/from "\.\/([^"]+)"/g)) assert.ok(served.has(m[1]), `${f} importa ${m[1]}, que não é servido`);
  }
  await withServer({}, async ({ server, auth }) => {
    for (const name of served) assert.equal((await raw(server, { path: `/static/${name}`, headers: auth })).status, 200, name);
  });
});

// ===================== validação das requisições =====================
test("POST: tipo de conteúdo, JSON inválido, corpo grande e rotas desconhecidas", async () => {
  await withServer({}, async ({ server, auth, runner }) => {
    const post = (p, headers, body) => raw(server, { method: "POST", path: p, headers: { ...auth, ...headers }, body });
    assert.equal((await post("/api/message", { "content-type": "text/plain" }, "text=oi")).status, 415);
    assert.equal((await post("/api/message", { "content-type": "application/x-www-form-urlencoded" }, "text=oi")).status, 415);
    assert.equal((await post("/api/message", JSON_HEADERS, "{não é json")).status, 400);
    assert.equal((await post("/api/message", JSON_HEADERS, "[1,2]")).status, 400);
    assert.equal((await post("/api/message", JSON_HEADERS, "null")).status, 400);
    assert.equal((await post("/api/message", JSON_HEADERS, { text: "x".repeat(70_000) })).status, 413);
    assert.equal((await post("/api/message", JSON_HEADERS, { text: "" })).status, 400);
    assert.equal((await post("/api/message", JSON_HEADERS, { text: "   " })).status, 400);
    assert.equal((await post("/api/message", JSON_HEADERS, { text: 42 })).status, 400);
    assert.equal((await post("/api/message", JSON_HEADERS, {})).status, 400);
    assert.equal((await post("/api/message", JSON_HEADERS, { text: "x".repeat(4001) })).status, 413);
    assert.equal((await post("/api/naoexiste", JSON_HEADERS, {})).status, 404);
    assert.equal((await raw(server, { path: "/api/message", headers: auth })).status, 404); // GET numa rota POST
    assert.equal((await raw(server, { method: "PUT", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: {} })).status, 404);
    assert.equal((await raw(server, { method: "DELETE", path: "/api/message", headers: auth })).status, 404);
    assert.deepEqual(runner.calls, []);
  });
});

test("/api/config entrega a configuração ao painel", async () => {
  const config = { title: "J.A.R.V.I.S.", wakeWords: ["jarvis", "batman"], silenceMs: 10000, tts: { engine: "browser" } };
  await withServer({ config }, async ({ server, auth }) => {
    assert.deepEqual((await raw(server, { path: "/api/config", headers: auth })).json(), config);
  });
});

// ===================== fluxo de mensagens (SSE) =====================
test("mensagem: 202, eventos status/answer/status pelo SSE, e a tarefa chega ao agente", async () => {
  await withServer({ runner: fakeRunner(async () => "Feito, senhor.") }, async ({ server, auth, runner, cookie }) => {
    const sse = openEvents(server, cookie);
    await sse.ready;
    await sse.waitFor((e) => e.name === "hello");
    const r = await raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text: "  abra a pasta  " } });
    assert.equal(r.status, 202);
    await sse.waitFor((e) => e.name === "answer");
    await sse.waitFor((e) => e.name === "status" && e.data.busy === false);
    assert.deepEqual(runner.calls, ["abra a pasta"]);
    assert.deepEqual(sse.events.map((e) => e.name), ["hello", "status", "answer", "status"]);
    assert.equal(sse.events.find((e) => e.name === "answer").data.text, "Feito, senhor.");
    sse.close();
  });
});

test("enquanto trabalha, nova mensagem dá 409; depois de terminar, volta a aceitar", async () => {
  let release;
  const runner = fakeRunner(() => new Promise((resolve) => { release = () => resolve("ok"); }));
  await withServer({ runner }, async ({ server, auth, cookie }) => {
    const sse = openEvents(server, cookie);
    await sse.ready;
    const send = (text) => raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text } });
    assert.equal((await send("primeira")).status, 202);
    assert.equal((await send("segunda")).status, 409);
    assert.equal((await raw(server, { method: "POST", path: "/api/reset", headers: { ...auth, ...JSON_HEADERS }, body: {} })).status, 409);
    assert.equal(runner.resets, 0);
    release();
    await sse.waitFor((e) => e.name === "status" && e.data.busy === false);
    assert.equal((await send("terceira")).status, 202);
    release();
    assert.deepEqual(runner.calls, ["primeira", "terceira"]);
    sse.close();
  });
});

test("erro do agente chega ao painel como evento 'error' e libera para a próxima tarefa", async () => {
  const runner = fakeRunner(async (text) => { if (text === "quebra") throw new Error("Chave de API inválida (401)"); return "ok"; });
  await withServer({ runner }, async ({ server, auth, cookie }) => {
    const sse = openEvents(server, cookie);
    await sse.ready;
    const send = (text) => raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text } });
    await send("quebra");
    assert.equal((await sse.waitFor((e) => e.name === "error")).data.message, "Chave de API inválida (401)");
    await sse.waitFor((e) => e.name === "status" && e.data.busy === false);
    assert.equal((await send("normal")).status, 202);
    await sse.waitFor((e) => e.name === "answer");
    sse.close();
  });
});

test("runner que lança de forma síncrona não derruba o servidor", async () => {
  const runner = { run() { throw new Error("explodiu"); }, stop() {} };
  await withServer({ runner }, async ({ server, auth, cookie }) => {
    const sse = openEvents(server, cookie);
    await sse.ready;
    assert.equal((await raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text: "x" } })).status, 202);
    assert.equal((await sse.waitFor((e) => e.name === "error")).data.message, "explodiu");
    assert.equal((await raw(server, { path: "/api/config", headers: auth })).status, 200);
    sse.close();
  });
});

test("dois painéis abertos recebem os mesmos eventos; fechar um não afeta o outro", async () => {
  await withServer({}, async ({ server, auth, cookie }) => {
    const a = openEvents(server, cookie);
    const b = openEvents(server, cookie);
    await Promise.all([a.ready, b.ready]);
    a.close();
    await raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text: "x" } });
    await b.waitFor((e) => e.name === "answer");
    b.close();
  });
});

test("nova mensagem pode ser enviada sem nenhum painel com SSE aberto (o agente responde e libera)", async () => {
  await withServer({}, async ({ server, auth, runner }) => {
    assert.equal((await raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text: "x" } })).status, 202);
    for (let i = 0; i < 50 && server.isBusy(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(server.isBusy(), false);
    assert.deepEqual(runner.calls, ["x"]);
  });
});

// ===================== confirmações, parar, reiniciar =====================
test("CONFIRMAÇÃO ponta a ponta: o agente pergunta, o painel mostra, o clique responde", async () => {
  let decision;
  const bridge = createPanelBridge({ confirmTimeoutMs: 5000 });
  const runner = fakeRunner(async () => {
    decision = await bridge.confirm({ tool: "write_file", description: "Criar a.txt", allowSessionApproval: false });
    return `decisão: ${decision}`;
  });
  await withServer({ runner, bridge }, async ({ server, auth, cookie }) => {
    const sse = openEvents(server, cookie);
    await sse.ready;
    await raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text: "crie a.txt" } });
    const ask = await sse.waitFor((e) => e.name === "confirm_request");
    assert.equal(ask.data.tool, "write_file");
    assert.equal(ask.data.description, "Criar a.txt");
    const post = (body) => raw(server, { method: "POST", path: "/api/confirm", headers: { ...auth, ...JSON_HEADERS }, body });
    assert.equal((await post({ id: ask.data.id, decision: "talvez" })).status, 400);
    assert.equal((await post({ id: 42, decision: "yes" })).status, 400);
    assert.equal((await post({ id: "id-inexistente", decision: "yes" })).status, 404);
    assert.equal((await post({ id: ask.data.id, decision: "always" })).status, 200); // "always" não permitido aqui: vale como "yes"
    await sse.waitFor((e) => e.name === "answer");
    assert.equal(decision, "yes");
    assert.equal((await post({ id: ask.data.id, decision: "yes" })).status, 404); // já respondida
    sse.close();
  });
});

test("fechar o painel com uma confirmação pendente NEGA a ação", async () => {
  let decision;
  const bridge = createPanelBridge({ confirmTimeoutMs: 5000 });
  const runner = fakeRunner(async () => { decision = await bridge.confirm({ tool: "execute_command", description: "rm x" }); return "fim"; });
  await withServer({ runner, bridge }, async ({ server, auth, cookie }) => {
    const sse = openEvents(server, cookie);
    await sse.ready;
    await raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text: "x" } });
    await sse.waitFor((e) => e.name === "confirm_request");
    sse.close();
    for (let i = 0; i < 100 && decision === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(decision, "no");
  });
});

test("confirmação sem resposta expira (nega) e o painel é avisado", async () => {
  let decision;
  const bridge = createPanelBridge({ confirmTimeoutMs: 120 });
  const runner = fakeRunner(async () => { decision = await bridge.confirm({ tool: "write_file", description: "d" }); return "fim"; });
  await withServer({ runner, bridge }, async ({ server, auth, cookie }) => {
    const sse = openEvents(server, cookie);
    await sse.ready;
    await raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text: "x" } });
    const ask = await sse.waitFor((e) => e.name === "confirm_request");
    const expired = await sse.waitFor((e) => e.name === "confirm_expired");
    assert.equal(expired.data.id, ask.data.id);
    await sse.waitFor((e) => e.name === "answer");
    assert.equal(decision, "no");
    sse.close();
  });
});

test("/api/stop para o agente e nega confirmações pendentes; /api/reset reinicia a conversa", async () => {
  let decision;
  const bridge = createPanelBridge({ confirmTimeoutMs: 5000 });
  const runner = fakeRunner(async () => { decision = await bridge.confirm({ tool: "write_file", description: "d" }); return "fim"; });
  await withServer({ runner, bridge }, async ({ server, auth, cookie }) => {
    const sse = openEvents(server, cookie);
    await sse.ready;
    await raw(server, { method: "POST", path: "/api/message", headers: { ...auth, ...JSON_HEADERS }, body: { text: "x" } });
    await sse.waitFor((e) => e.name === "confirm_request");
    assert.equal((await raw(server, { method: "POST", path: "/api/stop", headers: { ...auth, ...JSON_HEADERS }, body: {} })).status, 200);
    await sse.waitFor((e) => e.name === "answer");
    assert.equal(runner.stops, 1);
    assert.equal(decision, "no");
    await sse.waitFor((e) => e.name === "status" && e.data.busy === false);
    assert.equal((await raw(server, { method: "POST", path: "/api/reset", headers: { ...auth, ...JSON_HEADERS }, body: {} })).status, 200);
    assert.equal(runner.resets, 1);
    sse.close();
  });
});

// ===================== proxy de voz (/api/tts) =====================
const fakeTts = (impl) => ({ contentType: "audio/mpeg", calls: [], async synthesize(text, options) { fakeTts.last = options; return impl(text, options); } });

test("/api/tts: sem servidor de voz configurado responde 404 claro", async () => {
  await withServer({ tts: null }, async ({ server, auth }) => {
    const r = await raw(server, { method: "POST", path: "/api/tts", headers: { ...auth, ...JSON_HEADERS }, body: { text: "oi" } });
    assert.equal(r.status, 404);
    assert.match(r.json().error, /TTS_PROVIDER/);
  });
});

test("/api/tts: devolve o áudio com o tipo certo; valida o texto", async () => {
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
  const tts = fakeTts(async () => audio);
  await withServer({ tts }, async ({ server, auth }) => {
    const post = (body) => raw(server, { method: "POST", path: "/api/tts", headers: { ...auth, ...JSON_HEADERS }, body });
    const ok = await post({ text: "Olá, senhor." });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["content-type"], "audio/mpeg");
    assert.equal(ok.headers["content-length"], String(audio.length));
    assert.deepEqual(ok.buffer, audio);
    assert.equal((await post({ text: "" })).status, 400);
    assert.equal((await post({ text: 5 })).status, 400);
    assert.equal((await post({ text: "x".repeat(1501) })).status, 413);
  });
});

test("/api/tts: erros do servidor de voz chegam ao painel com status e mensagem", async () => {
  for (const [error, status, pattern] of [
    [new TtsError("Não foi possível falar com o servidor de voz", 502), 502, /servidor de voz/],
    [new TtsError("O servidor de voz não respondeu em 30s.", 504), 504, /30s/],
    [new Error("inesperado"), 502, /inesperado/],
    [new TtsError("status maluco", 999), 502, /maluco/],
  ]) {
    const tts = fakeTts(async () => { throw error; });
    await withServer({ tts }, async ({ server, auth }) => {
      const r = await raw(server, { method: "POST", path: "/api/tts", headers: { ...auth, ...JSON_HEADERS }, body: { text: "oi" } });
      assert.equal(r.status, status);
      assert.match(r.json().error, pattern);
    });
  }
});

test("/api/tts: se o painel desiste (interrompeu a fala), o pedido ao servidor de voz é cancelado", async () => {
  let signal;
  const tts = fakeTts((_text, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    options.signal.addEventListener("abort", () => reject(new TtsError("cancelado", 499)));
  }));
  await withServer({ tts }, async ({ server, cookie }) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method: "POST", path: "/api/tts", headers: { host: `127.0.0.1:${server.port}`, cookie, "content-type": "application/json" } });
    req.on("error", () => {});
    req.end(JSON.stringify({ text: "uma fala longa" }));
    for (let i = 0; i < 100 && !signal; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(signal);
    req.destroy();
    for (let i = 0; i < 100 && !signal.aborted; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(signal.aborted, true);
  });
});

// ===================== ciclo de vida =====================
test("porta ocupada: mensagem clara com a variável a ajustar", async () => {
  const first = await start();
  try {
    await assert.rejects(() => createVoiceServer({ runner: fakeRunner(), bridge: createPanelBridge(), port: first.server.port }), /já está em uso.*VOICE_PORT/);
  } finally {
    await first.server.close();
  }
});

test("close() encerra os fluxos abertos e recusa novas conexões", async () => {
  const ctx = await start();
  const { cookie } = await ctx.login();
  const sse = openEvents(ctx.server, cookie);
  const res = await sse.ready;
  const closed = new Promise((resolve) => res.on("close", resolve));
  await ctx.server.close();
  await closed;
  await assert.rejects(() => raw(ctx.server, { path: "/" }));
});

test("servidor escuta somente em 127.0.0.1 (não fica exposto na rede)", async () => {
  const ctx = await start();
  try {
    const address = await new Promise((resolve) => {
      const probe = http.request({ host: "127.0.0.1", port: ctx.server.port, path: "/" }, (res) => { resolve(res.socket.remoteAddress); res.resume(); });
      probe.end();
    });
    assert.equal(address, "127.0.0.1");
  } finally {
    await ctx.server.close();
  }
});

// ===================== ponte de confirmações =====================
test("bridge: sem nenhum painel conectado, confirmar nega na hora", async () => {
  const bridge = createPanelBridge();
  assert.equal(await bridge.confirm({ tool: "x", description: "d" }), "no");
  assert.equal(bridge.pendingCount, 0);
});

test("bridge: decisões inválidas não resolvem; 'always' só vale se permitido; ouvinte com erro não quebra nada", async () => {
  const bridge = createPanelBridge({ confirmTimeoutMs: 5000 });
  const seen = [];
  bridge.subscribe((e) => seen.push(e));
  bridge.subscribe(() => { throw new Error("painel com defeito"); });
  const pending = bridge.confirm({ tool: "screenshot", description: "d", allowSessionApproval: true });
  const { id } = seen.find((e) => e.type === "confirm_request");
  assert.equal(bridge.resolveConfirmation(id, "sim"), false);
  assert.equal(bridge.resolveConfirmation(id, undefined), false);
  assert.equal(bridge.pendingCount, 1);
  assert.equal(bridge.resolveConfirmation(id, "always"), true);
  assert.equal(await pending, "always");

  const single = bridge.confirm({ tool: "write_file", description: "d", allowSessionApproval: false });
  const second = seen.filter((e) => e.type === "confirm_request").at(-1);
  bridge.resolveConfirmation(second.id, "always");
  assert.equal(await single, "yes");
  assert.equal(bridge.resolveConfirmation(second.id, "yes"), false);
});

test("bridge: cancelar a inscrição do último painel nega as pendentes; expiração nega e avisa", async () => {
  const keepAlive = setInterval(() => {}, 50); // no programa real o servidor mantém o processo vivo; no teste, não
  const bridge = createPanelBridge({ confirmTimeoutMs: 100 });
  const events = [];
  const unsubscribe = bridge.subscribe((e) => events.push(e));
  const a = bridge.confirm({ tool: "a", description: "d" });
  unsubscribe();
  assert.equal(await a, "no");

  bridge.subscribe((e) => events.push(e));
  const b = bridge.confirm({ tool: "b", description: "d" });
  assert.equal(await b, "no"); // expirou
  assert.ok(events.some((e) => e.type === "confirm_expired"));
  assert.equal(bridge.pendingCount, 0);
  clearInterval(keepAlive);
});

test("desligar o servidor com o agente ainda emitindo eventos não derruba o programa", async () => {
  let release;
  const runner = fakeRunner(() => new Promise((resolve) => { release = () => resolve("tarde demais"); }));
  const ctx = await start({ runner });
  const { cookie } = await ctx.login();
  const sse = openEvents(ctx.server, cookie);
  await sse.ready;
  await raw(ctx.server, { method: "POST", path: "/api/message", headers: { cookie, ...JSON_HEADERS }, body: { text: "x" } });
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    await ctx.server.close(); // o painel ainda estava inscrito quando o servidor foi desligado
    release(); // o agente termina e tenta emitir 'answer'/'status' para o painel que já não existe
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(uncaught.map((e) => e.message), []);
  } finally {
    process.off("uncaughtException", onUncaught);
    sse.close();
  }
});
