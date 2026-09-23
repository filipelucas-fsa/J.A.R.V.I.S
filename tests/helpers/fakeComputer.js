import crypto from "node:crypto";
import pngjs from "pngjs";

const { PNG } = pngjs;

// PNG sintético: gradiente (comprime bem) ou ruído (comprime mal).
export function makePng(width, height, { noise = false } = {}) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = Math.floor(i / width);
    png.data[i * 4] = noise ? crypto.randomInt(256) : (x * 255) / width;
    png.data[i * 4 + 1] = noise ? crypto.randomInt(256) : (y * 255) / height;
    png.data[i * 4 + 2] = noise ? crypto.randomInt(256) : 128;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

// Driver falso: registra tudo que "faria" na tela.
export function fakeDriver({ screen = { width: 1920, height: 1080 }, capture = { width: 1920, height: 1080 } } = {}) {
  const driver = {
    calls: [],
    screen: { ...screen },
    async getScreenInfo() { return { ...driver.screen }; },
    async captureScreenshot() { return { png: makePng(capture.width, capture.height) }; },
    async moveMouse(x, y) { driver.calls.push(["move", x, y]); },
    async click(o) { driver.calls.push(["click", o]); },
    async typeText(t) { driver.calls.push(["type", t]); },
    async pressKeys(k) { driver.calls.push(["keys", k]); },
  };
  return driver;
}

