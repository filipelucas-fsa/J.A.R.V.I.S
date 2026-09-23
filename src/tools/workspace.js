import fs from "node:fs/promises";
import path from "node:path";

// Pastas e arquivos que o agente nunca acessa, mesmo dentro do workspace:
// guardam segredos ou permitem executar código depois (ex.: .git/hooks).
const SENSITIVE_DIRS = new Set([".git", ".ssh"]);
const SENSITIVE_FILE = /^(?:\.env(?:$|\.(?!example$).*)|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519))$/i;

// Verdadeiro se "target" é o próprio "root" ou está dentro dele.
// Usa path.relative em vez de startsWith: "/a/ws-evil" começa com "/a/ws", mas NÃO está dentro dele.
function isInside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
  );
}

function assertNotSensitive(userPath, relativePath) {
  const segments = [...relativePath.split(path.sep), ...userPath.split(/[\\/]+/)];
  for (const segment of segments) {
    if (SENSITIVE_DIRS.has(segment.toLowerCase()) || SENSITIVE_FILE.test(segment)) {
      throw new Error(
        `Acesso negado: '${userPath}' é sensível (.env, .git, .ssh, chaves...) e não pode ser acessado pelo agente.`
      );
    }
  }
}

// Converte erros técnicos do sistema de arquivos em mensagens claras.
// (Erros com "code" vêm do Node; os que nós criamos já têm mensagem clara e não têm "code".)
export function explainFsError(error, userPath, { action = "acessar", kind = "Arquivo" } = {}) {
  switch (error.code) {
    case "ENOENT":
    case "ENOTDIR":
      return `${kind} não encontrado: '${userPath}'.`;
    case "EACCES":
    case "EPERM":
      return `Sem permissão para ${action} '${userPath}'.`;
    case "EISDIR":
      return `'${userPath}' é um diretório, não um arquivo.`;
    case "EEXIST":
      return `'${userPath}' já existe.`;
    case "ELOOP":
      return `'${userPath}' envolve links simbólicos circulares.`;
    case "ENOSPC":
      return "Sem espaço em disco.";
    case "EROFS":
      return `O local de '${userPath}' é somente leitura.`;
    default:
      return `Não foi possível ${action} '${userPath}': ${error.message}`;
  }
}

// Caminho que ainda não existe: valida o pai mais próximo que existe,
// para que criar "link/novo.txt" não escape por um link simbólico.
async function resolveMissing(root, absolute, userPath) {
  // Um link simbólico quebrado "não existe" para o realpath, mas escrever nele criaria o arquivo no destino.
  try {
    await fs.lstat(absolute);
    throw new Error(`Acesso negado: '${userPath}' é um link simbólico quebrado.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let ancestor = path.dirname(absolute);
  for (;;) {
    try {
      const realAncestor = await fs.realpath(ancestor);
      if (!isInside(root, realAncestor)) {
        throw new Error(
          `Acesso negado: '${userPath}' passa por um link simbólico que aponta para fora do diretório de trabalho.`
        );
      }
      const finalPath = path.join(realAncestor, path.relative(ancestor, absolute));
      assertNotSensitive(userPath, path.relative(root, finalPath));
      return finalPath;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

// Transforma o caminho pedido pelo modelo em um caminho absoluto SEGURO,
// ou lança um Error se ele sair do workspace ou for sensível.
//
// Camadas:
//  1. Léxica: resolve "../", "./" e caminhos absolutos e confere se ficou dentro do workspace.
//  2. Sensível: bloqueia .env, .git, .ssh, chaves etc.
//  3. Links simbólicos: confere o destino real (um link dentro do workspace poderia apontar para fora).
//
// Retorna o caminho real se existe; se não existe, o caminho onde ele seria criado (já validado).
export async function resolveInWorkspace(workspaceDir, userPath) {
  if (typeof userPath !== "string" || userPath.trim() === "") {
    throw new Error("O caminho deve ser um texto não vazio.");
  }
  if (userPath.includes("\0")) {
    throw new Error("O caminho contém um caractere inválido.");
  }

  let root;
  try {
    root = await fs.realpath(workspaceDir);
  } catch {
    throw new Error("O diretório de trabalho não existe ou não está acessível.");
  }

  // Se userPath for absoluto, path.resolve ignora o root: a checagem abaixo é quem bloqueia.
  const absolute = path.resolve(root, userPath);
  if (!isInside(root, absolute)) {
    throw new Error(`Acesso negado: '${userPath}' está fora do diretório de trabalho.`);
  }
  assertNotSensitive(userPath, path.relative(root, absolute));

  let real;
  try {
    real = await fs.realpath(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return resolveMissing(root, absolute, userPath);
    throw error;
  }

  if (!isInside(root, real)) {
    throw new Error(
      `Acesso negado: '${userPath}' aponta (via link simbólico) para fora do diretório de trabalho.`
    );
  }
  assertNotSensitive(userPath, path.relative(root, real));
  return real;
}
