import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/voice/web/markdown.js";
import { FakeDocument, FakeElement } from "./helpers/fakeDom.js";

const doc = new FakeDocument();
const render = (text) => {
  const container = new FakeElement("c");
  renderMarkdown(container, text, doc);
  return container;
};
const ALLOWED = new Set(["div", "span", "strong", "code", "pre", "ul", "ol", "li", "#text"]);
const tags = (node) => [node.tag, ...(node.children ?? []).flatMap(tags)];
const shape = (node) => node.children.map((c) => `${c.tag}${c.className ? "." + c.className : ""}`);

test("parágrafo simples e texto vazio", () => {
  const p = render("Olá, senhor.");
  assert.deepEqual(shape(p), ["div.md-p"]);
  assert.equal(p.textContent, "Olá, senhor.");
  assert.deepEqual(render("").children, []);
  assert.deepEqual(render(null).children, []);
  assert.deepEqual(render("\n\n  \n").children, []);
});

test("títulos, listas com e sem número, e parágrafos separados", () => {
  const out = render("## Resultado\n\nEncontrei:\n- um\n- dois\n1. primeiro\n2. segundo\n\nFim.");
  assert.deepEqual(shape(out), ["div.md-h", "div.md-p", "ul.md-list", "ol.md-list", "div.md-p"]);
  assert.equal(out.children[0].textContent, "Resultado");
  assert.deepEqual(out.children[2].children.map((li) => li.textContent), ["um", "dois"]);
  assert.deepEqual(out.children[3].children.map((li) => li.textContent), ["primeiro", "segundo"]);
});

test("negrito e código em linha", () => {
  const p = render("Use **isto** e `npm test` agora").children[0];
  assert.deepEqual(p.children.map((c) => `${c.tag}:${c.textContent}`), ["#text:Use ", "strong:isto", "#text: e ", "code:npm test", "#text: agora"]);
});

test("bloco de código: conteúdo literal (sem interpretar markdown dentro), com e sem fechamento", () => {
  const closed = render("Rode:\n```bash\nls **nada** `x`\n# não é título\n```\nPronto.");
  assert.deepEqual(shape(closed), ["div.md-p", "pre.md-pre", "div.md-p"]);
  assert.equal(closed.children[1].children[0].textContent, "ls **nada** `x`\n# não é título");
  const open = render("```js\nfoo()\nbar()");
  assert.deepEqual(shape(open), ["pre.md-pre"]);
  assert.equal(open.children[0].textContent, "foo()\nbar()");
});

test("links viram TEXTO (sem <a>), inclusive javascript:", () => {
  const p = render("Veja [o site](https://exemplo.com) e [x](javascript:alert(1))");
  assert.equal(p.textContent, "Veja o site (https://exemplo.com) e x (javascript:alert(1))");
  assert.ok(!tags(p).includes("a"));
});

test("SEGURANÇA: nenhum HTML vira elemento; só as tags permitidas existem; innerHTML nunca é usado", () => {
  const evil = [
    '<img src=x onerror="alert(1)">', "<script>alert(2)</script>", '<a href="javascript:alert(3)">clique</a>', "<iframe src=//evil></iframe>",
    "**<b>negrito</b>**", "`<svg onload=alert(4)>`", "```\n<script>alert(5)</script>\n```", "# <h1>título</h1>", "- <li onclick=x>item</li>",
    "&lt;script&gt;", "\u202e\u2066texto invertido", "[<img src=x>](http://x)",
  ];
  for (const text of evil) {
    const out = render(text); // se algum código usasse innerHTML, o DOM falso lançaria erro aqui
    for (const tag of tags(out)) assert.ok(ALLOWED.has(tag), `${text} gerou <${tag}>`);
    const wholeText = out.textContent;
    assert.ok(!/^(?:img|script|iframe|svg)$/.test(out.tag ?? ""), text);
    assert.ok(wholeText.length > 0, text);
  }
  assert.equal(render("<script>alert(2)</script>").textContent, "<script>alert(2)</script>");
});

test("respostas gigantes não são processadas (evita travar o painel)", () => {
  const huge = "- item\n".repeat(20_000);
  const out = render(huge);
  assert.deepEqual(shape(out), ["div.md-p"]);
  assert.equal(out.children[0].textContent.length, huge.length);
});

test("entradas malucas não quebram: marcadores soltos, negrito sem fechar, crases sem par", () => {
  for (const text of ["**", "****", "` `", "`", "- ", "#", "# ", "1.", "```", "**a", "a**", "[](x)", "[a](", "* * *", "\t\t", "\u0000", "a\r\nb\rc"]) {
    assert.doesNotThrow(() => render(text), JSON.stringify(text));
  }
  assert.equal(render("**a").textContent, "**a");
  assert.equal(render("uma `crase solta").textContent, "uma `crase solta");
});

test("lista logo depois de um parágrafo e parágrafo de várias linhas", () => {
  const out = render("Linha 1\nLinha 2\n- item");
  assert.deepEqual(shape(out), ["div.md-p", "ul.md-list"]);
  assert.equal(out.children[0].textContent, "Linha 1\nLinha 2");
});
