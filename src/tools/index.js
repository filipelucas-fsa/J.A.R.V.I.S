import { ToolRegistry } from "./toolRegistry.js";
import { createReadFileTool } from "./readFile.js";
import { createListDirectoryTool } from "./listDirectory.js";
import { createWriteFileTool } from "./writeFile.js";
import { createEditFileTool } from "./editFile.js";
import { createExecuteCommandTool } from "./executeCommand.js";
import { createComputerTools } from "./computerTools.js";
import { createWebTools } from "./webTools.js";

// Nomes que podem aparecer na variável TOOLS. "computer" liga screenshot, mouse e teclado juntos;
// "web" liga busca e leitura de páginas.
export const TOOL_NAMES = ["read_file", "list_directory", "write_file", "edit_file", "execute_command", "computer", "web"];

// Padrão seguro: leitura e edição de arquivos (edição sempre pede permissão).
// Terminal e controle do computador só entram se você pedir explicitamente.
export const DEFAULT_TOOLS = ["read_file", "list_directory", "write_file", "edit_file"];

// Converte o texto de TOOLS ("read_file,edit_file") em uma lista validada.
export function parseToolNames(value) {
  if (!value || value.trim() === "") return [...DEFAULT_TOOLS];
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
  const unknown = names.filter((name) => !TOOL_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Ferramenta desconhecida em TOOLS: ${unknown.map((n) => `'${n}'`).join(", ")}. Válidas: ${TOOL_NAMES.join(", ")}.`);
  }
  return names;
}

// Monta o registry com as ferramentas pedidas.
// createDriver: função async que devolve o driver de mouse/teclado/tela (só chamada se "computer" estiver ativo).
export async function buildToolRegistry({ workspaceDir, enabled, actionLog, createDriver }) {
  const registry = new ToolRegistry({ actionLog });

  for (const name of enabled) {
    switch (name) {
      case "read_file":
        registry.register(createReadFileTool({ workspaceDir }));
        break;
      case "list_directory":
        registry.register(createListDirectoryTool({ workspaceDir }));
        break;
      case "write_file":
        registry.register(createWriteFileTool({ workspaceDir }));
        break;
      case "edit_file":
        registry.register(createEditFileTool({ workspaceDir }));
        break;
      case "execute_command":
        registry.register(createExecuteCommandTool({ workspaceDir }));
        break;
      case "computer": {
        const driver = await createDriver();
        for (const tool of createComputerTools({ driver })) registry.register(tool);
        break;
      }
      case "web":
        for (const tool of createWebTools()) registry.register(tool);
        break;
      default:
        throw new Error(`Ferramenta desconhecida: ${name}`);
    }
  }
  return registry;
}
