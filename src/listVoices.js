import { ConfigError } from "./ai/index.js";
import { readVoiceConfig } from "./voice/config.js";
import { createTtsProxy } from "./voice/ttsProxy.js";

// Uso: npm run voices [filtro]   (lista as vozes do servidor de voz configurado em TTS_PROVIDER, ex.: Kokoro)
try {
  const config = readVoiceConfig(process.env);
  if (!config.ttsServer) {
    throw new ConfigError("TTS_PROVIDER=browser usa as vozes do navegador (sem servidor). Defina TTS_PROVIDER=kokoro para listar as vozes do servidor.");
  }
  console.error(`[servidor de voz] ${config.ttsServer.baseURL}`);
  const filter = process.argv.slice(2).join(" ").trim().toLowerCase();
  const voices = (await createTtsProxy(config.ttsServer).listVoices()).filter((id) => id.toLowerCase().includes(filter));
  console.log(voices.length > 0 ? voices.join("\n") : "(nenhuma voz encontrada)");
  console.error(`\n${voices.length} voz(es). Copie uma delas para TTS_VOICE no .env.`);
} catch (error) {
  console.error(`Erro: ${error.message}`);
  process.exit(error instanceof ConfigError ? 1 : 2);
}
