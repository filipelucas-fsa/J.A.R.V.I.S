import fs from "node:fs/promises";
import { resolveInWorkspace, explainFsError } from "./workspace.js";

// Não enviamos arquivos enormes ao modelo: acima disso, lemos só o começo.
const MAX_BYTES = 100 * 1024;

// Cria a ferramenta read_file presa a um workspace.
// Recebe: { workspaceDir }   Retorna: objeto de ferramenta pronto para o registry.
export function createReadFileTool({ workspaceDir }) {
  return {
    name: "read_file",
    description:
      "Lê o conteúdo de um arquivo de texto do diretório de trabalho. " +
      "Use para ver o conteúdo de arquivos como package.json, código-fonte ou documentação. " +
      "Não lê diretórios nem arquivos binários.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho do arquivo, relativo ao diretório de trabalho (ex.: 'package.json').",
        },
      },
      required: ["path"],
    },

    async execute({ path: filePath }) {
      try {
        const resolved = await resolveInWorkspace(workspaceDir, filePath);

        const stats = await fs.stat(resolved);
        if (stats.isDirectory()) {
          throw new Error(`'${filePath}' é um diretório, não um arquivo.`);
        }
        // Rejeita também dispositivos, pipes etc., que poderiam travar a leitura.
        if (!stats.isFile()) {
          throw new Error(`'${filePath}' não é um arquivo comum.`);
        }
        if (stats.size === 0) {
          return "(arquivo vazio)";
        }

        const bytesToRead = Math.min(stats.size, MAX_BYTES);
        const buffer = Buffer.alloc(bytesToRead);
        const handle = await fs.open(resolved, "r");
        let bytesRead;
        try {
          ({ bytesRead } = await handle.read(buffer, 0, bytesToRead, 0));
        } finally {
          await handle.close();
        }
        const data = buffer.subarray(0, bytesRead);

        // Byte nulo é o sinal mais simples de arquivo binário.
        if (data.includes(0)) {
          throw new Error(`'${filePath}' parece ser um arquivo binário, não texto.`);
        }

        let text = data.toString("utf8");
        if (stats.size > MAX_BYTES) {
          text += `\n\n[arquivo truncado: mostrando os primeiros ${MAX_BYTES} de ${stats.size} bytes]`;
        }
        return text;
      } catch (error) {
        if (error.code) throw new Error(explainFsError(error, filePath, { action: "ler" }));
        throw error;
      }
    },
  };
}
