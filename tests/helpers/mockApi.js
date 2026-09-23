// Servidor que imita POST /v1/messages COM AS REGRAS RÍGIDAS da API real.
// Se o agente enviar algo que a API real recusaria (erro 400), este servidor recusa também.
// Também injeta falhas (401, 404, 429, 500, 529, timeout, conexão caída, JSON quebrado).
import http from "node:http";

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

// Limites de imagem em tool_result (nível padrão de modelos): a API REJEITA em vez de redimensionar.
const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;
const MAX_TOKENS = 1568;

export function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function imageProblem(image, inToolResult) {
  const source = image.source;
  if (!source || source.type !== "base64") return "image.source.type deve ser base64";
  if (!IMAGE_TYPES.includes(source.media_type)) return `media_type inválido: ${source.media_type}`;
  if (typeof source.data !== "string" || source.data === "") return "image.source.base64 vazio";
  if (source.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.data)) return "image.source.base64: base64 inválido";
  const buffer = Buffer.from(source.data, "base64");
  if (buffer.length > MAX_IMAGE_BYTES) {
    return `image exceeds 5 MB maximum: ${buffer.length} bytes > ${MAX_IMAGE_BYTES} bytes`;
  }
  if (inToolResult && source.media_type === "image/png") {
    const size = pngSize(buffer);
    if (!size) return "image não é um PNG válido";
    const tokens = Math.ceil(size.width / 28) * Math.ceil(size.height / 28);
    if (Math.max(size.width, size.height) > MAX_EDGE || size.width * size.height > MAX_PIXELS || tokens > MAX_TOKENS) {
      return `tool_result image ${size.width}x${size.height} exceeds the model's image limits (screenshots are not resized automatically)`;
    }
  }
  return null;
}

// Retorna a mensagem de erro que a API real daria, ou null se a requisição é válida.
export function validateRequest(body) {
  if (typeof body?.model !== "string" || body.model === "") return "model: field required";
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return "max_tokens: must be a positive integer";
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) return "messages: at least one message is required";

  const hasToolBlocks = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" || b.type === "tool_result")
  );
  if (hasToolBlocks && (!Array.isArray(body.tools) || body.tools.length === 0)) {
    return "Requests which include `tool_use` or `tool_result` blocks must define tools.";
  }
  for (const tool of body.tools ?? []) {
    if (!NAME_PATTERN.test(tool.name ?? "")) return `tools.name: invalid name '${tool.name}'`;
    if (tool.input_schema?.type !== "object") return `tools.${tool.name}.input_schema.type: must be 'object'`;
  }

  for (const [i, m] of messages.entries()) {
    const expected = i % 2 === 0 ? "user" : "assistant";
    if (m.role !== expected) return `messages.${i}.role: roles must alternate between "user" and "assistant" (expected ${expected})`;
    const empty = typeof m.content === "string" ? m.content.trim() === "" : !Array.isArray(m.content) || m.content.length === 0;
    if (empty) return `messages.${i}: content cannot be empty`;
  }
  if (messages.at(-1).role !== "user") return "the last message must be a user message";

  for (const [i, m] of messages.entries()) {
    if (!Array.isArray(m.content)) continue;

    if (m.role === "assistant") {
      const uses = m.content.filter((b) => b.type === "tool_use");
      if (uses.length === 0) continue;
      for (const use of uses) if (!ID_PATTERN.test(use.id ?? "")) return `messages.${i}: tool_use.id invalid`;
      const results = (messages[i + 1]?.content ?? []).filter?.((b) => b.type === "tool_result") ?? [];
      const missing = uses.filter((u) => !results.some((r) => r.tool_use_id === u.id));
      if (missing.length > 0) {
        return `messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.map((u) => u.id).join(", ")}`;
      }
    } else {
      const blocks = m.content;
      const results = blocks.filter((b) => b.type === "tool_result");
      if (results.length === 0) {
        for (const [j, b] of blocks.entries()) {
          if (b.type === "image") {
            const problem = imageProblem(b, false);
            if (problem) return `messages.${i}.content.${j}: ${problem}`;
          }
        }
        continue;
      }
      const previousUses = (messages[i - 1]?.content ?? []).filter?.((b) => b.type === "tool_use") ?? [];
      const firstOther = blocks.findIndex((b) => b.type !== "tool_result");
      if (firstOther !== -1 && blocks.slice(firstOther).some((b) => b.type === "tool_result")) {
        return `messages.${i}: tool_result blocks must come first in the content array`;
      }
      for (const [j, r] of results.entries()) {
        if (!previousUses.some((u) => u.id === r.tool_use_id)) {
          return `messages.${i}.content.${j}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${r.tool_use_id}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`;
        }
        const content = r.content;
        const isEmpty = content === undefined || content === "" || (Array.isArray(content) && content.length === 0);
        if (r.is_error && isEmpty) return `messages.${i}.content.${j}: content cannot be empty if is_error is true`;
        if (Array.isArray(content)) {
          for (const [k, inner] of content.entries()) {
            if (inner.type === "text" && (typeof inner.text !== "string" || inner.text === "")) {
              return `messages.${i}.content.${j}.content.${k}.text: text content blocks must be non-empty`;
            }
            if (inner.type === "image") {
              const problem = imageProblem(inner, true);
              if (problem) return `messages.${i}.content.${j}.tool_result.content.${k}.image.source.base64: ${problem}`;
            }
          }
        }
      }
    }
  }
  return null;
}

// ---- construtores de respostas ----
export const text = (value) => ({ type: "text", text: value });
export const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
export const reply = (content, stop_reason = "end_turn") => ({ message: { content, stop_reason } });
export const say = (value) => reply([text(value)]);
export const callTool = (id, name, input) => reply([text("vou usar uma ferramenta"), toolUse(id, name, input)], "tool_use");
export const apiError = (status, type, message, headers = {}) => ({ status, headers, body: { type: "error", error: { type, message } } });

// script: lista de passos, um por requisição. Passos: reply(...) | apiError(...) | { hang: true } | { destroy: true } | { raw: "texto" }
export async function startMockApi({ script = [], apiKey = "test-key", models = null } = {}) {
  const requests = [];
  const queue = [...script];

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      chunks.push(chunk);
    });
    req.on("end", () => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      const fail = (status, type, message) => send(status, { type: "error", error: { type, message } });

      if (req.headers["x-api-key"] !== apiKey) return fail(401, "authentication_error", "invalid x-api-key");
      if (size > MAX_REQUEST_BYTES) return fail(413, "request_too_large", "Request exceeds the maximum allowed number of bytes.");

      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return fail(400, "invalid_request_error", "Invalid JSON");
      }
      requests.push({ headers: req.headers, body });

      if (models && !models.includes(body.model)) return fail(404, "not_found_error", `model: ${body.model}`);

      const problem = validateRequest(body);
      if (problem) return fail(400, "invalid_request_error", problem);

      const step = queue.shift();
      if (!step) return fail(500, "api_error", "mock: script esgotado (o agente fez mais requisições do que o esperado)");
      if (step.hang) return; // nunca responde
      if (step.destroy) return req.socket.destroy();
      if (step.raw !== undefined) return send(200, step.raw);
      if (step.status) return send(step.status, step.body, step.headers);

      send(200, {
        id: "msg_mock", type: "message", role: "assistant", model: body.model,
        content: step.message.content, stop_reason: step.message.stop_reason, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    remaining: () => queue.length,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
