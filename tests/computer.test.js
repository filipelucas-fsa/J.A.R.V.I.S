import { test } from "node:test";
import assert from "node:assert/strict";
import pngjs from "pngjs";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { createComputerTools, normalizeKey } from "../src/tools/computerTools.js";
import { fitSize, prepareScreenshot, resizeRGBA, visualTokens, MAX_EDGE, MAX_PIXELS, MAX_VISUAL_TOKENS } from "../src/computer/image.js";
import { pngSize } from "./helpers/mockApi.js";
import { makePng, fakeDriver } from "./helpers/fakeComputer.js";

const { PNG } = pngjs;

function setup(driverOptions) {
  const driver = fakeDriver(driverOptions);
  const registry = new ToolRegistry();
  for (const tool of createComputerTools({ driver, actionDelayMs: 0 })) registry.register(tool);
  const asks = [];
  const confirm = async (r) => (asks.push(r), "yes");
  return { driver, registry, asks, run: (name, input) => registry.execute(name, input, { confirm }) };
}

// ---------------- limites de imagem ----------------
test("fitSize respeita TODOS os limites em resoluções comuns e extremas", () => {
  const sizes = [[1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160], [5120, 2880], [7680, 4320], [3440, 1440], [2560, 1080], [1080, 1920], [800, 600], [100, 100], [5000, 100], [100, 5000], [1, 1], [1, 3000], [3000, 1]];
  for (const [w, h] of sizes) {
    const out = fitSize(w, h);
    assert.ok(out.width >= 1 && out.height >= 1, `${w}x${h} -> ${out.width}x${out.height}`);
    assert.ok(Math.max(out.width, out.height) <= MAX_EDGE, `lado maior ${w}x${h}`);
    assert.ok(out.width * out.height <= MAX_PIXELS, `pixels ${w}x${h}`);
    assert.ok(visualTokens(out.width, out.height) <= MAX_VISUAL_TOKENS, `tokens ${w}x${h}`);
    // mantém a proporção (tolerância de arredondamento)
    if (Math.min(w, h) > 50) assert.ok(Math.abs(out.width / out.height - w / h) / (w / h) < 0.03, `proporção ${w}x${h}`);
  }
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 }); // imagens pequenas não mudam
  assert.throws(() => fitSize(0, 10), /inválidas/);
  assert.throws(() => fitSize(10.5, 10), /inválidas/);
});

test("prepareScreenshot reduz de verdade e gera um PNG válido do tamanho anunciado", () => {
  const prepared = prepareScreenshot(makePng(3840, 2160));
  assert.deepEqual(pngSize(prepared.png), { width: prepared.width, height: prepared.height });
  assert.equal(prepared.originalWidth, 3840);
  assert.ok(prepared.width < 1568 && prepared.width * prepared.height <= MAX_PIXELS);
  const decoded = PNG.sync.read(prepared.png);
  assert.equal(decoded.width, prepared.width);
});

test("prepareScreenshot preserva o conteúdo (canto superior esquerdo e cor média)", () => {
  const png = new PNG({ width: 3000, height: 2000 });
  for (let i = 0; i < 3000 * 2000; i++) {
    const x = i % 3000;
    png.data.set(x < 1500 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4); // metade vermelha, metade azul
  }
  const prepared = prepareScreenshot(PNG.sync.write(png));
  const out = PNG.sync.read(prepared.png);
  const pixel = (x, y) => [...out.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 4)];
  assert.deepEqual(pixel(2, 2), [255, 0, 0, 255]);
  assert.deepEqual(pixel(out.width - 3, 2), [0, 0, 255, 255]);
});

test("prepareScreenshot: imagem pequena passa intacta; PNG grande demais em bytes é reduzido; entradas ruins dão erro claro", () => {
  const small = makePng(400, 300);
  assert.equal(prepareScreenshot(small).png, small);

  const noisy = makePng(1200, 800, { noise: true }); // ruído: PNG grande
  const limit = Math.floor(noisy.length / 2);
  const prepared = prepareScreenshot(noisy, { maxBytes: limit });
  assert.ok(prepared.png.length <= limit);
  assert.ok(prepared.width < 1200);

  assert.throws(() => prepareScreenshot(noisy, { maxBytes: 200 }), /Não foi possível reduzir/);
  assert.throws(() => prepareScreenshot(Buffer.from("isto é um JPEG ou lixo")), /não é um PNG válido/);
  assert.throws(() => prepareScreenshot(Buffer.alloc(0)), /não é um PNG válido/);
});

test("resizeRGBA faz a média dos pixels", () => {
  const data = Buffer.from([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]); // 2x2
  assert.deepEqual([...resizeRGBA(data, 2, 2, 1, 1)], [100, 100, 100, 255]);
});

// ---------------- teclas ----------------
test("normalizeKey: aliases, maiúsculas e teclas inválidas", () => {
  assert.equal(normalizeKey("Ctrl"), "control");
  assert.equal(normalizeKey("ESC"), "escape");
  assert.equal(normalizeKey("Return"), "enter");
  assert.equal(normalizeKey("cmd"), "meta");
  assert.equal(normalizeKey("F12"), "f12");
  assert.equal(normalizeKey("A"), "a");
  assert.equal(normalizeKey("5"), "5");
  assert.equal(normalizeKey(" "), "space");
  for (const bad of ["f13", "f0", "ab", "", "😀", "ctrl+c", "capslock", 5, null, undefined, {}]) {
    assert.equal(normalizeKey(bad), null, String(bad));
  }
});

// ---------------- ferramentas ----------------
test("mouse antes de screenshot é recusado (coordenadas sem referência)", async () => {
  const { run, driver, asks } = setup();
  const r = await run("mouse_click", { x: 10, y: 10 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Tire um screenshot antes/);
  assert.equal(asks.length, 0);
  assert.deepEqual(driver.calls, []);
});

test("screenshot devolve imagem dentro dos limites e o texto informa as dimensões", async () => {
  const { run } = setup({ capture: { width: 3840, height: 2160 } });
  const r = await run("screenshot", {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.images.length, 1);
  const size = pngSize(Buffer.from(r.images[0].data, "base64"));
  assert.match(r.output, new RegExp(`${size.width}x${size.height}`));
  assert.ok(Math.max(size.width, size.height) <= MAX_EDGE);
});

test("coordenadas da imagem viram posição correta na tela (inclusive HiDPI: captura 2x)", async () => {
  // tela lógica 1920x1080, captura em 3840x2160 (retina)
  const { run, driver } = setup({ screen: { width: 1920, height: 1080 }, capture: { width: 3840, height: 2160 } });
  const shot = await run("screenshot", {});
  const { width, height } = pngSize(Buffer.from(shot.images[0].data, "base64"));

  await run("mouse_click", { x: Math.floor(width / 2), y: Math.floor(height / 2) });
  const [, click] = driver.calls.at(-1);
  assert.ok(Math.abs(click.x - 960) <= 2 && Math.abs(click.y - 540) <= 2, `centro -> (${click.x},${click.y})`);

  await run("mouse_click", { x: 0, y: 0 });
  assert.deepEqual(driver.calls.at(-1)[1], { x: 0, y: 0, button: "left", double: false });

  await run("mouse_click", { x: width - 1, y: height - 1, button: "right", double: true });
  const last = driver.calls.at(-1)[1];
  assert.ok(last.x <= 1919 && last.y <= 1079 && last.x >= 1917 && last.y >= 1077, `canto -> (${last.x},${last.y})`);
  assert.equal(last.button, "right");
  assert.equal(last.double, true);

  await run("mouse_move", { x: 100, y: 50 });
  const [kind, mx, my] = driver.calls.at(-1);
  assert.equal(kind, "move");
  assert.equal(mx, Math.round((100 * 1920) / width));
  assert.equal(my, Math.round((50 * 1080) / height));
});

test("coordenadas fora da imagem, negativas ou inválidas são recusadas sem incomodar o usuário", async () => {
  const { run, driver, asks } = setup();
  const shot = await run("screenshot", {});
  const { width, height } = pngSize(Buffer.from(shot.images[0].data, "base64"));
  const before = asks.length;
  for (const input of [{ x: width, y: 0 }, { x: 0, y: height }, { x: 99999, y: 5 }]) {
    const r = await run("mouse_click", input);
    assert.equal(r.ok, false);
    assert.match(r.error, /fora da imagem/);
  }
  assert.match((await run("mouse_click", { x: -1, y: 5 })).error, />= 0/);
  assert.match((await run("mouse_click", { x: 1.5, y: 5 })).error, /integer/);
  assert.match((await run("mouse_click", { x: "10", y: 5 })).error, /integer/);
  assert.match((await run("mouse_click", { x: 5, y: 5, button: "esquerdo" })).error, /um dos valores: left, right, middle/);
  assert.match((await run("mouse_click", { x: 5 })).error, /'y' é obrigatório/);
  assert.equal(asks.length, before);
  assert.equal(driver.calls.length, 0);
});

test("se a resolução mudou desde o screenshot, o clique é recusado", async () => {
  const { run, driver } = setup();
  await run("screenshot", {});
  driver.screen = { width: 1280, height: 720 }; // usuário trocou a resolução / outro monitor
  const r = await run("mouse_click", { x: 10, y: 10 });
  assert.equal(r.ok, false);
  assert.match(r.error, /resolução da tela mudou/);
  assert.equal(driver.calls.length, 0);
  assert.match((await run("mouse_click", { x: 10, y: 10 })).error, /Tire um screenshot antes/); // estado invalidado
});

test("teclado: digitar, combinações, aliases e validação", async () => {
  const { run, driver } = setup();
  assert.equal((await run("keyboard_type", { text: "olá, 日本! 🚀" })).ok, true);
  assert.deepEqual(driver.calls.at(-1), ["type", "olá, 日本! 🚀"]);

  await run("keyboard_press", { keys: ["Ctrl", "C"] });
  assert.deepEqual(driver.calls.at(-1), ["keys", ["control", "c"]]);
  await run("keyboard_press", { keys: ["enter"] });
  assert.deepEqual(driver.calls.at(-1), ["keys", ["enter"]]);

  const n = driver.calls.length;
  assert.match((await run("keyboard_press", { keys: ["control", "banana"] })).error, /não suportada.*'banana'/);
  assert.match((await run("keyboard_press", { keys: [] })).error, /ao menos 1/);
  assert.match((await run("keyboard_press", { keys: ["a", "b", "c", "d", "e"] })).error, /no máximo 4/);
  assert.match((await run("keyboard_press", { keys: "enter" })).error, /array/);
  assert.match((await run("keyboard_type", { text: "" })).error, /vazio/);
  assert.match((await run("keyboard_type", { text: "x".repeat(2001) })).error, /no máximo 2000/);
  assert.equal(driver.calls.length, n);
});

test("TODAS as ferramentas de tela exigem confirmação; sem confirm, nada acontece", async () => {
  const { registry, driver } = setup();
  for (const [name, input] of [["screenshot", {}], ["keyboard_type", { text: "x" }], ["keyboard_press", { keys: ["a"] }]]) {
    const r = await registry.execute(name, input); // sem confirm
    assert.equal(r.denied, true, name);
  }
  assert.deepEqual(driver.calls, []);
});

test("aprovar 'toda a sessão' vale por ferramenta, não para as outras", async () => {
  const { registry, driver } = setup();
  let asked = 0;
  const confirm = async ({ tool }) => (asked++, tool === "screenshot" ? "always" : "no");
  await registry.execute("screenshot", {}, { confirm });
  await registry.execute("screenshot", {}, { confirm });
  assert.equal(asked, 1);
  const typed = await registry.execute("keyboard_type", { text: "senha" }, { confirm });
  assert.equal(typed.denied, true);
  assert.equal(asked, 2);
  assert.deepEqual(driver.calls, []);
});

test("o texto digitado aparece para o usuário aprovar, mas NÃO vai para o log", async () => {
  const entries = [];
  const driver = fakeDriver();
  const registry = new ToolRegistry({ actionLog: { record: (e) => entries.push(e) } });
  for (const tool of createComputerTools({ driver, actionDelayMs: 0 })) registry.register(tool);
  let shown;
  await registry.execute("keyboard_type", { text: "SenhaSuperSecreta123" }, { confirm: async (r) => ((shown = r.description), "yes") });
  await registry.execute("keyboard_type", { text: "OutraSenha456" }, { confirm: async () => "no" });
  assert.match(shown, /SenhaSuperSecreta123/);
  assert.ok(!JSON.stringify(entries).includes("SenhaSuperSecreta123"));
  assert.ok(!JSON.stringify(entries).includes("OutraSenha456"));
  assert.equal(entries.length, 2);
});

test("falhas do driver viram erro claro (não derrubam o agente)", async () => {
  const { registry, driver } = setup();
  driver.captureScreenshot = async () => { throw new Error("permissão de gravação de tela negada"); };
  const shot = await registry.execute("screenshot", {}, { confirm: async () => "yes" });
  assert.equal(shot.ok, false);
  assert.match(shot.error, /permissão de gravação de tela negada/);

  driver.captureScreenshot = async () => ({ png: Buffer.from("não é png") });
  assert.match((await registry.execute("screenshot", {}, { confirm: async () => "yes" })).error, /não é um PNG válido/);

  driver.captureScreenshot = async () => ({ png: makePng(100, 100) });
  await registry.execute("screenshot", {}, { confirm: async () => "yes" });
  driver.typeText = async () => { throw new Error("teclado indisponível"); };
  assert.match((await registry.execute("keyboard_type", { text: "a" }, { confirm: async () => "yes" })).error, /teclado indisponível/);
});
