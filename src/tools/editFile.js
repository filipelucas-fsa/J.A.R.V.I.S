import fs from "node:fs/promises";
import { resolveInWorkspace, explainFsError } from "./workspace.js";

const MAX_BYTES = 1_000_000;
const PREVIEW_CHARS = 400;

function preview(text) {
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "…" : text;
}

function countOccurrences(text, part) {
  let count = 0;
  // Avança 1 (não o tamanho do trecho) para contar também ocorrências sobrepostas: "aa" aparece 2 vezes em "aaa".
  for (let index = text.indexOf(part); index !== -1; index = text.indexOf(part, index + 1)) count += 1;
  return count;
}

// Troca UM trecho de um arquivo existente. SEMPRE pede confirmação.
export function createEditFileTool({ workspaceDir }) {
  async function plan({ path: filePath, old_string: oldString, new_string: newString }) {
    if (oldString === "") throw new Error("'old_string' não pode ser vazio.");
    if (oldString === newString) throw new Error("'old_string' e 'new_string' são iguais: não há nada a alterar.");

    const target = await resolveInWorkspace(workspaceDir, filePath);
    const stats = await fs.stat(target);
    if (stats.isDirectory()) throw new Error(`'${filePath}' é um diretório, não um arquivo.`);
    if (!stats.isFile()) throw new Error(`'${filePath}' não é um arquivo comum.`);
    if (stats.size > MAX_BYTES) throw new Error(`Arquivo grande demais para editar (${stats.size} bytes; máximo ${MAX_BYTES}).`);

    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) throw new Error(`'${filePath}' parece ser um arquivo binário.`);
    const original = buffer.toString("utf8");

    const matches = countOccurrences(original, oldString);
    if (matches === 0) {
      throw new Error(
        `O trecho de 'old_string' não foi encontrado em '${filePath}'. Confira espaços, indentação e quebras de linha (\\r\\n) — use read_file para ver o texto exato.`
      );
    }
    if (matches > 1) {
      throw new Error(`O trecho aparece ${matches} vezes em '${filePath}'. Inclua mais contexto em 'old_string' para que seja único.`);
    }

    // Fatiando (em vez de String.replace) para que "$&", "$1" etc. em new_string sejam tratados como texto comum.
    const index = original.indexOf(oldString);
    const updated = original.slice(0, index) + newString + original.slice(index + oldString.length);
    return { target, updated };
  }

  return {
    name: "edit_file",
    description:
      "Edita um arquivo de texto existente substituindo um trecho exato ('old_string') por outro ('new_string'). " +
      "'old_string' deve aparecer exatamente uma vez no arquivo. O usuário precisa aprovar cada edição.",
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho do arquivo, relativo ao diretório de trabalho." },
        old_string: { type: "string", description: "Trecho exato a substituir (deve ser único no arquivo)." },
        new_string: { type: "string", description: "Texto que entra no lugar." },
      },
      required: ["path", "old_string", "new_string"],
    },

    async prepare(input) {
      try {
        await plan(input);
        return `Editar '${input.path}': substituir 1 trecho\n--- remover ---\n${preview(input.old_string)}\n--- inserir ---\n${preview(input.new_string)}`;
      } catch (error) {
        if (error.code) throw new Error(explainFsError(error, input.path, { action: "editar" }));
        throw error;
      }
    },

    async execute(input) {
      try {
        const { target, updated } = await plan(input);
        await fs.writeFile(target, updated);
        return `Arquivo editado: '${input.path}' (1 trecho substituído).`;
      } catch (error) {
        if (error.code) throw new Error(explainFsError(error, input.path, { action: "editar" }));
        throw error;
      }
    },
  };
}
