import pngjs from "pngjs";

const { PNG } = pngjs;

// Limites de imagem em tool_result. A API NÃO redimensiona screenshots devolvidos por ferramentas:
// se passarem do limite, a requisição é rejeitada. Usamos os limites do nível padrão (o mais restrito),
// que funcionam em qualquer modelo.
export const MAX_EDGE = 1568; // pixels no lado maior
export const MAX_PIXELS = 1_150_000; // ~1,15 megapixel
export const MAX_VISUAL_TOKENS = 1568; // ceil(largura/28) * ceil(altura/28)
export const MAX_PNG_BYTES = 4 * 1024 * 1024; // folga sob o limite de 5 MB da API
const PATCH = 28;

export function visualTokens(width, height) {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
}

function fits(width, height) {
  return (
    Math.max(width, height) <= MAX_EDGE &&
    width * height <= MAX_PIXELS &&
    visualTokens(width, height) <= MAX_VISUAL_TOKENS
  );
}

// Maior tamanho (mesmo formato) que respeita todos os limites. Imagens que já cabem não mudam.
export function fitSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Dimensões de imagem inválidas: ${width}x${height}.`);
  }
  if (fits(width, height)) return { width, height };

  let scale = Math.min(MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  for (let i = 0; i < 200; i++) {
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    if (fits(w, h)) return { width: w, height: h };
    scale *= 0.98;
  }
  throw new Error(`Não foi possível ajustar ${width}x${height} aos limites da API.`);
}

// Reduz uma imagem RGBA fazendo a média dos pixels de origem de cada pixel de destino.
export function resizeRGBA(data, width, height, newWidth, newHeight) {
  const out = Buffer.alloc(newWidth * newHeight * 4);
  const xRatio = width / newWidth;
  const yRatio = height / newHeight;

  for (let dy = 0; dy < newHeight; dy++) {
    const y0 = Math.floor(dy * yRatio);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil((dy + 1) * yRatio)));
    for (let dx = 0; dx < newWidth; dx++) {
      const x0 = Math.floor(dx * xRatio);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((dx + 1) * xRatio)));

      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const o = (dy * newWidth + dx) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

function encodePng(width, height, data) {
  const png = new PNG({ width, height });
  png.data = data;
  return PNG.sync.write(png);
}

// Prepara um screenshot (PNG) para ser devolvido ao modelo: cabe nos limites de dimensão e de bytes.
// Retorna { png: Buffer, width, height, originalWidth, originalHeight }.
export function prepareScreenshot(pngBuffer, { maxBytes = MAX_PNG_BYTES } = {}) {
  let source;
  try {
    source = PNG.sync.read(pngBuffer);
  } catch (error) {
    throw new Error(`A captura de tela não é um PNG válido (${error.message}).`);
  }

  let { width, height } = fitSize(source.width, source.height);
  for (let attempt = 0; attempt < 8; attempt++) {
    const unchanged = width === source.width && height === source.height;
    const png = unchanged ? pngBuffer : encodePng(width, height, resizeRGBA(source.data, source.width, source.height, width, height));
    if (png.length <= maxBytes) {
      return { png, width, height, originalWidth: source.width, originalHeight: source.height };
    }
    width = Math.max(1, Math.floor(width * 0.8));
    height = Math.max(1, Math.floor(height * 0.8));
  }
  throw new Error(`Não foi possível reduzir o screenshot para menos de ${(maxBytes / 1024 / 1024).toFixed(1)} MB.`);
}
