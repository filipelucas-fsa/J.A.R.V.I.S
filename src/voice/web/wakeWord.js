// Detecção de palavra-chave ("Jarvis", "sexta-feira", "batman"...) em texto reconhecido por voz.
// Roda no navegador E no Node (os testes usam este mesmo arquivo).

export const DEFAULT_WAKE_WORDS = ["jarvis", "sexta-feira", "batman"];

const stripAccents = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function tokenize(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    norm: stripAccents(m[0]),
    end: m.index + m[0].length,
  }));
}

// Distância de edição <= 1 (uma letra a mais, a menos ou trocada). Reconhecedores erram uma letra com frequência.
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// Aceita lista ou texto separado por vírgulas. "sexta-feira", "sexta feira" e "sextafeira" são a mesma palavra.
export function parseWakeWords(input) {
  const list = Array.isArray(input) ? input : String(input ?? "").split(",");
  const words = [];
  for (const item of list) {
    const label = String(item).trim();
    if (label === "") continue;
    const parts = tokenize(label).map((t) => t.norm);
    const compact = parts.join("");
    if (compact.length < 3) throw new Error(`Palavra-chave inválida: '${label}' (use ao menos 3 letras).`);
    if (!words.some((w) => w.compact === compact)) words.push({ label, compact, tokenCount: parts.length });
  }
  if (words.length === 0) throw new Error("Nenhuma palavra-chave configurada.");
  return words;
}

// Procura uma palavra-chave no INÍCIO do texto (nas primeiras maxLeadingWords palavras), para evitar acionar
// por uma menção casual no meio de uma conversa. Retorna { word, rest } ou null; "rest" é o que veio depois dela.
// fuzzy (desligado por padrão): aceita erro de UMA letra, mas só quando o trecho tem o mesmo número de palavras que a
// palavra-chave. Cuidado: 'barman' fica a uma letra de 'batman'. Prefira listar variações em WAKE_WORDS.
export function findWakeWord(text, wakeWords, { maxLeadingWords = 3, fuzzy = false } = {}) {
  const tokens = tokenize(String(text ?? ""));
  for (let start = 0; start < Math.min(tokens.length, maxLeadingWords); start++) {
    for (let length = 1; length <= 3 && start + length <= tokens.length; length++) {
      const compact = tokens.slice(start, start + length).map((t) => t.norm).join("");
      for (const wake of wakeWords) {
        const exact = compact === wake.compact;
        const near = fuzzy && length === wake.tokenCount && wake.compact.length >= 6 && compact.length >= 6 && withinOneEdit(compact, wake.compact);
        if (exact || near) {
          const rest = String(text).slice(tokens[start + length - 1].end).replace(/^[\s,.:;!?\-–—]+/, "").trim();
          return { word: wake.label, rest };
        }
      }
    }
  }
  return null;
}
