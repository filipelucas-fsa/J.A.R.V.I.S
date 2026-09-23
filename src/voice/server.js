import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TtsError } from "./ttsProxy.js";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const JS = "text/javascript; charset=utf-8";
// Só estes arquivos são servidos (lista fixa: não existe como pedir outro caminho).
const STATIC_FILES = {
  "style.css": "text/css; charset=utf-8",
  "boot.js": JS, "panel.js": JS, "voiceController.js": JS, "wakeWord.js": JS, "browserRecognizer.js": JS,
  "speech.js": JS, "voiceOutput.js": JS, "markdown.js": JS,
};
const INDEX = "index.html";
// Nomes dos arquivos que o painel pode pedir (exportado para os testes conferirem contra a pasta web/).
export const SERVED_FILES = Object.keys(STATIC_FILES);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 4000;
const MAX_SPEECH_CHARS = 1500;
const COOKIE_NAME = "agent_sid";
const KEEPALIVE_MS = 15_000;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

// Servidor local do painel de voz.
//   runner: { run(text) -> Promise<string>, stop() }  (o Agent)
//   bridge: createPanelBridge()
//   config: enviado ao painel em /api/config (palavras-chave, idioma, tempo de silêncio...)
//
// O agente pode alterar arquivos e executar comandos, então este servidor precisa resistir a páginas maliciosas de
// OUTROS sites que tentem falar com ele. Camadas: escuta só em 127.0.0.1; token secreto na URL de abertura que vira
// cookie HttpOnly + SameSite=Strict; checagem de Host (contra DNS rebinding) e de Origin; JSON obrigatório; CSP.
export async function createVoiceServer({ runner, bridge, config = {}, tts = null, port = 0, host = "127.0.0.1" }) {
  const token = crypto.randomBytes(24).toString("hex");
  const files = new Map();
  for (const name of [INDEX, ...Object.keys(STATIC_FILES)]) files.set(name, await fs.readFile(path.join(WEB_DIR, name)));

  let busy = false;
  let allowedHosts = new Set();
  let allowedOrigins = new Set();
  const streams = new Set();

  const securityHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  const send = (res, status, type, body, headers = {}) => {
    res.writeHead(status, { "content-type": type, ...securityHeaders, ...headers });
    res.end(body);
  };
  const sendJson = (res, status, value) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

  const isAuthed = (req) => {
    const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
    return cookie !== undefined && safeEqual(cookie, token);
  };

  function readJson(req) {
    return new Promise((resolve) => {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return resolve({ error: [415, "Envie JSON (content-type: application/json)."] });
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) tooBig = true;
        else chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooBig) return resolve({ error: [413, "Corpo grande demais."] });
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("não é objeto");
          resolve({ value });
        } catch {
          resolve({ error: [400, "JSON inválido."] });
        }
      });
      req.on("error", () => resolve({ error: [400, "Requisição interrompida."] }));
    });
  }

  function openStream(req, res) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", ...securityHeaders });
    // Escrever numa conexão já encerrada gera um erro SEM ouvinte, que derrubaria o programa: por isso a guarda.
    res.on("error", () => {});
    const alive = () => !res.writableEnded && !res.destroyed;
    const write = (event, data) => { if (alive()) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    res.write("retry: 2000\n\n");
    write("hello", { type: "hello", busy });
    const unsubscribe = bridge.subscribe((event) => write(event.type, event));
    const keepalive = setInterval(() => { if (alive()) res.write(": ping\n\n"); }, KEEPALIVE_MS);
    keepalive.unref?.();
    streams.add(res);
    req.on("close", () => {
      clearInterval(keepalive);
      streams.delete(res);
      unsubscribe();
    });
  }

  function startRun(text) {
    busy = true;
    bridge.emit({ type: "status", busy: true });
    Promise.resolve()
      .then(() => runner.run(text))
      .then(
        (answer) => bridge.emit({ type: "answer", text: String(answer) }),
        (error) => bridge.emit({ type: "error", message: error?.message ?? String(error) })
      )
      .finally(() => {
        busy = false;
        bridge.emit({ type: "status", busy: false });
      });
  }

  async function handle(req, res) {
    // 1) Host: barra ataques de "DNS rebinding" (site malicioso cujo domínio passa a apontar para 127.0.0.1).
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, "text/plain; charset=utf-8", "Host não permitido.");
    // 2) Requisições vindas de outro site nunca são atendidas.
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite !== undefined && !["same-origin", "none"].includes(fetchSite)) return send(res, 403, "text/plain; charset=utf-8", "Origem não permitida.");
    if (req.headers.origin !== undefined && !allowedOrigins.has(req.headers.origin)) return send(res, 403, "text/plain; charset=utf-8", "Origem não permitida.");

    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;

    if (pathname === "/" && req.method === "GET") {
      const given = url.searchParams.get("token");
      if (given !== null) {
        if (!safeEqual(given, token)) return send(res, 401, "text/plain; charset=utf-8", "Token inválido. Abra o endereço completo mostrado no terminal.");
        // O token sai da URL (não fica no histórico) e vira cookie que o JavaScript da página não consegue ler.
        return send(res, 302, "text/plain; charset=utf-8", "", {
          location: "/", "set-cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (!isAuthed(req)) return send(res, 401, "text/plain; charset=utf-8", "Acesso negado. Abra o endereço completo mostrado no terminal.");
      return send(res, 200, "text/html; charset=utf-8", files.get(INDEX));
    }

    if (!isAuthed(req)) return send(res, 401, "text/plain; charset=utf-8", "Acesso negado.");

    if (pathname.startsWith("/static/") && req.method === "GET") {
      const name = pathname.slice("/static/".length);
      if (!Object.hasOwn(STATIC_FILES, name)) return send(res, 404, "text/plain; charset=utf-8", "Não encontrado.");
      return send(res, 200, STATIC_FILES[name], files.get(name));
    }

    if (pathname === "/api/config" && req.method === "GET") return sendJson(res, 200, config);
    if (pathname === "/api/events" && req.method === "GET") return openStream(req, res);

    if (req.method === "POST" && ["/api/message", "/api/confirm", "/api/stop", "/api/reset", "/api/tts"].includes(pathname)) {
      const body = await readJson(req);
      if (body.error) return sendJson(res, body.error[0], { error: body.error[1] });
      const data = body.value;

      if (pathname === "/api/reset") {
        if (busy) return sendJson(res, 409, { error: "O agente está trabalhando: espere ou pare a tarefa antes de iniciar uma nova conversa." });
        runner.resetConversation?.();
        return sendJson(res, 200, { reset: true });
      }
      if (pathname === "/api/tts") {
        if (!tts) return sendJson(res, 404, { error: "Nenhum servidor de voz configurado (TTS_PROVIDER)." });
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (text === "") return sendJson(res, 400, { error: "Texto vazio." });
        if (text.length > MAX_SPEECH_CHARS) return sendJson(res, 413, { error: `Texto grande demais para a voz (máximo ${MAX_SPEECH_CHARS} caracteres).` });
        const controller = new AbortController();
        res.on("close", () => controller.abort()); // painel desistiu (ex.: você interrompeu): cancela o pedido ao servidor de voz
        try {
          const audio = await tts.synthesize(text, { signal: controller.signal });
          return send(res, 200, tts.contentType, audio, { "content-length": String(audio.length) });
        } catch (error) {
          if (res.destroyed) return undefined;
          const status = error instanceof TtsError ? error.status : 502;
          return sendJson(res, status >= 400 && status < 600 ? status : 502, { error: error?.message ?? "Falha na voz." });
        }
      }
      if (pathname === "/api/stop") {
        runner.stop();
        bridge.denyAll();
        return sendJson(res, 200, { stopped: true });
      }
      if (pathname === "/api/confirm") {
        if (typeof data.id !== "string" || !["yes", "no", "always"].includes(data.decision)) return sendJson(res, 400, { error: "Informe 'id' e 'decision' (yes, no ou always)." });
        return bridge.resolveConfirmation(data.id, data.decision)
          ? sendJson(res, 200, { ok: true })
          : sendJson(res, 404, { error: "Confirmação desconhecida ou já expirada." });
      }
      // /api/message
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (text === "") return sendJson(res, 400, { error: "Mensagem vazia." });
      if (text.length > MAX_TEXT_CHARS) return sendJson(res, 413, { error: `Mensagem grande demais (máximo ${MAX_TEXT_CHARS} caracteres).` });
      if (busy) return sendJson(res, 409, { error: "O agente ainda está trabalhando na tarefa anterior." });
      startRun(text);
      return sendJson(res, 202, { accepted: true });
    }

    return send(res, 404, "text/plain; charset=utf-8", "Não encontrado.");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "Erro interno.");
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      reject(error.code === "EADDRINUSE"
        ? new Error(`A porta ${port} já está em uso (talvez o modo voz já esteja aberto). Defina outra em VOICE_PORT.`)
        : error);
    });
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  allowedOrigins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);

  return {
    port: actualPort,
    token,
    url: `http://127.0.0.1:${actualPort}/?token=${token}`,
    isBusy: () => busy,
    close: () => new Promise((resolve) => {
      bridge.denyAll();
      for (const stream of streams) stream.end();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
