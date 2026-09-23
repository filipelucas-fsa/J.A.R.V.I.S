// Pergunta ao usuário, no terminal, se uma ação pode ser executada.
// Retorna uma função confirm(request) -> "yes" | "no" | "always", com o método extra .cancel()
// (usado no Ctrl+C para não deixar uma pergunta pendurada).
//
// Regra de ouro: qualquer resposta que não seja um "sim" claro, erro, ou falta de terminal interativo = NÃO.
export function createCliConfirm(rl, { isInteractive = () => Boolean(process.stdin.isTTY), write = (text) => process.stderr.write(text) } = {}) {
  let current = null;

  async function confirm({ tool, description, allowSessionApproval }) {
    if (!isInteractive()) {
      write("[confirmação] sem terminal interativo: ação negada automaticamente.\n");
      return "no";
    }

    const indented = String(description).split("\n").map((line) => `   ${line}`).join("\n");
    write(`\n⚠️  Confirmação necessária (ferramenta: ${tool})\n${indented}\n`);
    const options = allowSessionApproval
      ? "[s]im / [n]ão / [t]odas as ações desta ferramenta nesta sessão"
      : "[s]im / [n]ão";

    current = new AbortController();
    try {
      const answer = (await rl.question(`Permitir? ${options}: `, { signal: current.signal })).trim().toLowerCase();
      if (["s", "sim", "y", "yes"].includes(answer)) return "yes";
      if (allowSessionApproval && ["t", "todas"].includes(answer)) return "always";
      return "no";
    } catch {
      return "no"; // Ctrl+C, entrada encerrada, etc.
    } finally {
      current = null;
    }
  }

  confirm.cancel = () => current?.abort();
  return confirm;
}
