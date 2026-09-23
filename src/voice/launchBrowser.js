import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];

function candidates(platform, env) {
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
    // Edge primeiro, em QUALQUER pasta: as vozes neurais "Natural" em pt-BR dele são melhores que as do Chrome.
    return [
      ...roots.map((root) => path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...roots.map((root) => path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe")),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  const dirs = String(env.PATH ?? "").split(":").filter(Boolean);
  return LINUX_NAMES.flatMap((name) => dirs.map((dir) => path.posix.join(dir, name)));
}

// Procura o Chrome/Edge/Chromium. O reconhecimento de voz do painel só funciona nesses navegadores.
// VOICE_BROWSER (caminho completo) tem prioridade. Retorna o caminho ou null.
export function findBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.VOICE_BROWSER) return exists(env.VOICE_BROWSER) ? env.VOICE_BROWSER : null;
  return candidates(platform, env).find((file) => exists(file)) ?? null;
}

// Posição do canto inferior direito, dado o tamanho da tela.
export function computePosition(screen, size, margin = 16) {
  return { x: Math.max(0, screen.width - size.width - margin), y: Math.max(0, screen.height - size.height - margin - 40) };
}

// "--app" abre uma janela sem barra de endereço. Perfil próprio: não mexe no seu navegador normal e o
// navegador lembra da permissão do microfone entre execuções (por isso a porta é fixa).
export function buildBrowserArgs({ url, profileDir, size = { width: 400, height: 640 }, position }) {
  // autoplay-policy: permite o agente falar sem você precisar clicar antes (é um perfil só do painel).
  const args = [`--app=${url}`, `--user-data-dir=${profileDir}`, `--window-size=${size.width},${size.height}`, "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check"];
  if (position) args.push(`--window-position=${position.x},${position.y}`);
  return args;
}

export function defaultProfileDir() {
  return path.join(os.homedir(), ".ai-computer-agent", "browser-profile");
}

// Abre o painel. Retorna { child } ou lança Error com instruções se não achar o navegador.
export function launchPanel({ url, env = process.env, platform = process.platform, exists = fs.existsSync, spawnImpl = spawn, size, screen }) {
  const browser = findBrowser({ platform, env, exists });
  if (!browser) {
    throw new Error(
      "Não encontrei o Chrome, Edge ou Chromium (o reconhecimento de voz só funciona neles). " +
        "Instale um deles, defina VOICE_BROWSER com o caminho do executável, ou abra o endereço acima manualmente."
    );
  }
  const finalSize = size ?? { width: 400, height: 640 };
  const position = screen ? computePosition(screen, finalSize) : undefined;
  const args = buildBrowserArgs({ url, profileDir: env.VOICE_PROFILE_DIR || defaultProfileDir(), size: finalSize, position });
  const child = spawnImpl(browser, args, { stdio: "ignore" });
  child.on?.("error", () => {});
  return { child, browser, args };
}
