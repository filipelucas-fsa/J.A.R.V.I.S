import fs from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace, explainFsError } from "./workspace.js";

const MAX_CONTENT_CHARS = 1_000_000;
const MAX_BYTES = 1_000_000;
const PREVIEW_CHARS = 600;

function preview(text) {
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "\n…(continua)" : text;
}

// Cria ou sobrescreve um arquivo de texto dentro do workspace. SEMPRE pede confirmação.
export function createWriteFileTool({ workspaceDir }) {
  // Valida tudo e descobre o que aconteceria. Usada por prepare (antes de perguntar) e por execute (antes de gravar).
  async function plan({ path: filePath, content, overwrite = false }) {
    const target = await resolveInWorkspace(workspaceDir, filePath);

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_BYTES) throw new Error(`Conteúdo grande demais (${bytes} bytes; máximo ${MAX_BYTES}).`);

    let existing = null;
    try {
      existing = await fs.lstat(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (existing) {
      if (existing.isDirectory()) throw new Error(`'${filePath}' é um diretório, não um arquivo.`);
      if (!existing.isFile()) throw new Error(`'${filePath}' não é um arquivo comum.`);
      if (!overwrite) {
        throw new Error(
          `'${filePath}' já existe. Use edit_file para alterar um trecho, ou write_file com overwrite=true para substituir tudo.`
        );
      }
    }
    return { target, existingSize: existing?.size ?? null, bytes };
  }

  return {
    name: "write_file",
    description:
      "Cria um arquivo de texto no diretório de trabalho (cria as pastas que faltarem). " +
      "Se o arquivo já existir, só será substituído com overwrite=true; para mudar apenas um trecho use edit_file. " +
      "O usuário precisa aprovar cada escrita.",
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho do arquivo, relativo ao diretório de trabalho." },
        content: { type: "string", maxLength: MAX_CONTENT_CHARS, description: "Conteúdo completo do arquivo." },
        overwrite: { type: "boolean", description: "true para substituir um arquivo existente (padrão: false)." },
      },
      required: ["path", "content"],
    },

    async prepare(input) {
      try {
        const { existingSize, bytes } = await plan(input);
        const action =
          existingSize === null
            ? `Criar o arquivo '${input.path}' (${bytes} bytes)`
            : `SOBRESCREVER o arquivo existente '${input.path}' (de ${existingSize} para ${bytes} bytes)`;
        return `${action}\n--- início do conteúdo ---\n${preview(input.content)}`;
      } catch (error) {
        if (error.code) throw new Error(explainFsError(error, input.path, { action: "escrever" }));
        throw error;
      }
    },

    async execute(input) {
      try {
        const { target, existingSize, bytes } = await plan(input);
        await fs.mkdir(path.dirname(target), { recursive: true });
        // Arquivo novo: flag "wx" falha se algo já existir no caminho (inclusive link simbólico) — evita corrida.
        await fs.writeFile(target, input.content, existingSize === null ? { flag: "wx" } : undefined);
        return `Arquivo ${existingSize === null ? "criado" : "sobrescrito"}: '${input.path}' (${bytes} bytes).`;
      } catch (error) {
        if (error.code) throw new Error(explainFsError(error, input.path, { action: "escrever" }));
        throw error;
      }
    },
  };
}
