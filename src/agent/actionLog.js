import fs from "node:fs";
import path from "node:path";

const MAX_DETAIL_CHARS = 500;

// Registro (auditoria) de tudo que o agente tenta fazer: uma linha JSON por ação.
// Se não for possível gravar, avisa uma vez e o agente continua (o log não derruba a tarefa).
export class ActionLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.warned = false;
  }

  record(entry) {
    const detail =
      typeof entry.detail === "string" && entry.detail.length > MAX_DETAIL_CHARS
        ? entry.detail.slice(0, MAX_DETAIL_CHARS) + "…"
        : entry.detail;
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry, detail });

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, line + "\n", { mode: 0o600 });
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.error(`[aviso] não foi possível gravar o log de ações (${this.filePath}): ${error.message}`);
      }
    }
  }
}
