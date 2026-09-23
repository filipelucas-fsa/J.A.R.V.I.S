import { ConfigError, createRuntime } from "./runtime.js";
import { createPanelBridge } from "./voice/bridge.js";
import { readVoiceConfig } from "./voice/config.js";
import { launchPanel } from "./voice/launchBrowser.js";
import { createVoiceServer } from "./voice/server.js";
import { createTtsProxy } from "./voice/ttsProxy.js";

function fail(message) {
  console.error(`Erro: ${message}`);
  process.exit(1);
}

// Modo voz: sobe o painel (mini chat) e o agente. Você fala a palavra-chave, o painel transcreve o que você diz
// e, após alguns segundos de silêncio, envia a mensagem ao agente. Ações perigosas pedem um CLIQUE no painel.
async function main() {
  const bridge = createPanelBridge();
  let runtime;
  let voice;
  try {
    voice = readVoiceConfig(process.env);
    runtime = await createRuntime({ env: process.env, confirm: bridge.confirm, log: (line) => bridge.emit({ type: "log", line }), keepHistory: true });
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }

  let server;
  try {
    server = await createVoiceServer({
      runner: runtime.agent, bridge, port: voice.port, tts: voice.ttsServer ? createTtsProxy(voice.ttsServer) : null,
      config: { ...voice.panel, model: runtime.model.label },
    });
  } catch (error) {
    fail(error.message);
  }

  console.error(`[modelo] ${runtime.model.label}`);
  console.error(`[workspace] ${runtime.workspaceDir}`);
  console.error(`[ferramentas] ${runtime.enabled.join(", ") || "(nenhuma: só conversa)"}`);
  console.error(`[log de ações] ${runtime.logFile}`);
  console.error(`[palavras-chave] ${voice.panel.wakeWords.join(", ")}  (envio após ${voice.panel.silenceMs / 1000}s de silêncio)`);
  console.error(`[voz do agente] ${voice.ttsServer ? `servidor de voz em ${voice.ttsServer.baseURL} (voz ${voice.ttsServer.voice})` : "voz do navegador (grátis, sem instalar)"}`);
  console.error("[privacidade] no Chrome/Edge o áudio vai ao serviço de voz do navegador enquanto o microfone está ligado.");
  console.error(`\nPainel: ${server.url}\n(o endereço contém um token secreto: não o compartilhe)\n`);

  let panelProcess = null;
  if (voice.openBrowser) {
    try {
      panelProcess = launchPanel({ url: server.url, env: process.env, screen: voice.screen }).child;
    } catch (error) {
      console.error(`[aviso] ${error.message}`);
    }
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) process.exit(130);
    closing = true;
    console.error("\nEncerrando…");
    runtime.agent.stop();
    panelProcess?.kill?.();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
