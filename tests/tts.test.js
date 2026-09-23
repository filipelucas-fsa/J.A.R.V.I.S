import { test } from "node:test";
import assert from "node:assert/strict";
import { TtsError, createTtsProxy } from "../src/voice/ttsProxy.js";
import { readVoiceConfig } from "../src/voice/config.js";
import { ConfigError } from "../src/ai/index.js";
import { startMockKokoro } from "./helpers/mockKokoro.js";

async function withKokoro(options, fn) {
  const server = await startMockKokoro(options);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}
const proxyFor = (server, o = {}) => createTtsProxy({ baseURL: server.url, model: "kokoro", voice: "pm_alex", ...o });

test("synthesize: pede o áudio no formato OpenAI/Kokoro e devolve os bytes", async () => {
  await withKokoro({}, async (server) => {
    const audio = await proxyFor(server, { speed: 1.1 }).synthesize("Olá, senhor.");
    assert.equal(audio.toString(), "MP3-FAKE-AUDIO");
    const [request] = server.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/audio/speech");
    assert.deepEqual(request.body, { model: "kokoro", input: "Olá, senhor.", voice: "pm_alex", response_format: "mp3", speed: 1.1 });
    assert.equal(request.headers.authorization, undefined);
  });
});

test("synthesize: chave (quando existe) vai no cabeçalho e a barra final da URL é ignorada", async () => {
  await withKokoro({ apiKey: "chave-tts" }, async (server) => {
    const ok = await proxyFor(server, { apiKey: "chave-tts", baseURL: server.url + "//" }).synthesize("oi");
    assert.equal(ok.length > 0, true);
    await assert.rejects(() => proxyFor(server, { apiKey: "errada" }).synthesize("oi"), (e) => e instanceof TtsError && /TTS_API_KEY/.test(e.message));
  });
});

test("tipo de conteúdo conforme o formato pedido", () => {
  const type = (format) => createTtsProxy({ baseURL: "http://x/v1", model: "m", voice: "v", format }).contentType;
  assert.deepEqual(["mp3", "wav", "opus", "flac", "aac"].map(type), ["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/mpeg"]);
});

test("erros do servidor de voz viram mensagens com a variável a ajustar", async () => {
  const cases = [
    [400, { detail: "voice 'pm_alex' not found" }, /recusou o pedido.*not found.*TTS_VOICE \('pm_alex'\)/s],
    [422, { detail: [{ msg: "field required" }] }, /field required/],
    [403, { error: { message: "no" } }, /TTS_API_KEY/],
    [404, { detail: "Not Found" }, /TTS_BASE_URL/],
    [500, "erro interno em texto puro", /erro 500.*erro interno/s],
    [503, { detail: "overloaded" }, /erro 503/],
  ];
  for (const [status, errorBody, pattern] of cases) {
    await withKokoro({ status, errorBody }, async (server) => {
      await assert.rejects(() => proxyFor(server).synthesize("oi"), (e) => e instanceof TtsError && e.status === 502 && pattern.test(e.message), String(status));
    });
  }
});

test("servidor de voz fora do ar, sem resposta ou derrubado", async () => {
  const dead = await startMockKokoro({});
  const proxy = proxyFor(dead);
  await dead.close();
  await assert.rejects(() => proxy.synthesize("oi"), (e) => e.status === 502 && /Ele está rodando\?/.test(e.message));

  await withKokoro({ hang: true }, async (server) => {
    await assert.rejects(() => proxyFor(server, { timeoutMs: 200 }).synthesize("oi"), (e) => e.status === 504 && /não respondeu/.test(e.message));
  });
  await withKokoro({ destroy: true }, async (server) => {
    await assert.rejects(() => proxyFor(server).synthesize("oi"), (e) => e.status === 502);
  });
});

test("cancelamento (você interrompeu a fala) devolve 499 e não espera o servidor", async () => {
  await withKokoro({ hang: true }, async (server) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await assert.rejects(() => proxyFor(server).synthesize("oi", { signal: controller.signal }), (e) => e.status === 499);
    assert.ok(Date.now() - started < 3000);
  });
});

test("áudio vazio ou grande demais é recusado", async () => {
  await withKokoro({ audio: Buffer.alloc(0) }, async (server) => {
    await assert.rejects(() => proxyFor(server).synthesize("oi"), /áudio vazio/);
  });
  const huge = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(21 * 1024 * 1024), text: async () => "" };
  await assert.rejects(() => createTtsProxy({ baseURL: "http://x/v1", model: "m", voice: "v", fetchImpl: async () => huge }).synthesize("oi"), /grande demais/);
});

test("listVoices aceita as formas de resposta dos servidores", async () => {
  for (const shape of ["objects", "strings", "array"]) {
    await withKokoro({ voicesShape: shape }, async (server) => {
      assert.deepEqual(await proxyFor(server).listVoices(), ["af_bella", "pf_dora", "pm_alex", "pm_santa"], shape);
    });
  }
  await withKokoro({ status: 404 }, async (server) => {
    await assert.rejects(() => proxyFor(server).listVoices(), /TTS_BASE_URL/);
  });
});

// ===================== configuração do modo voz =====================
const cfg = (env) => readVoiceConfig(env);
const fails = (env, pattern) => assert.throws(() => cfg(env), (e) => e instanceof ConfigError && pattern.test(e.message), JSON.stringify(env));

test("padrões: Jarvis/sexta-feira/batman, 10 s, voz do navegador, respostas por voz e interrupção falando", () => {
  const c = cfg({});
  assert.deepEqual(c.panel.wakeWords, ["jarvis", "sexta-feira", "batman"]);
  assert.equal(c.panel.title, "J.A.R.V.I.S.");
  assert.equal(c.panel.lang, "pt-BR");
  assert.equal(c.panel.silenceMs, 10_000);
  assert.equal(c.panel.maxCaptureMs, 120_000);
  assert.equal(c.panel.fuzzy, false);
  assert.deepEqual(c.panel.tts, { engine: "browser", lang: "pt-BR", rate: 1, pitch: 1, voiceName: null, replies: "auto", bargeIn: "any", maxChars: 1200 });
  assert.equal(c.ttsServer, null);
  assert.equal(c.port, 47821);
  assert.equal(c.openBrowser, true);
});

test("Kokoro: preset local, e o painel nunca recebe a chave nem o endereço do servidor", () => {
  const c = cfg({ TTS_PROVIDER: "kokoro", TTS_API_KEY: "segredo-tts" });
  assert.deepEqual(c.ttsServer, { baseURL: "http://localhost:8880/v1", apiKey: "segredo-tts", model: "kokoro", voice: "pm_alex", format: "mp3", speed: 1 });
  assert.equal(c.panel.tts.engine, "server");
  assert.ok(!JSON.stringify(c.panel).includes("segredo-tts"));
  assert.ok(!JSON.stringify(c.panel).includes("8880"));
  const custom = cfg({ TTS_PROVIDER: "kokoro", TTS_BASE_URL: "http://outra-maquina:9000/v1/", TTS_VOICE: "pf_dora", TTS_MODEL: "kokoro-v2", TTS_FORMAT: "WAV", TTS_SPEED: "1.25" });
  assert.deepEqual(custom.ttsServer, { baseURL: "http://outra-maquina:9000/v1", apiKey: undefined, model: "kokoro-v2", voice: "pf_dora", format: "wav", speed: 1.25 });
});

test("servidor de voz compatível qualquer exige o endereço", () => {
  fails({ TTS_PROVIDER: "openai-compatible" }, /TTS_BASE_URL/);
  const c = cfg({ TTS_PROVIDER: "openai-compatible", TTS_BASE_URL: "https://api.exemplo.com/v1" });
  assert.deepEqual([c.ttsServer.model, c.ttsServer.voice], ["tts-1", "alloy"]);
});

test("ajustes da voz do navegador e do comportamento", () => {
  const c = cfg({ VOICE_RATE: "1.15", VOICE_PITCH: "0.85", VOICE_NAME: " Antonio ", VOICE_REPLIES: "OFF", VOICE_BARGE_IN: "wake", VOICE_MAX_SPOKEN_CHARS: "600", VOICE_TITLE: "  Assistente  ", VOICE_SILENCE_SECONDS: "7.5", VOICE_MAX_CAPTURE_SECONDS: "60", WAKE_WORDS: "computador, ei casa", WAKE_FUZZY: "sim", VOICE_LANG: "pt-PT", VOICE_PORT: "0", VOICE_NO_BROWSER: "true", VOICE_SCREEN_SIZE: "2560x1440" });
  assert.deepEqual(c.panel.tts, { engine: "browser", lang: "pt-PT", rate: 1.15, pitch: 0.85, voiceName: "Antonio", replies: "off", bargeIn: "wake", maxChars: 600 });
  assert.deepEqual([c.panel.title, c.panel.silenceMs, c.panel.maxCaptureMs, c.panel.fuzzy, c.panel.wakeWords], ["Assistente", 7500, 60000, true, ["computador", "ei casa"]]);
  assert.deepEqual([c.port, c.openBrowser, c.screen], [0, false, { width: 2560, height: 1440 }]);
});

test("valores inválidos dão mensagens claras", () => {
  const bad = [
    [{ TTS_PROVIDER: "google" }, /TTS_PROVIDER.*browser, kokoro, openai-compatible/],
    [{ TTS_PROVIDER: "kokoro", TTS_BASE_URL: "não é url" }, /TTS_BASE_URL inválida/],
    [{ TTS_PROVIDER: "kokoro", TTS_BASE_URL: "ftp://x/v1" }, /TTS_BASE_URL inválida/],
    [{ TTS_PROVIDER: "kokoro", TTS_FORMAT: "ogg" }, /TTS_FORMAT/],
    [{ TTS_PROVIDER: "kokoro", TTS_SPEED: "5" }, /TTS_SPEED/],
    [{ VOICE_RATE: "0.1" }, /VOICE_RATE/], [{ VOICE_RATE: "abc" }, /VOICE_RATE/], [{ VOICE_PITCH: "3" }, /VOICE_PITCH/],
    [{ VOICE_REPLIES: "sempre" }, /VOICE_REPLIES/], [{ VOICE_BARGE_IN: "talvez" }, /VOICE_BARGE_IN/],
    [{ VOICE_MAX_SPOKEN_CHARS: "50" }, /VOICE_MAX_SPOKEN_CHARS/],
    [{ VOICE_TITLE: "x".repeat(41) }, /VOICE_TITLE/],
    [{ VOICE_LANG: "português" }, /VOICE_LANG/],
    [{ VOICE_SILENCE_SECONDS: "0" }, /VOICE_SILENCE_SECONDS/], [{ VOICE_SILENCE_SECONDS: "500" }, /VOICE_SILENCE_SECONDS/],
    [{ VOICE_SILENCE_SECONDS: "30", VOICE_MAX_CAPTURE_SECONDS: "10" }, /VOICE_MAX_CAPTURE_SECONDS.*menor/],
    [{ WAKE_WORDS: "ok" }, /WAKE_WORDS/], [{ WAKE_FUZZY: "quem sabe" }, /WAKE_FUZZY/],
    [{ VOICE_PORT: "99999" }, /VOICE_PORT/], [{ VOICE_PORT: "80.5" }, /VOICE_PORT/],
    [{ VOICE_SCREEN_SIZE: "grande" }, /VOICE_SCREEN_SIZE/], [{ VOICE_NO_BROWSER: "?" }, /VOICE_NO_BROWSER/],
  ];
  for (const [env, pattern] of bad) fails(env, pattern);
});
