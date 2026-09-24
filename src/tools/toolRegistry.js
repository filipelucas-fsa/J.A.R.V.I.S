// Catálogo e ponto único de execução das ferramentas do agente.
//
// Formato de uma ferramenta:
// {
//   name: "read_file",
//   description: "...",        // o modelo lê isso para decidir quando usar a ferramenta
//   inputSchema: {             // parâmetros, em JSON Schema (formato que a API espera)
//     type: "object",
//     properties: { path: { type: "string", description: "..." } },
//     required: ["path"],
//   },
//   execute: async (input, { signal }) => "texto"  // ou { text, images: [{ mediaType, data }] }
//
//   // --- opcionais ---
//   requiresConfirmation: true,    // pede permissão ao usuário antes de executar
//   allowSessionApproval: true,     // o usuário pode aprovar "todas desta ferramenta nesta sessão"
//   prepare: async (input) => "descrição mostrada ao usuário" // roda ANTES de pedir permissão;
//                                                             // lance Error para recusar sem incomodar o usuário
//   redact: ["text"],              // parâmetros que não devem aparecer no log de ações
//   coerceInput: (input) => input, // limpeza ANTES da validação (ex.: modelos que mandam números como texto)
// }

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PARAM_TYPES = ["string", "number", "integer", "boolean", "array"];
const ITEM_TYPES = ["string", "number", "integer", "boolean"];
const MAX_PROMPT_INPUT_CHARS = 300;

function describeInputForPrompt(input) {
  const text = JSON.stringify(input);
  return text.length > MAX_PROMPT_INPUT_CHARS ? text.slice(0, MAX_PROMPT_INPUT_CHARS) + "…" : text;
}

// ---------- validação da DEFINIÇÃO da ferramenta (roda no register) ----------

function assertValidSpec(toolName, param, spec, allowedTypes) {
  const fail = (reason) => {
    throw new Error(`Ferramenta inválida: parâmetro '${param}' de '${toolName}' ${reason}.`);
  };
  if (typeof spec !== "object" || spec === null || !allowedTypes.includes(spec.type)) {
    fail(`tem tipo não suportado (suportados: ${allowedTypes.join(", ")})`);
  }
  if (spec.enum !== undefined) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0) fail("tem 'enum' vazio ou inválido");
    if (spec.type === "array" || spec.type === "boolean") fail("não pode ter 'enum' neste tipo");
  }
  if (spec.type === "array") {
    assertValidSpec(toolName, `${param}[]`, spec.items, ITEM_TYPES);
  }
}

function assertValidTool(tool) {
  const fail = (reason) => {
    throw new Error(`Ferramenta inválida: ${reason}`);
  };

  if (typeof tool !== "object" || tool === null) fail("deve ser um objeto.");
  if (typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
    fail("'name' deve conter só letras, números, _ ou - (até 64 caracteres).");
  }
  if (typeof tool.description !== "string" || tool.description.trim() === "") {
    fail(`'${tool.name}' precisa de uma 'description'.`);
  }
  if (typeof tool.execute !== "function") {
    fail(`'${tool.name}' precisa de uma função 'execute'.`);
  }
  if (tool.prepare !== undefined && typeof tool.prepare !== "function") {
    fail(`'prepare' de '${tool.name}' deve ser uma função.`);
  }
  if (tool.coerceInput !== undefined && typeof tool.coerceInput !== "function") {
    fail(`'coerceInput' de '${tool.name}' deve ser uma função.`);
  }

  const schema = tool.inputSchema;
  if (typeof schema !== "object" || schema === null || schema.type !== "object") {
    fail(`'${tool.name}' precisa de 'inputSchema' com type "object".`);
  }
  const properties = schema.properties ?? {};
  for (const [param, spec] of Object.entries(properties)) {
    assertValidSpec(tool.name, param, spec, PARAM_TYPES);
  }
  for (const param of schema.required ?? []) {
    if (!Object.hasOwn(properties, param)) {
      fail(`'${tool.name}' marca '${param}' como obrigatório, mas não o declara em 'properties'.`);
    }
  }
}

// ---------- validação dos PARÂMETROS recebidos do modelo (roda no execute) ----------

// Retorna uma mensagem de problema ou null.
function findValueProblem(value, spec) {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return "deve ser do tipo string";
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return `deve ter no máximo ${spec.maxLength} caracteres (tem ${value.length})`;
      }
      break;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return `deve ser do tipo ${spec.type}`;
      if (spec.type === "integer" && !Number.isInteger(value)) return "deve ser do tipo integer";
      if (spec.minimum !== undefined && value < spec.minimum) return `deve ser >= ${spec.minimum}`;
      if (spec.maximum !== undefined && value > spec.maximum) return `deve ser <= ${spec.maximum}`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return "deve ser do tipo boolean";
      break;
    case "array": {
      if (!Array.isArray(value)) return "deve ser do tipo array";
      if (spec.minItems !== undefined && value.length < spec.minItems) return `deve ter ao menos ${spec.minItems} item(ns)`;
      if (spec.maxItems !== undefined && value.length > spec.maxItems) return `deve ter no máximo ${spec.maxItems} item(ns)`;
      for (const [index, item] of value.entries()) {
        const problem = findValueProblem(item, spec.items);
        if (problem) return `item ${index} ${problem}`;
      }
      break;
    }
  }
  if (spec.enum !== undefined && !spec.enum.includes(value)) {
    return `deve ser um dos valores: ${spec.enum.join(", ")}`;
  }
  return null;
}

function findInputProblem(schema, input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "os parâmetros devem ser um objeto";
  }

  const properties = schema.properties ?? {};

  for (const param of schema.required ?? []) {
    if (!Object.hasOwn(input, param)) return `o parâmetro '${param}' é obrigatório`;
  }

  for (const [param, value] of Object.entries(input)) {
    if (!Object.hasOwn(properties, param)) {
      const accepted = Object.keys(properties).join(", ") || "nenhum";
      return `o parâmetro '${param}' não existe (aceitos: ${accepted})`;
    }
    const problem = findValueProblem(value, properties[param]);
    if (problem) return `o parâmetro '${param}' ${problem}`;
  }

  return null;
}

// ---------- normalização do que a ferramenta retorna ----------

function normalizeToolOutput(raw) {
  if (typeof raw === "string") return { text: raw, images: [] };
  if (raw && typeof raw === "object" && !Array.isArray(raw) && ("text" in raw || "images" in raw)) {
    const images = raw.images ?? [];
    if (!Array.isArray(images)) throw new Error("A ferramenta retornou 'images' inválido (deveria ser uma lista).");
    return { text: String(raw.text ?? ""), images };
  }
  return { text: String(raw), images: [] };
}

export class ToolRegistry {
  // actionLog (opcional): objeto com record(entry). Recebe TODA tentativa de execução.
  constructor({ actionLog } = {}) {
    this.tools = new Map();
    this.actionLog = actionLog;
    this.sessionApprovals = new Set();
  }

  register(tool) {
    assertValidTool(tool);
    if (this.tools.has(tool.name)) {
      throw new Error(`Ferramenta já registrada: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()];
  }

  // Formato que o modelo recebe: só o que ele precisa saber (sem a função execute).
  getDefinitions() {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  // Esquece as aprovações "para toda a sessão".
  resetApprovals() {
    this.sessionApprovals.clear();
  }

  #record(tool, name, input, outcome, detail, startedAt) {
    if (!this.actionLog) return;
    const redacted = { ...(typeof input === "object" && input !== null ? input : { valor: input }) };
    for (const param of tool?.redact ?? []) {
      if (param in redacted) {
        const size = typeof redacted[param] === "string" ? `${redacted[param].length} caracteres` : "valor";
        redacted[param] = `[oculto: ${size}]`;
      }
    }
    // Ferramentas com dados sensíveis (ex.: texto digitado): descrição, saída e mensagens também podem
    // conter esses dados, então nada disso vai para o log.
    const safeDetail = tool?.redact?.length ? "(detalhes omitidos: ferramenta com dados sensíveis)" : detail;
    this.actionLog.record({ tool: name, input: redacted, outcome, detail: safeDetail, ms: Date.now() - startedAt });
  }

  // Ponto único de execução. Nunca lança erro: sempre retorna
  //   { ok: true,  output: "texto", images: [] }
  //   { ok: false, error: "mensagem", denied?: true }
  // Assim o agente devolve o erro ao modelo em vez de quebrar.
  //
  // options.confirm(request) -> "yes" | "no" | "always". Sem confirm, ferramentas que exigem confirmação são NEGADAS.
  // options.signal -> AbortSignal repassado à ferramenta (para interromper comandos longos).
  async execute(name, input = {}, { confirm, signal } = {}) {
    const startedAt = Date.now();
    const tool = this.get(name);

    if (!tool) {
      const available = this.list().map((t) => t.name).join(", ") || "nenhuma";
      const error = `Ferramenta '${name}' não existe. Disponíveis: ${available}.`;
      this.#record(undefined, name, input, "unknown_tool", error, startedAt);
      return { ok: false, error };
    }

    // Modelos às vezes mandam números como texto ("130"). A ferramenta pode definir
    // coerceInput para limpar isso ANTES da validação; o que não der, a validação denuncia.
    if (typeof tool.coerceInput === "function" && typeof input === "object" && input !== null && !Array.isArray(input)) {
      try {
        input = tool.coerceInput(input);
      } catch {
        // limpeza com problema: segue com o input original e deixa a validação reclamar
      }
    }

    const problem = findInputProblem(tool.inputSchema, input);
    if (problem) {
      const error = `Parâmetros inválidos para '${name}': ${problem}.`;
      this.#record(tool, name, input, "invalid_params", error, startedAt);
      return { ok: false, error };
    }

    // Etapa "prepare": valida e monta a descrição ANTES de incomodar o usuário.
    let description = `${name} ${describeInputForPrompt(input)}`;
    if (tool.prepare) {
      try {
        const prepared = await tool.prepare(input);
        if (typeof prepared === "string" && prepared.trim() !== "") description = prepared;
      } catch (error) {
        const message = `Erro ao executar '${name}': ${error.message}`;
        this.#record(tool, name, input, "rejected", message, startedAt);
        return { ok: false, error: message };
      }
    }

    if (tool.requiresConfirmation && !this.sessionApprovals.has(name)) {
      let decision = "no"; // padrão: negar
      if (confirm) {
        try {
          decision = await confirm({
            tool: name,
            description,
            input,
            allowSessionApproval: Boolean(tool.allowSessionApproval),
          });
        } catch {
          decision = "no";
        }
      }
      if (decision === "always" && tool.allowSessionApproval) this.sessionApprovals.add(name);

      if (decision !== "yes" && decision !== "always") {
        const reason = confirm
          ? "O usuário NEGOU a execução ou a autorização expirou sem resposta"
          : "Não há como pedir confirmação ao usuário, então foi NEGADA";
        const error =
          `${reason} (${name}). Não repita a mesma ação nem tente por conta própria uma abordagem com efeitos ` +
          `colaterais maiores (ex.: baixar, instalar, apagar ou enviar algo): explique o que pretendia fazer e espere a orientação do usuário.`;
        this.#record(tool, name, input, "denied", description, startedAt);
        return { ok: false, denied: true, error };
      }
    }

    try {
      const { text, images } = normalizeToolOutput(await tool.execute(input, { signal }));
      this.#record(tool, name, input, "ok", text, startedAt);
      return { ok: true, output: text, images };
    } catch (error) {
      const message = `Erro ao executar '${name}': ${error?.message ?? String(error)}`;
      this.#record(tool, name, input, "error", message, startedAt);
      return { ok: false, error: message };
    }
  }
}
