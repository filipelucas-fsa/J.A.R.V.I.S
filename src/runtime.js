import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "./agent/agent.js";
import { ActionLog } from "./agent/actionLog.js";
import { ConfigError, createModel, resolveModelConfig } from "./ai/index.js";
import { createNutDriver } from "./computer/nutDriver.js";
import { buildToolRegistry, parseToolNames } from "./tools/index.js";

export { ConfigError };

// Lê as variáveis de ambiente e monta tudo: modelo, ferramentas e agente.
// Compartilhado pelo modo texto (index.js) e pelo modo voz (voiceMain.js).
// Lança ConfigError (mensagem clara) para qualquer configuração inválida.
export async function createRuntime({ env = process.env, confirm, log = () => {}, createDriver = createNutDriver, keepHistory = false } = {}) {
  const modelConfig = resolveModelConfig(env);

  const workspaceDir = path.resolve(env.WORKSPACE_DIR || process.cwd());
  try {
    const stats = await fs.stat(workspaceDir);
    if (!stats.isDirectory()) throw new Error("não é um diretório");
  } catch {
    throw new ConfigError(`WORKSPACE_DIR inválido: ${workspaceDir}`);
  }

  let maxSteps = 20;
  if (env.MAX_STEPS) {
    maxSteps = Number(env.MAX_STEPS);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) {
      throw new ConfigError("MAX_STEPS deve ser um inteiro entre 1 e 200.");
    }
  }

  let enabled;
  try {
    enabled = parseToolNames(env.TOOLS);
  } catch (error) {
    throw new ConfigError(error.message);
  }
  // Modelo sem chamada de ferramentas: só conversa.
  if (!modelConfig.tools) enabled = [];
  if (enabled.includes("computer") && !modelConfig.vision) {
    throw new ConfigError(
      "TOOLS=computer exige um modelo com visão (o agente precisa 'ver' a tela). " +
        "Se o seu modelo aceita imagens, defina MODEL_VISION=true; senão, remova 'computer' de TOOLS."
    );
  }

  const logFile = env.AGENT_LOG_FILE || path.join(os.homedir(), ".ai-computer-agent", "actions.jsonl");
  const actionLog = new ActionLog(logFile);

  let toolRegistry;
  try {
    toolRegistry = await buildToolRegistry({ workspaceDir, enabled, actionLog, createDriver });
  } catch (error) {
    throw new ConfigError(error.message);
  }

  const model = createModel(modelConfig);
  const agent = new Agent({ model, toolRegistry, confirm, log, maxSteps, keepHistory });
  return { agent, model, toolRegistry, workspaceDir, enabled, logFile, maxSteps, modelConfig };
}
