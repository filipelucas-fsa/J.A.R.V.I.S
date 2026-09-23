import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Driver REAL de mouse, teclado e tela, usando a biblioteca @nut-tree-fork/nut-js.
// Ela é OPCIONAL: não está no npm install padrão (tem código nativo). Para usar:  npm install @nut-tree-fork/nut-js
//
// Interface que o restante do projeto espera de um driver (qualquer objeto com estes métodos serve, inclusive um falso nos testes):
//   getScreenInfo()            -> { width, height }   tamanho da tela no espaço de coordenadas do mouse
//   captureScreenshot()        -> { png: Buffer }     captura da tela inteira
//   moveMouse(x, y)
//   click({ x, y, button, double })
//   typeText(text)
//   pressKeys(names)           nomes canônicos, ex.: ["control", "c"]

function keyFor(Key, name) {
  const named = {
    control: "LeftControl", shift: "LeftShift", alt: "LeftAlt", meta: "LeftSuper",
    enter: "Enter", escape: "Escape", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete",
    up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  };
  let member = named[name];
  if (!member && /^f([1-9]|1[0-2])$/.test(name)) member = name.toUpperCase();
  if (!member && /^[a-z]$/.test(name)) member = name.toUpperCase();
  if (!member && /^[0-9]$/.test(name)) member = `Num${name}`;
  if (!member || Key[member] === undefined) throw new Error(`Tecla não suportada pelo driver: '${name}'.`);
  return Key[member];
}

export async function createNutDriver() {
  // Sem ambiente gráfico a biblioteca nativa faz "segmentation fault" e derruba o processo inteiro,
  // sem erro capturável. Por isso checamos ANTES de carregá-la.
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("Sem ambiente gráfico (DISPLAY não definido): não é possível controlar mouse, teclado e tela.");
  }

  let nut;
  try {
    nut = await import("@nut-tree-fork/nut-js");
  } catch (error) {
    throw new Error(
      "Não foi possível carregar '@nut-tree-fork/nut-js' (necessária para controlar mouse, teclado e tela). " +
        `Instale com: npm install @nut-tree-fork/nut-js\nDetalhe: ${error.message}`
    );
  }
  const { mouse, keyboard, screen, Point, Button, Key, FileType } = nut;
  mouse.config.autoDelayMs = 50;
  keyboard.config.autoDelayMs = 30;

  const buttons = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE };

  return {
    async getScreenInfo() {
      return { width: await screen.width(), height: await screen.height() };
    },

    async captureScreenshot() {
      const fileName = `agent-shot-${process.pid}-${Date.now()}.png`;
      const file = await screen.capture(fileName, FileType.PNG, os.tmpdir());
      const filePath = path.isAbsolute(file) ? file : path.join(os.tmpdir(), file);
      try {
        return { png: await fs.readFile(filePath) };
      } finally {
        await fs.rm(filePath, { force: true });
      }
    },

    async moveMouse(x, y) {
      await mouse.setPosition(new Point(x, y));
    },

    async click({ x, y, button = "left", double = false }) {
      await mouse.setPosition(new Point(x, y));
      if (double) await mouse.doubleClick(buttons[button]);
      else await mouse.click(buttons[button]);
    },

    async typeText(text) {
      await keyboard.type(text);
    },

    async pressKeys(names) {
      const keys = names.map((name) => keyFor(Key, name));
      await keyboard.pressKey(...keys);
      await keyboard.releaseKey(...[...keys].reverse());
    },
  };
}
