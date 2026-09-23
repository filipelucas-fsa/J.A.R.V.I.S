// O modo voz COMO PROCESSO REAL (node src/voiceMain.js): modelo "NVIDIA" e servidor de voz "Kokoro" de teste.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockOpenAI, say, callTool } from "./helpers/mockOpenAI.js";
import { startMockKokoro } from "./helpers/mockKokoro.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function request(port, { method = "GET", path: url = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const buffer = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, buffer, json: () => JSON.parse(buffer.toString("utf8")) }); });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startVoice(env) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(ANTHROPIC_|MODEL_|NVIDIA_|OPENAI_|TTS_|VOICE_|WAKE_|TOOLS$|WORKSPACE_DIR$|MAX_STEPS$|AGENT_LOG_FILE$)/.test(key)) delete clean[key];
  const child = spawn(process.execPath, ["src/voiceMain.js"], { cwd: projectRoot, env: { ...clean, VOICE_NO_BROWSER: "true", VOICE_PORT: "0", ...env } });
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`voiceMain não iniciou. stderr:\n${stderr}`)), 8000);
    const check = () => {
      const match = /Painel: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+))/.exec(stderr);
      if (match) { clearTimeout(timer); resolve({ url: match[1], port: Number(match[2]), token: match[3] }); }
    };
    child.stderr.on("data", check);
    exited.then((code) => { clearTimeout(timer); reject(new Error(`voiceMain terminou (código ${code}): ${stderr}`)); });
  });
  ready.catch(() => {}); // quem não espera o servidor (testes de configuração inválida) não deve gerar rejeição solta
  return { child, exited, ready, stderr: () => stderr, stdout: () => stdout };
}

function events(port, cookie) {
  const list = [];
  const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}`, cookie } }, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1];
        if (name) list.push({ name, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
      }
    });
  });
  req.on("error", () => {});
  const waitFor = async (predicate, ms = 6000) => {
    const started = Date.now();
    while (Date.now() - started < ms) { const f = list.find(predicate); if (f) return f; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`evento não chegou: ${list.map((e) => e.name).join(",")}`);
  };
  return { list, waitFor, close: () => req.destroy() };
}

async function scenario(script, extraEnv, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-voice-"));
  await fs.writeFile(path.join(dir, "package.json"), '{"dependencies":{"foo":"1.0.0"}}');
  const logFile = path.join(dir, "..", `${path.basename(dir)}-actions.jsonl`);
  const llm = await startMockOpenAI({ script });
  const kokoro = await startMockKokoro({ audio: Buffer.from("ÁUDIO-DE-TESTE") });
  const voice = startVoice({
    MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvapi-test", MODEL_NAME: "meta/llama-3.1-70b-instruct", MODEL_BASE_URL: llm.url,
    TTS_PROVIDER: "kokoro", TTS_BASE_URL: kokoro.url, WORKSPACE_DIR: dir, AGENT_LOG_FILE: logFile, ...extraEnv,
  });
  try {
    const info = await voice.ready;
    const login = await request(info.port, { path: `/?token=${info.token}` });
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    await fn({ ...info, cookie, dir, llm, kokoro, voice, headers: { cookie }, logFile });
  } finally {
    voice.child.kill("SIGKILL");
    await voice.exited;
    await llm.close();
    await kokoro.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(logFile, { force: true });
  }
}

test("modo voz de ponta a ponta: config, mensagem com ferramenta, MEMÓRIA da conversa, voz e reinício", async () => {
  const script = [
    callTool("call_1", "read_file", { path: "package.json" }), say("O projeto usa a dependência foo."),
    say("Sim, na versão 1.0.0."),
    say("Nova conversa: olá."),
  ];
  await scenario(script, {}, async ({ port, headers, llm, kokoro, cookie }) => {
    const config = (await request(port, { path: "/api/config", headers })).json();
    assert.equal(config.title, "J.A.R.V.I.S.");
    assert.deepEqual(config.wakeWords, ["jarvis", "sexta-feira", "batman"]);
    assert.equal(config.silenceMs, 10000);
    assert.equal(config.tts.engine, "server");
    assert.equal(config.model, "NVIDIA · meta/llama-3.1-70b-instruct");
    assert.ok(!JSON.stringify(config).includes("nvapi-test"));

    const sse = events(port, cookie);
    const send = (text) => request(port, { method: "POST", path: "/api/message", headers, body: { text } });

    assert.equal((await send("Leia o package.json")).status, 202);
    assert.match((await sse.waitFor((e) => e.name === "answer")).data.text, /dependência foo/);
    assert.ok(sse.list.some((e) => e.name === "log" && /read_file/.test(e.data.line)));

    await sse.waitFor((e) => e.name === "status" && e.data.busy === false && sse.list.filter((x) => x.name === "answer").length === 1);
    assert.equal((await send("e qual a versão?")).status, 202);
    await sse.waitFor((e) => e.name === "answer" && /1\.0\.0/.test(e.data.text));
    const memory = llm.posts().at(-1).body.messages.filter((m) => m.role === "user").map((m) => m.content);
    assert.deepEqual(memory, ["Leia o package.json", "e qual a versão?"]); // lembrou da pergunta anterior

    const tts = await request(port, { method: "POST", path: "/api/tts", headers, body: { text: "Olá, senhor." } });
    assert.equal(tts.status, 200);
    assert.equal(tts.headers["content-type"], "audio/mpeg");
    assert.equal(tts.buffer.toString("utf8"), "ÁUDIO-DE-TESTE");
    assert.deepEqual(kokoro.requests.at(-1).body, { model: "kokoro", input: "Olá, senhor.", voice: "pm_alex", response_format: "mp3", speed: 1 });

    await sse.waitFor((e) => e.name === "status" && e.data.busy === false && sse.list.filter((x) => x.name === "answer").length === 2);
    assert.equal((await request(port, { method: "POST", path: "/api/reset", headers, body: {} })).status, 200);
    await send("começando de novo");
    await sse.waitFor((e) => e.name === "answer" && /Nova conversa/.test(e.data.text));
    assert.equal(llm.posts().at(-1).body.messages.filter((m) => m.role === "user").length, 1); // esqueceu a conversa anterior
    sse.close();
  });
});

test("modo voz: escrita de arquivo pede AUTORIZAÇÃO no painel; negar não cria o arquivo e fica no log", async () => {
  const script = [callTool("call_1", "write_file", { path: "novo.txt", content: "oi" }), say("Não escrevi o arquivo.")];
  await scenario(script, {}, async ({ port, headers, cookie, dir, logFile }) => {
    const sse = events(port, cookie);
    await request(port, { method: "POST", path: "/api/message", headers, body: { text: "crie novo.txt" } });
    const ask = await sse.waitFor((e) => e.name === "confirm_request");
    assert.equal(ask.data.tool, "write_file");
    assert.match(ask.data.description, /Criar o arquivo 'novo.txt'/);
    assert.equal((await request(port, { method: "POST", path: "/api/confirm", headers, body: { id: ask.data.id, decision: "no" } })).status, 200);
    await sse.waitFor((e) => e.name === "answer");
    assert.equal(await fs.access(path.join(dir, "novo.txt")).then(() => true, () => false), false);
    const log = (await fs.readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log[0].outcome, "denied");
    sse.close();
  });
});

test("modo voz: autorizando pelo clique, o arquivo é criado", async () => {
  const script = [callTool("call_1", "write_file", { path: "novo.txt", content: "conteúdo" }), say("Criei o arquivo.")];
  await scenario(script, {}, async ({ port, headers, cookie, dir }) => {
    const sse = events(port, cookie);
    await request(port, { method: "POST", path: "/api/message", headers, body: { text: "crie" } });
    const ask = await sse.waitFor((e) => e.name === "confirm_request");
    await request(port, { method: "POST", path: "/api/confirm", headers, body: { id: ask.data.id, decision: "yes" } });
    await sse.waitFor((e) => e.name === "answer");
    assert.equal(await fs.readFile(path.join(dir, "novo.txt"), "utf8"), "conteúdo");
    sse.close();
  });
});

test("modo voz: painel fechado durante a autorização NEGA (ninguém para aprovar)", async () => {
  const script = [callTool("call_1", "write_file", { path: "x.txt", content: "x" }), say("ok")];
  await scenario(script, {}, async ({ port, headers, cookie, dir, logFile }) => {
    const sse = events(port, cookie);
    await request(port, { method: "POST", path: "/api/message", headers, body: { text: "crie" } });
    await sse.waitFor((e) => e.name === "confirm_request");
    sse.close(); // fechou o painel
    for (let i = 0; i < 150; i++) {
      const log = await fs.readFile(logFile, "utf8").catch(() => "");
      if (log.includes("denied")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(await fs.readFile(logFile, "utf8"), /"outcome":"denied"/);
    assert.equal(await fs.access(path.join(dir, "x.txt")).then(() => true, () => false), false);
  });
});

test("modo voz: erro do modelo (chave errada) aparece no painel e o programa segue de pé", async () => {
  await scenario([], { NVIDIA_API_KEY: "chave-errada" }, async ({ port, headers, cookie }) => {
    const sse = events(port, cookie);
    await request(port, { method: "POST", path: "/api/message", headers, body: { text: "oi" } });
    assert.match((await sse.waitFor((e) => e.name === "error")).data.message, /Chave de API inválida.*NVIDIA/);
    await sse.waitFor((e) => e.name === "status" && e.data.busy === false);
    assert.equal((await request(port, { path: "/api/config", headers })).status, 200);
    sse.close();
  });
});

test("modo voz: servidor de voz fora do ar devolve erro claro em /api/tts (o painel cai na voz do navegador)", async () => {
  await scenario([], {}, async ({ port, headers, kokoro }) => {
    await kokoro.close();
    const r = await request(port, { method: "POST", path: "/api/tts", headers, body: { text: "oi" } });
    assert.equal(r.status, 502);
    assert.match(r.json().error, /Ele está rodando\?/);
  });
});

test("modo voz: SIGINT encerra com calma (código 0)", async (t) => {
  if (process.platform === "win32") return t.skip("SIGINT via kill() não é equivalente no Windows");
  await scenario([], {}, async ({ voice, port, headers }) => {
    assert.equal((await request(port, { path: "/api/config", headers })).status, 200);
    voice.child.kill("SIGINT");
    assert.equal(await voice.exited, 0);
    assert.match(voice.stderr(), /Encerrando/);
    await assert.rejects(() => request(port, { path: "/api/config", headers }));
  });
});

test("modo voz: banner mostra modelo, palavras-chave, voz e o aviso de privacidade", async () => {
  await scenario([], {}, async ({ voice }) => {
    const banner = voice.stderr();
    assert.match(banner, /\[modelo\] NVIDIA · meta\/llama-3\.1-70b-instruct/);
    assert.match(banner, /\[palavras-chave\] jarvis, sexta-feira, batman.*10s de silêncio/);
    assert.match(banner, /\[voz do agente\] servidor de voz em http:\/\/127\.0\.0\.1:\d+\/v1 \(voz pm_alex\)/);
    assert.match(banner, /\[privacidade\]/);
    assert.match(banner, /token secreto/);
  });
});

test("modo voz: configurações inválidas terminam com código 1 e mensagem clara", async () => {
  const base = { MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "m" };
  const cases = [
    [{ ...base, VOICE_SILENCE_SECONDS: "0" }, /VOICE_SILENCE_SECONDS/],
    [{ ...base, TTS_PROVIDER: "google" }, /TTS_PROVIDER/],
    [{ ...base, WAKE_WORDS: "ok" }, /WAKE_WORDS/],
    [{ MODEL_PROVIDER: "nvidia", MODEL_NAME: "m" }, /NVIDIA_API_KEY/],
    [{ ...base, TOOLS: "voar" }, /Ferramenta desconhecida/],
  ];
  for (const [env, pattern] of cases) {
    const voice = startVoice(env);
    const code = await voice.exited;
    assert.equal(code, 1, JSON.stringify(env));
    assert.match(voice.stderr(), pattern);
  }
});

test("modo voz: porta já em uso dá orientação", async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  try {
    const voice = startVoice({ MODEL_PROVIDER: "nvidia", NVIDIA_API_KEY: "k", MODEL_NAME: "m", VOICE_PORT: String(blocker.address().port) });
    assert.equal(await voice.exited, 1);
    assert.match(voice.stderr(), /já está em uso.*VOICE_PORT/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
