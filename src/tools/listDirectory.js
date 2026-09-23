import fs from "node:fs/promises";
import { resolveInWorkspace, explainFsError } from "./workspace.js";

const MAX_ENTRIES = 500;

// Ferramenta somente-leitura: mostra o que existe dentro de uma pasta do workspace.
export function createListDirectoryTool({ workspaceDir }) {
  return {
    name: "list_directory",
    description:
      "Lista os arquivos e pastas de um diretório do diretório de trabalho. " +
      "Pastas terminam com '/' e links simbólicos com '@'. Sem 'path', lista a raiz do diretório de trabalho.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho da pasta, relativo ao diretório de trabalho (padrão: '.').",
        },
      },
    },

    async execute({ path: dirPath = "." }) {
      try {
        const resolved = await resolveInWorkspace(workspaceDir, dirPath);
        const stats = await fs.stat(resolved);
        if (!stats.isDirectory()) {
          throw new Error(`'${dirPath}' é um arquivo, não um diretório. Use read_file para ler o conteúdo.`);
        }

        const entries = await fs.readdir(resolved, { withFileTypes: true });
        if (entries.length === 0) return "(diretório vazio)";

        const names = entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.isSymbolicLink() ? `${entry.name}@` : entry.name))
          .sort();

        const shown = names.slice(0, MAX_ENTRIES).join("\n");
        return names.length > MAX_ENTRIES
          ? `${shown}\n\n[lista truncada: mostrando ${MAX_ENTRIES} de ${names.length} itens]`
          : shown;
      } catch (error) {
        if (error.code) throw new Error(explainFsError(error, dirPath, { action: "listar", kind: "Pasta" }));
        throw error;
      }
    },
  };
}
