// DOM, EventSource, fetch e reconhecimento de voz FALSOS, só com o que o painel usa.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "voice", "web");

export class FakeElement {
  constructor(id, hidden = false, tag = "div") {
    this.id = id;
    this.tag = tag;
    this.hidden = hidden;
    this.children = [];
    this.className = "";
    this._text = "";
    this.value = "";
    this.listeners = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.dataset = {};
    this.style = { props: {}, setProperty(key, value) { this.props[key] = value; } };
  }
  // Como no DOM de verdade: ler junta o texto dos filhos; escrever troca o conteúdo.
  get textContent() { return this.children.length > 0 ? this.children.map((c) => c.textContent).join("") : this._text; }
  set textContent(value) { this.children = []; this._text = String(value); }
  // Nenhum código do painel pode usar HTML: qualquer tentativa quebra o teste.
  set innerHTML(_value) { throw new Error("innerHTML é proibido no painel"); }
  set outerHTML(_value) { throw new Error("outerHTML é proibido no painel"); }
  appendChild(child) {
    this.children.push(child);
    this.scrollHeight = this.children.length * 20;
    return child;
  }
  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  click() {
    this.dispatch("click");
  }
}

// O DOM falso é montado a partir do index.html REAL: se o painel usar um id que não existe no HTML, o teste quebra.
export class FakeDocument {
  constructor() {
    const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
    this.elements = {};
    for (const match of html.matchAll(/<[a-z0-9]+\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      this.elements[match[1]] = new FakeElement(match[1], /\shidden(\s|>|=)/.test(match[0]));
    }
    this.listeners = {};
    this.body = new FakeElement("body");
  }
  getElementById(id) {
    return this.elements[id] ?? null;
  }
  createElement(tag) {
    return new FakeElement("(novo)", false, tag);
  }
  createTextNode(text) {
    return { nodeType: 3, tag: "#text", children: [], textContent: String(text) };
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  press(key) {
    for (const fn of this.listeners.keydown ?? []) fn({ key });
  }
  pointer() {
    for (const fn of this.listeners.pointerdown ?? []) fn({});
  }
  messages(kind) {
    return this.elements.messages.children.filter((c) => !kind || c.className === `msg ${kind}`).map((c) => c.textContent);
  }
}

export class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, fn) {
    (this.listeners[name] ??= []).push(fn);
  }
  emit(name, data) {
    for (const fn of this.listeners[name] ?? []) fn({ data: JSON.stringify(data) });
  }
  emitRaw(name, raw) {
    for (const fn of this.listeners[name] ?? []) fn({ data: raw });
  }
  static get last() {
    return FakeEventSource.instances.at(-1);
  }
}

export class FakeSpeechRecognition {
  static instances = [];
  constructor() {
    this.started = false;
    this.aborted = false;
    FakeSpeechRecognition.instances.push(this);
  }
  start() {
    if (this.startError) throw this.startError;
    this.started = true;
  }
  abort() {
    this.aborted = true;
  }
  fire(list) {
    this.onresult({ results: list.map((r) => Object.assign([{ transcript: r.text }], { isFinal: Boolean(r.isFinal) })) });
  }
  fail(error) {
    this.onerror({ error });
  }
  finish() {
    this.onend();
  }
  static get last() {
    return FakeSpeechRecognition.instances.at(-1);
  }
}

// fetch falso: route(url, options) -> { status, body }. Guarda todas as chamadas.
export function createFakeFetch(route) {
  const calls = [];
  async function fetch(url, options = {}) {
    const call = { url, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const { status = 200, body = {} } = (await route(call)) ?? {};
    return { ok: status < 400, status, json: async () => body };
  }
  fetch.calls = calls;
  return fetch;
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
