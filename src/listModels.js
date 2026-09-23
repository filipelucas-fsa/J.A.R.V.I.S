import { ConfigError, listAvailableModels, resolveModelConfig } from "./ai/index.js";

// Uso: npm run models [filtro]   (mostra os modelos disponíveis para a chave configurada; o filtro é opcional)
try {
  const config = resolveModelConfig(process.env);
  console.error(`[provedor] ${config.label}${config.baseURL ? ` (${config.baseURL})` : ""}`);
  const filter = process.argv.slice(2).join(" ").trim().toLowerCase();
  const ids = (await listAvailableModels(config)).filter((id) => id.toLowerCase().includes(filter));
  console.log(ids.length > 0 ? ids.join("\n") : "(nenhum modelo encontrado)");
  console.error(`\n${ids.length} modelo(s). Copie um deles para MODEL_NAME no .env.`);
} catch (error) {
  console.error(`Erro: ${error.message}`);
  process.exit(error instanceof ConfigError ? 1 : 2);
}
