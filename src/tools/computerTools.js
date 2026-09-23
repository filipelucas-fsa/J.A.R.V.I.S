import { prepareScreenshot } from "../computer/image.js";

// ---- Teclas aceitas (validadas aqui, independentemente do driver) ----
const KEY_ALIASES = {
  ctrl: "control", esc: "escape", return: "enter", cmd: "meta", command: "meta", super: "meta", win: "meta",
  windows: "meta", del: "delete", pgup: "pageup", pgdn: "pagedown", arrowup: "up", arrowdown: "down",
  arrowleft: "left", arrowright: "right", " ": "space",
};
const NAMED_KEYS = new Set([
  "control", "shift", "alt", "meta", "enter", "escape", "tab", "space", "backspace", "delete",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
]);

// Retorna o nome canônico da tecla, ou null se não for suportada.
export function normalizeKey(key) {
  if (typeof key !== "string") return null;
  const lower = key.toLowerCase();
  const name = KEY_ALIASES[lower] ?? lower;
  if (NAMED_KEYS.has(name) || /^f([1-9]|1[0-2])$/.test(name) || /^[a-z0-9]$/.test(name)) return name;
  return null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cria as ferramentas de tela, mouse e teclado sobre um "driver" (veja nutDriver.js).
// Todas exigem confirmação; o usuário pode aprovar "todas desta ferramenta nesta sessão".
export function createComputerTools({ driver, actionDelayMs = 300, sleep = defaultSleep }) {
  // Lembra do último screenshot: as coordenadas do modelo são pixels DA IMAGEM que ele viu,
  // e precisam ser convertidas para a tela real.
  let view = null; // { imageWidth, imageHeight, screenWidth, screenHeight }

  async function toScreenPoint(x, y) {
    if (!view) throw new Error("Tire um screenshot antes de usar o mouse: as coordenadas dependem dele.");
    if (x < 0 || y < 0 || x >= view.imageWidth || y >= view.imageHeight) {
      throw new Error(`Coordenada (${x}, ${y}) fora da imagem do screenshot (${view.imageWidth}x${view.imageHeight}).`);
    }
    const screen = await driver.getScreenInfo();
    if (screen.width !== view.screenWidth || screen.height !== view.screenHeight) {
      view = null;
      throw new Error("A resolução da tela mudou desde o último screenshot. Tire um novo screenshot.");
    }
    return {
      x: Math.min(screen.width - 1, Math.round((x * screen.width) / view.imageWidth)),
      y: Math.min(screen.height - 1, Math.round((y * screen.height) / view.imageHeight)),
    };
  }

  const coordinateParams = {
    x: { type: "integer", minimum: 0, description: "Coordenada X, em pixels da imagem do último screenshot." },
    y: { type: "integer", minimum: 0, description: "Coordenada Y, em pixels da imagem do último screenshot." },
  };

  const screenshot = {
    name: "screenshot",
    description:
      "Captura a tela inteira e mostra a imagem. Devolve as dimensões da imagem: use essas coordenadas em mouse_move e mouse_click.",
    requiresConfirmation: true,
    allowSessionApproval: true,
    inputSchema: { type: "object", properties: {} },
    async prepare() {
      return "Capturar a tela inteira e enviar a imagem ao modelo (a imagem pode conter informações sensíveis).";
    },
    async execute() {
      const shot = await driver.captureScreenshot();
      const screen = await driver.getScreenInfo();
      const prepared = prepareScreenshot(shot.png);
      view = { imageWidth: prepared.width, imageHeight: prepared.height, screenWidth: screen.width, screenHeight: screen.height };
      return {
        text: `Screenshot ${prepared.width}x${prepared.height}. As coordenadas (x, y) do mouse usam o espaço desta imagem (origem no canto superior esquerdo).`,
        images: [{ mediaType: "image/png", data: prepared.png.toString("base64") }],
      };
    },
  };

  const mouseMove = {
    name: "mouse_move",
    description: "Move o ponteiro do mouse para uma posição da imagem do último screenshot (sem clicar).",
    requiresConfirmation: true,
    allowSessionApproval: true,
    inputSchema: { type: "object", properties: { ...coordinateParams }, required: ["x", "y"] },
    async prepare({ x, y }) {
      const target = await toScreenPoint(x, y);
      return `Mover o mouse para (${x}, ${y}) da imagem → posição real (${target.x}, ${target.y}) na tela.`;
    },
    async execute({ x, y }) {
      const target = await toScreenPoint(x, y);
      await driver.moveMouse(target.x, target.y);
      await sleep(actionDelayMs);
      return `Mouse movido para (${x}, ${y}). Tire um screenshot para ver o resultado.`;
    },
  };

  const mouseClick = {
    name: "mouse_click",
    description: "Clica em uma posição da imagem do último screenshot. Opcionalmente botão direito/meio ou duplo clique.",
    requiresConfirmation: true,
    allowSessionApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        ...coordinateParams,
        button: { type: "string", enum: ["left", "right", "middle"], description: "Botão (padrão: left)." },
        double: { type: "boolean", description: "true para duplo clique (padrão: false)." },
      },
      required: ["x", "y"],
    },
    async prepare({ x, y, button = "left", double = false }) {
      const target = await toScreenPoint(x, y);
      return `${double ? "Duplo clique" : "Clique"} (botão ${button}) em (${x}, ${y}) da imagem → posição real (${target.x}, ${target.y}) na tela.`;
    },
    async execute({ x, y, button = "left", double = false }) {
      const target = await toScreenPoint(x, y);
      await driver.click({ x: target.x, y: target.y, button, double });
      await sleep(actionDelayMs);
      return `${double ? "Duplo clique" : "Clique"} (${button}) executado em (${x}, ${y}). Tire um screenshot para ver o resultado.`;
    },
  };

  const keyboardType = {
    name: "keyboard_type",
    description: "Digita um texto na janela que estiver com o foco. Para atalhos e teclas especiais use keyboard_press.",
    requiresConfirmation: true,
    allowSessionApproval: true,
    redact: ["text"], // o que é digitado pode ser uma senha: não vai para o log de ações
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 2000, description: "Texto a digitar." } },
      required: ["text"],
    },
    async prepare({ text }) {
      if (text === "") throw new Error("O texto não pode ser vazio.");
      const shown = text.length > 200 ? text.slice(0, 200) + "…" : text;
      return `Digitar ${text.length} caractere(s) na janela em foco: "${shown}"`;
    },
    async execute({ text }) {
      if (text === "") throw new Error("O texto não pode ser vazio.");
      await driver.typeText(text);
      await sleep(actionDelayMs);
      return `Texto digitado (${text.length} caracteres). Tire um screenshot para ver o resultado.`;
    },
  };

  function normalizeKeys(keys) {
    const invalid = keys.filter((key) => normalizeKey(key) === null);
    if (invalid.length > 0) {
      throw new Error(
        `Tecla(s) não suportada(s): ${invalid.map((k) => `'${k}'`).join(", ")}. ` +
          "Aceitas: letras e números, F1–F12, control, shift, alt, meta, enter, escape, tab, space, backspace, delete, setas, home, end, pageup, pagedown."
      );
    }
    return keys.map(normalizeKey);
  }

  const keyboardPress = {
    name: "keyboard_press",
    description:
      "Pressiona uma tecla ou combinação na janela em foco, ex.: ['enter'], ['control', 'c'], ['alt', 'f4']. Modificadores primeiro.",
    requiresConfirmation: true,
    allowSessionApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4, description: "Teclas da combinação, em ordem." },
      },
      required: ["keys"],
    },
    async prepare({ keys }) {
      return `Pressionar a combinação de teclas: ${normalizeKeys(keys).join(" + ")}`;
    },
    async execute({ keys }) {
      const names = normalizeKeys(keys);
      await driver.pressKeys(names);
      await sleep(actionDelayMs);
      return `Teclas pressionadas: ${names.join(" + ")}. Tire um screenshot para ver o resultado.`;
    },
  };

  return [screenshot, mouseMove, mouseClick, keyboardType, keyboardPress];
}
