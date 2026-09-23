import readline from "node:readline/promises";
import { createCliConfirm } from "./cli/confirm.js";
import { ConfigError, createRuntime } from "./runtime.js";

function fail(message) {
  console.error(`Erro: ${message}`);
  process.exit(1);
}

async function main() {
  // Um único readline serve à tarefa e às confirmações. Prompts vão para stderr; a resposta final, para stdout.
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const confirm = createCliConfirm(rl);

  // A tarefa pode chegar pela entrada padrão ANTES de o runtime terminar de carregar. Se só começássemos a esperar
  // depois, o readline já teria descartado a linha. Por isso a espera é registrada aqui, imediatamente.
  let taskFromInput = null;
  if (!process.argv.slice(2).join(" ").trim()) {
    taskFromInput = new Promise((resolve) => {
      rl.once("line", resolve);
      rl.once("close", () => resolve(""));
    });
    if (process.stdin.isTTY) process.stderr.write("Qual é a tarefa? ");
  }

  try {
    let runtime;
    try {
      runtime = await createRuntime({ env: process.env, confirm, log: console.error });
    } catch (error) {
      if (error instanceof ConfigError) fail(error.message);
      throw error;
    }
    const { agent, model, workspaceDir, enabled, logFile } = runtime;

    const task = (taskFromInput ? await taskFromInput : process.argv.slice(2).join(" ")).trim();
    if (!task) fail("nenhuma tarefa informada.");

    // Ctrl+C: o primeiro pede para parar com calma; o segundo encerra na hora.
    let interrupts = 0;
    const onInterrupt = () => {
      interrupts += 1;
      if (interrupts >= 2) process.exit(130);
      console.error("\n[interrompendo] pressione Ctrl+C de novo para sair imediatamente.");
      confirm.cancel();
      agent.stop();
    };
    process.on("SIGINT", onInterrupt);
    rl.on("SIGINT", onInterrupt);

    console.error(`[modelo] ${model.label}`);
    console.error(`[workspace] ${workspaceDir}`);
    console.error(`[ferramentas] ${enabled.join(", ") || "(nenhuma: só conversa)"}`);
    console.error(`[log de ações] ${logFile}`);

    try {
      console.log("\n" + (await agent.run(task)));
    } catch (error) {
      fail(error.message);
    }
  } finally {
    rl.close();
  }
}

main();
