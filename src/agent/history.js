// Funções que cuidam do histórico de mensagens enviado à API.
// A API é rígida: um histórico fora das regras devolve erro 400. Aqui garantimos as regras localmente.

export const MAX_TOOL_TEXT_CHARS = 50_000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // limite da API por imagem
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const OLD_IMAGE_PLACEHOLDER = "[screenshot antigo removido do histórico para economizar contexto]";

// Retorna o motivo pelo qual a imagem não pode ser enviada, ou null se está ok.
function findImageProblem(image) {
  if (!image || !IMAGE_TYPES.includes(image.mediaType)) {
    return `tipo de imagem não suportado (${image?.mediaType})`;
  }
  const data = image.data;
  if (typeof data !== "string" || data === "") return "imagem vazia";
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return "base64 inválido";
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bytes = (data.length / 4) * 3 - padding;
  if (bytes > MAX_IMAGE_BYTES) {
    return `imagem grande demais (${(bytes / 1024 / 1024).toFixed(1)} MB; o máximo da API é 5 MB)`;
  }
  return null;
}

// Transforma o resultado do registry no bloco "tool_result" que a API espera.
// Recebe: toolUseId (do pedido do modelo) e result ({ ok, output, images } ou { ok:false, error }).
export function buildToolResultBlock(toolUseId, result) {
  let text = result.ok ? result.output : result.error;
  text = typeof text === "string" ? text : String(text ?? "");

  if (text.length > MAX_TOOL_TEXT_CHARS) {
    text = text.slice(0, MAX_TOOL_TEXT_CHARS) + `\n\n[saída truncada: ${text.length} caracteres no total]`;
  }
  // A API rejeita is_error com conteúdo vazio; por segurança nunca enviamos texto vazio.
  if (text.trim() === "") text = result.ok ? "(sem saída)" : "Erro desconhecido.";

  const blocks = [];
  if (result.ok) {
    for (const image of result.images ?? []) {
      const problem = findImageProblem(image);
      if (problem) {
        text += `\n[imagem descartada: ${problem}]`;
      } else {
        blocks.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
      }
    }
  }

  const block = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: blocks.length > 0 ? [{ type: "text", text }, ...blocks] : text,
  };
  if (!result.ok) block.is_error = true;
  return block;
}

// Mantém só as N imagens mais recentes no histórico; as antigas viram um texto curto.
// Sem isso, cada screenshot fica no contexto para sempre e estoura custo e limite de tamanho.
export function pruneOldImages(messages, keep) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user" || !Array.isArray(message.content)) continue;

    for (const block of [...message.content].reverse()) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      for (let j = block.content.length - 1; j >= 0; j--) {
        if (block.content[j].type !== "image") continue;
        seen += 1;
        if (seen > keep) block.content[j] = { type: "text", text: OLD_IMAGE_PLACEHOLDER };
      }
    }
  }
}

// Confere as regras da API ANTES de enviar. Lança um Error claro em vez de deixar a API responder 400.
export function assertValidHistory(messages) {
  const fail = (index, reason) => {
    throw new Error(`Histórico de mensagens inválido (mensagem ${index}): ${reason}.`);
  };

  if (!Array.isArray(messages) || messages.length === 0) fail(0, "o histórico está vazio");
  if (messages.at(-1).role !== "user") fail(messages.length - 1, "a última mensagem deve ser do usuário");

  messages.forEach((message, index) => {
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (message.role !== expected) fail(index, `esperava o papel '${expected}' (os papéis devem alternar)`);
    if (typeof message.content === "string") {
      if (message.content.trim() === "") fail(index, "conteúdo vazio");
    } else if (!Array.isArray(message.content) || message.content.length === 0) {
      fail(index, "conteúdo vazio ou inválido");
    }
  });

  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;

    if (message.role === "assistant") {
      const uses = message.content.filter((b) => b.type === "tool_use");
      if (uses.length === 0) return;

      for (const use of uses) {
        if (!TOOL_ID_PATTERN.test(use.id ?? "")) fail(index, `tool_use com id inválido (${use.id})`);
      }
      const next = messages[index + 1];
      const nextBlocks = Array.isArray(next?.content) ? next.content : [];
      const resultIds = nextBlocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
      const useIds = uses.map((u) => u.id);

      const missing = useIds.filter((id) => !resultIds.includes(id));
      if (missing.length > 0) fail(index + 1, `faltam tool_result para os pedidos: ${missing.join(", ")}`);
      if (new Set(resultIds).size !== resultIds.length) fail(index + 1, "há tool_result duplicado");
    } else {
      const results = message.content.filter((b) => b.type === "tool_result");
      if (results.length === 0) return;

      const previous = messages[index - 1];
      const previousIds = Array.isArray(previous?.content)
        ? previous.content.filter((b) => b.type === "tool_use").map((b) => b.id)
        : [];
      for (const result of results) {
        if (!previousIds.includes(result.tool_use_id)) {
          fail(index, `tool_result sem tool_use correspondente na mensagem anterior (${result.tool_use_id})`);
        }
        const empty =
          result.content === undefined ||
          result.content === "" ||
          (Array.isArray(result.content) && result.content.length === 0);
        if (result.is_error && empty) fail(index, "tool_result com is_error e conteúdo vazio");
        if (Array.isArray(result.content)) {
          for (const inner of result.content) {
            if (inner.type !== "image") continue;
            const problem = findImageProblem({ mediaType: inner.source?.media_type, data: inner.source?.data });
            if (problem) fail(index, problem);
          }
        }
      }
      const firstOther = message.content.findIndex((b) => b.type !== "tool_result");
      if (firstOther !== -1 && message.content.slice(firstOther).some((b) => b.type === "tool_result")) {
        fail(index, "os blocos tool_result devem vir antes de qualquer outro conteúdo");
      }
    }
  });
}
