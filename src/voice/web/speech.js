// Lógica pura da fala do agente (texto -> trechos falados, escolha de voz, detecção de eco).
// Roda no navegador e no Node (os testes usam este mesmo arquivo).

const stripAccents = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const words = (text) => (stripAccents(String(text ?? "")).match(/[\p{L}\p{N}]+/gu) ?? []);

// ---------- texto -> trechos falados ----------

// Transforma a resposta (que costuma ter markdown, código e links) no que vale a pena LER EM VOZ ALTA.
// Retorna { chunks, truncated }: trechos curtos, falados um após o outro (permite interromper entre eles e
// evita o limite de duração das vozes de alguns navegadores).
export function prepareSpeech(text, { maxChars = 1200, chunkChars = 220 } = {}) {
  let t = String(text ?? "").replace(/\r\n?/g, "\n");

  t = t.replace(/```[\s\S]*?```/g, " (trecho de código omitido) "); // blocos de código
  t = t.replace(/```[\s\S]*$/g, " (trecho de código omitido) "); // bloco que nunca fechou
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // imagens
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links [texto](url)
  t = t.replace(/https?:\/\/\S+/g, " link "); // urls soltas
  t = t.replace(/`([^`]*)`/g, "$1"); // código em linha
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, ""); // títulos
  t = t.replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, ""); // marcadores de lista
  t = t.replace(/^[ \t]*>[ \t]?/gm, ""); // citações
  t = t.replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, ""); // linha separadora de tabela
  t = t.replace(/\|/g, ", "); // colunas de tabela
  t = t.replace(/(\*\*|__|~~)/g, "").replace(/(^|\s)\*(?=\S)|(?<=\S)\*(?=\s|$)/g, "$1"); // negrito/itálico
  t = t.replace(/\p{Extended_Pictographic}/gu, ""); // emojis
  t = t.replace(/%/g, " por cento").replace(/&/g, " e ").replace(/[→⇒]|->/g, " ");
  t = t.replace(/\(\s*(trecho de código omitido)\s*\)(\s*\(\s*trecho de código omitido\s*\))+/g, "($1)"); // blocos seguidos
  t = t.replace(/\n{2,}/g, ". ").replace(/\n/g, ", ");
  t = t.replace(/\s+/g, " ").replace(/([.!?…])\s*[.,]\s*/g, "$1 ").replace(/,\s*\./g, ".").trim();
  if (t === "") return { chunks: [], truncated: false };

  let truncated = false;
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "")).trim() + " O restante está na tela.";
    truncated = true;
  }

  const sentences = t.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const chunks = [];
  let current = "";
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
  for (const sentence of sentences) {
    if (sentence.length > chunkChars) {
      push();
      let rest = sentence;
      while (rest.length > chunkChars) {
        let at = rest.lastIndexOf(", ", chunkChars);
        if (at < chunkChars * 0.4) at = rest.lastIndexOf(" ", chunkChars);
        if (at <= 0) at = chunkChars;
        chunks.push(rest.slice(0, at + 1).trim());
        rest = rest.slice(at + 1).trim();
      }
      current = rest;
    } else if ((current + " " + sentence).trim().length > chunkChars) {
      push();
      current = sentence;
    } else {
      current = (current + " " + sentence).trim();
    }
  }
  push();
  return { chunks, truncated };
}

// ---------- eco ----------

const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

// O microfone escuta o próprio agente falando pelos alto-falantes. Retorna true se o que foi "ouvido"
// é basicamente o que o agente está dizendo (então NÃO é você falando). Se boa parte das palavras
// não está no texto falado, é você: por isso interrompe.
export function isEcho(heard, spoken, { threshold = 0.34 } = {}) {
  const heardWords = words(heard);
  if (heardWords.length === 0) return true;
  const spokenWords = words(spoken);
  if (spokenWords.length === 0) return false;
  const novel = heardWords.filter((w) => !spokenWords.some((s) => sameWord(w, s))).length;
  return novel / heardWords.length <= threshold;
}

// ---------- escolha da voz ----------

const MALE_HINTS = ["antonio", "donato", "fabio", "humberto", "julio", "nicolau", "valerio", "daniel", "ricardo", "felipe", "luciano", "male", "masculin"];

const validVoice = (voice) =>
  Boolean(voice) &&
  typeof voice.name === "string" && voice.name.trim() !== "" && !/undefined/i.test(voice.name) &&
  typeof voice.lang === "string" && voice.lang.trim() !== "" && !/undefined/i.test(voice.lang);

// Escolhe a melhor voz do navegador para o idioma. Prefere vozes neurais "Natural" e, se possível, masculinas
// (mais "JARVIS"). Ignora entradas incompletas (o Edge às vezes devolve nomes "undefined"). Retorna null se não há.
export function pickVoice(voices, lang = "pt-BR", { preferName, preferMale = true } = {}) {
  const wanted = lang.toLowerCase().replace("_", "-");
  const primary = wanted.split("-")[0];
  let best = null;
  let bestScore = -1;
  for (const voice of Array.isArray(voices) ? voices : []) {
    if (!validVoice(voice)) continue;
    const voiceLang = voice.lang.toLowerCase().replace("_", "-");
    if (voiceLang.split("-")[0] !== primary) continue;
    const name = stripAccents(voice.name);
    let score = voiceLang === wanted ? 100 : 40;
    if (/natural|neural/.test(name)) score += 30;
    if (/online/.test(name)) score += 10;
    if (/google/.test(name)) score += 8;
    if (preferMale && MALE_HINTS.some((hint) => name.includes(hint))) score += 12;
    if (preferName && name.includes(stripAccents(preferName))) score += 1000;
    if (score > bestScore) { best = voice; bestScore = score; }
  }
  return best;
}
