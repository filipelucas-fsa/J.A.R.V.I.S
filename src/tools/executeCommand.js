import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_COMMAND_CHARS = 2000;

// Barreira EXTRA contra comandos catastróficos. NÃO é uma lista completa (um shell pode ofuscar qualquer coisa):
// a proteção de verdade é a confirmação do usuário, que sempre vê o comando inteiro.
const BLOCKED_COMMANDS = [
  { pattern: /\brm\s+(?:-\S+\s+)*(?:\/|~|\$HOME|\/\*)\s*(?:$|[;&|])/i, reason: "apagar a raiz ou a pasta pessoal" },
  { pattern: /\bmkfs(?:\.\w+)?\b/i, reason: "formatar disco" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "escrever direto em um dispositivo de disco" },
  { pattern: />\s*\/dev\/(?:sd|nvme|hd|disk)/i, reason: "escrever direto em um dispositivo de disco" },
  { pattern: /:\(\)\s*\{[^}]*:\s*\|\s*:/, reason: "fork bomb" },
  { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/i, reason: "desligar/reiniciar a máquina" },
  { pattern: /\bsudo\b/i, reason: "elevar privilégios (sudo)" },
  { pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i, reason: "baixar e executar código da internet" },
  { pattern: /\bchmod\s+-R\s+[0-7]{3,4}\s+\//i, reason: "mudar permissões da raiz" },
];

export function findBlockedReason(command) {
  return BLOCKED_COMMANDS.find(({ pattern }) => pattern.test(command))?.reason ?? null;
}

// Remove do ambiente do comando tudo que parece segredo (chave da API, tokens...).
export function safeEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|ANTHROPIC)/i.test(key)) clean[key] = value;
  }
  return clean;
}

function runCommand(command, { cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: safeEnv(),
      detached: process.platform !== "win32", // novo grupo de processos: permite encerrar filhos e netos
      stdio: ["ignore", "pipe", "pipe"], // sem stdin: comandos interativos não travam esperando digitação
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;

    const collect = (current, chunk) => {
      const room = MAX_OUTPUT_CHARS - current.length;
      if (room <= 0) {
        truncated = true;
        return current;
      }
      const text = chunk.toString("utf8");
      if (text.length > room) truncated = true;
      return current + text.slice(0, room);
    };
    child.stdout.on("data", (chunk) => (stdout = collect(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));

    const kill = () => {
      try {
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // processo já terminou
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, killSignal) => {
      cleanup();
      resolve({ code, killSignal, stdout, stderr, truncated, timedOut, aborted });
    });
  });
}

// Executa um comando no terminal, com a pasta do workspace como diretório inicial.
// ATENÇÃO: o workspace vale para as ferramentas de ARQUIVO; um comando de terminal NÃO fica confinado a ele.
export function createExecuteCommandTool({ workspaceDir }) {
  return {
    name: "execute_command",
    description:
      "Executa um comando no terminal, começando na pasta do diretório de trabalho. Tem tempo limite e a saída é truncada. " +
      "Não use para comandos interativos. O usuário precisa aprovar cada comando.",
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", maxLength: MAX_COMMAND_CHARS, description: "O comando a executar." },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 120,
          description: `Tempo limite em segundos (padrão: ${DEFAULT_TIMEOUT_SECONDS}).`,
        },
      },
      required: ["command"],
    },

    async prepare({ command, timeout_seconds = DEFAULT_TIMEOUT_SECONDS }) {
      if (command.trim() === "") throw new Error("O comando não pode ser vazio.");
      const blocked = findBlockedReason(command);
      if (blocked) throw new Error(`Comando bloqueado por segurança (${blocked}).`);
      return (
        `Executar no terminal (pasta inicial: ${workspaceDir}, tempo limite: ${timeout_seconds}s):\n  ${command}\n` +
        `ATENÇÃO: o comando NÃO fica restrito ao diretório de trabalho.`
      );
    },

    async execute({ command, timeout_seconds = DEFAULT_TIMEOUT_SECONDS }, { signal } = {}) {
      if (command.trim() === "") throw new Error("O comando não pode ser vazio.");
      const blocked = findBlockedReason(command);
      if (blocked) throw new Error(`Comando bloqueado por segurança (${blocked}).`);

      let cwd;
      try {
        cwd = await fs.realpath(workspaceDir);
      } catch {
        throw new Error("O diretório de trabalho não existe ou não está acessível.");
      }

      const result = await runCommand(command, { cwd, timeoutMs: timeout_seconds * 1000, signal });

      const sections = [];
      if (result.stdout) sections.push(`--- stdout ---\n${result.stdout}`);
      if (result.stderr) sections.push(`--- stderr ---\n${result.stderr}`);
      if (result.truncated) sections.push(`[saída truncada em ${MAX_OUTPUT_CHARS} caracteres por fluxo]`);
      const body = sections.join("\n");

      if (result.aborted) throw new Error(`Comando cancelado pelo usuário.${body ? "\n" + body : ""}`);
      if (result.timedOut) {
        throw new Error(`Tempo esgotado após ${timeout_seconds}s; o processo foi encerrado.${body ? "\n" + body : ""}`);
      }

      const status = result.killSignal
        ? `encerrado pelo sinal ${result.killSignal}`
        : `código de saída: ${result.code}${result.code === 0 ? "" : " (falhou)"}`;
      return body ? `${status}\n${body}` : status;
    },
  };
}
