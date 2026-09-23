// Servidor que imita POST {base}/chat/completions no formato OpenAI, COM AS REGRAS RÍGIDAS desse protocolo
// (o que NVIDIA NIM, OpenAI, vLLM e Ollama exigem). Também injeta falhas.
import http from "node:http";

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function validateOpenAIRequest(body, { tokenParam = "max_tokens", allowSystem = true, supportsTools = true } = {}) {
  if (typeof body?.model !== "string" || body.model === "") return "model: field required";
  const other = tokenParam === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  if (body[other] !== undefined) return `Unsupported parameter: '${other}' is not supported with this model. Use '${tokenParam}' instead.`;
  if (!Number.isInteger(body[tokenParam]) || body[tokenParam] < 1) return `${tokenParam}: must be a positive integer`;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return "messages: at least one message is required";

  if (body.tools !== undefined) {
    if (!supportsTools) return "tools are not supported by this model (function calling disabled)";
    if (!Array.isArray(body.tools) || body.tools.length === 0) return "tools: must be a non-empty array";
    for (const tool of body.tools) {
      if (tool.type !== "function") return "tools.type: must be 'function'";
      if (!NAME_PATTERN.test(tool.function?.name ?? "")) return `tools.function.name invalid: ${tool.function?.name}`;
      if (tool.function?.parameters?.type !== "object") return `tools.${tool.function.name}.function.parameters.type must be 'object'`;
    }
  }

  let pending = new Set(); // ids de tool_calls ainda sem resposta
  let previousRole = null;
  for (const [i, m] of body.messages.entries()) {
    if (!["system", "user", "assistant", "tool"].includes(m.role)) return `messages.${i}.role: invalid role '${m.role}'`;
    if (m.role === "system" && !allowSystem) return "System role not supported for this model. Conversation roles must alternate user/assistant.";
    if (m.role === "system" && i !== 0) return `messages.${i}: system message must be first`;

    if (m.role !== "tool" && pending.size > 0) {
      return `messages.${i}: an assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. Missing: ${[...pending].join(", ")}`;
    }

    if (m.role === "assistant") {
      if (m.tool_calls !== undefined) {
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return `messages.${i}.tool_calls: must be a non-empty array`;
        for (const call of m.tool_calls) {
          if (typeof call.id !== "string" || call.id === "") return `messages.${i}.tool_calls.id: required`;
          if (call.type !== "function") return `messages.${i}.tool_calls.type: must be 'function'`;
          if (typeof call.function?.name !== "string") return `messages.${i}.tool_calls.function.name: required`;
          if (typeof call.function?.arguments !== "string") return `messages.${i}.tool_calls.function.arguments: must be a JSON string`;
          try { JSON.parse(call.function.arguments); } catch { return `messages.${i}.tool_calls.function.arguments: invalid JSON`; }
          pending.add(call.id);
        }
        if (m.content !== null && typeof m.content !== "string") return `messages.${i}.content: must be string or null`;
      } else if (typeof m.content !== "string" || m.content === "") {
        return `messages.${i}.content: assistant message must have content or tool_calls`;
      }
    } else if (m.role === "tool") {
      if (!pending.has(m.tool_call_id)) {
        return `messages.${i}: tool message with tool_call_id '${m.tool_call_id}' does not match any preceding tool_calls`;
      }
      if (typeof m.content !== "string" || m.content === "") return `messages.${i}.content: tool message content must be a non-empty string`;
      pending.delete(m.tool_call_id);
    } else if (m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content.trim() === "") return `messages.${i}.content: cannot be empty`;
      } else if (Array.isArray(m.content) && m.content.length > 0) {
        for (const part of m.content) {
          if (part.type === "text") {
            if (typeof part.text !== "string" || part.text === "") return `messages.${i}: text part must be non-empty`;
          } else if (part.type === "image_url") {
            const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url?.url ?? "");
            if (!match) return `messages.${i}: image_url.url must be a base64 data URL of an image`;
            if (Buffer.from(match[2], "base64").length > MAX_IMAGE_BYTES) return `messages.${i}: image exceeds the maximum size`;
          } else {
            return `messages.${i}: unsupported content part type '${part.type}'`;
          }
        }
      } else {
        return `messages.${i}.content: must be a non-empty string or array`;
      }
    }
    previousRole = m.role;
  }
  if (pending.size > 0) return `tool messages missing for tool_call ids: ${[...pending].join(", ")}`;
  if (previousRole === "assistant") return "the last message must not be from the assistant";
  return null;
}

// ---- construtores de respostas ----
export const toolCall = (id, name, args) => ({
  id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
export const chat = (content, { tool_calls, finish_reason, extra } = {}) => ({
  message: {
    choices: [{
      index: 0,
      message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}), ...extra },
      finish_reason: finish_reason ?? (tool_calls ? "tool_calls" : "stop"),
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
});
export const say = (text) => chat(text);
export const callTool = (id, name, args, text = null) => chat(text, { tool_calls: [toolCall(id, name, args)] });
export const httpError = (status, body, headers = {}) => ({ status, body, headers });
export const openaiError = (status, message, headers) => httpError(status, { error: { message, type: "invalid_request_error", code: null } }, headers);
// Formato de erro da NVIDIA: { status, title, detail }
export const nvidiaError = (status, title, detail, headers) => httpError(status, { status, title, detail }, headers);

export async function startMockOpenAI({ script = [], apiKey = "nvapi-test", basePath = "/v1", models = ["meta/llama-3.1-70b-instruct", "nvidia/nemotron-mini"], ...rules } = {}) {
  const requests = [];
  const queue = [...script];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json", ...headers });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
        return send(401, { status: 401, title: "Unauthorized", detail: "Authentication failed" });
      }

      if (req.method === "GET" && req.url === `${basePath}/models`) {
        requests.push({ method: "GET", url: req.url, headers: req.headers });
        return send(200, { object: "list", data: models.map((id) => ({ id, object: "model" })) });
      }
      if (req.method !== "POST" || req.url !== `${basePath}/chat/completions`) {
        return send(404, { status: 404, title: "Not Found", detail: `Function not found: ${req.url}` });
      }

      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(400, { error: { message: "invalid JSON" } });
      }
      requests.push({ method: "POST", url: req.url, headers: req.headers, body });

      const problem = validateOpenAIRequest(body, rules);
      if (problem) return send(400, { error: { message: problem, type: "invalid_request_error" } });

      const step = queue.shift();
      if (!step) return send(500, { error: { message: "mock: script esgotado" } });
      if (step.hang) return;
      if (step.destroy) return req.socket.destroy();
      if (step.raw !== undefined) return send(step.status ?? 200, step.raw);
      if (step.status) return send(step.status, step.body, step.headers);
      send(200, { id: "chatcmpl-mock", object: "chat.completion", created: 0, model: body.model, ...step.message });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}${basePath}`,
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    posts: () => requests.filter((r) => r.method === "POST"),
    remaining: () => queue.length,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
