// Renderizador de markdown SEGURO para as respostas do agente. Monta elementos com createElement e textContent:
// nunca usa innerHTML, então nenhum texto do modelo consegue virar HTML, script ou atributo. Links viram texto
// puro (sem <a>), e só existem estes elementos: div, span, strong, code, pre, ul, ol, li.
// Suporta: títulos (#), listas (-, *, 1.), blocos de código (```), código em linha (`x`) e negrito (**x**).

const MAX_CHARS = 30_000;
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Texto corrido com `código` e **negrito**. Links [texto](url) viram "texto (url)" em texto puro.
function inline(doc, parent, text) {
  const plain = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
  for (const part of plain.split(INLINE)) {
    if (part === "") continue;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) parent.appendChild(el(doc, "code", "md-code", part.slice(1, -1)));
    else if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) parent.appendChild(el(doc, "strong", "md-b", part.slice(2, -2)));
    else parent.appendChild(doc.createTextNode(part));
  }
}

const isBlockStart = (line) => /^\s*(```|#{1,4}\s|[-*+•]\s|\d+[.)]\s)/.test(line);

// Preenche "container" (um elemento) com a resposta renderizada.
export function renderMarkdown(container, text, doc) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  if (source.length > MAX_CHARS) {
    container.appendChild(el(doc, "div", "md-p", source));
    return;
  }
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) { // bloco de código
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // fecha o bloco (ou termina o texto, se nunca fechou)
      const pre = el(doc, "pre", "md-pre");
      pre.appendChild(el(doc, "code", undefined, body.join("\n")));
      container.appendChild(pre);
    } else if (/^\s*#{1,4}\s+/.test(line)) { // título
      const heading = el(doc, "div", "md-h");
      inline(doc, heading, line.replace(/^\s*#{1,4}\s+/, ""));
      container.appendChild(heading);
      i++;
    } else if (/^\s*[-*+•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) { // lista
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const marker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+•]\s+/;
      const list = el(doc, ordered ? "ol" : "ul", "md-list");
      while (i < lines.length && marker.test(lines[i])) {
        const item = el(doc, "li");
        inline(doc, item, lines[i].replace(marker, ""));
        list.appendChild(item);
        i++;
      }
      container.appendChild(list);
    } else if (line.trim() === "") {
      i++;
    } else { // parágrafo: linhas seguidas até um espaço em branco ou outro bloco
      const paragraph = el(doc, "div", "md-p");
      const chunk = [];
      while (i < lines.length && lines[i].trim() !== "" && (chunk.length === 0 || !isBlockStart(lines[i]))) chunk.push(lines[i++]);
      inline(doc, paragraph, chunk.join("\n"));
      container.appendChild(paragraph);
    }
  }
}
