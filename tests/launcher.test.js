import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrowserArgs, computePosition, findBrowser, launchPanel } from "../src/voice/launchBrowser.js";

const has = (...files) => (file) => files.includes(file);

test("Linux: procura Chrome/Chromium/Edge no PATH, na ordem", () => {
  const env = { PATH: "/usr/local/bin:/usr/bin" };
  assert.equal(findBrowser({ platform: "linux", env, exists: has("/usr/bin/chromium", "/usr/bin/google-chrome") }), "/usr/bin/google-chrome");
  assert.equal(findBrowser({ platform: "linux", env, exists: has("/usr/local/bin/microsoft-edge") }), "/usr/local/bin/microsoft-edge");
  assert.equal(findBrowser({ platform: "linux", env, exists: has() }), null);
  assert.equal(findBrowser({ platform: "linux", env: {}, exists: () => true }), null); // sem PATH
});

test("Windows: Edge primeiro (vozes neurais melhores), depois Chrome", () => {
  const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(findBrowser({ platform: "win32", env, exists: has(edge, chrome) }), edge);
  assert.equal(findBrowser({ platform: "win32", env, exists: has(chrome) }), chrome);
  assert.equal(findBrowser({ platform: "win32", env, exists: has() }), null);
});

test("macOS e VOICE_BROWSER (tem prioridade e precisa existir)", () => {
  assert.equal(findBrowser({ platform: "darwin", env: {}, exists: has("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge") }), "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  const env = { VOICE_BROWSER: "/opt/meu-chrome" };
  assert.equal(findBrowser({ platform: "linux", env: { ...env, PATH: "/usr/bin" }, exists: has("/opt/meu-chrome", "/usr/bin/google-chrome") }), "/opt/meu-chrome");
  assert.equal(findBrowser({ platform: "linux", env: { ...env, PATH: "/usr/bin" }, exists: has("/usr/bin/google-chrome") }), null); // caminho errado: não "adivinha"
});

test("argumentos: janela sem barra, perfil próprio, tamanho, som liberado e posição", () => {
  const args = buildBrowserArgs({ url: "http://127.0.0.1:1/?token=a", profileDir: "/p", position: { x: 10, y: 20 } });
  assert.deepEqual(args, ["--app=http://127.0.0.1:1/?token=a", "--user-data-dir=/p", "--window-size=400,640", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check", "--window-position=10,20"]);
  assert.ok(!buildBrowserArgs({ url: "u", profileDir: "/p" }).some((a) => a.startsWith("--window-position")));
  assert.ok(!args.some((a) => /no-sandbox|disable-web-security|remote-debugging/.test(a)), "flags inseguros");
});

test("posição: canto inferior direito, nunca negativa", () => {
  assert.deepEqual(computePosition({ width: 1920, height: 1080 }, { width: 400, height: 640 }), { x: 1504, y: 384 });
  assert.deepEqual(computePosition({ width: 300, height: 300 }, { width: 400, height: 640 }), { x: 0, y: 0 });
});

test("launchPanel: abre o navegador achado com os argumentos e ignora erros do processo filho", () => {
  const calls = [];
  const child = { on(event) { calls.push(`on:${event}`); } };
  const result = launchPanel({
    url: "http://127.0.0.1:5/?token=t", env: { PATH: "/usr/bin", VOICE_PROFILE_DIR: "/meu/perfil" }, platform: "linux",
    exists: has("/usr/bin/chromium"), screen: { width: 1920, height: 1080 },
    spawnImpl: (file, args, options) => { calls.push([file, args, options]); return child; },
  });
  assert.equal(result.browser, "/usr/bin/chromium");
  assert.ok(result.args.includes("--user-data-dir=/meu/perfil"));
  assert.ok(result.args.includes("--window-position=1504,384"));
  assert.deepEqual(calls[0][2], { stdio: "ignore" });
  assert.ok(calls.includes("on:error"));
});

test("launchPanel: sem navegador compatível explica o que fazer", () => {
  assert.throws(() => launchPanel({ url: "u", env: { PATH: "/x" }, platform: "linux", exists: has() }), /Chrome, Edge ou Chromium.*VOICE_BROWSER.*manualmente/s);
});
