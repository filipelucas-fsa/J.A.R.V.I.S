// Ferramentas de web: pesquisar (DuckDuckGo), ler páginas e abrir abas no navegador —
// sem nenhum serviço pago. Buscar e abrir abas são leitura: NÃO pedem confirmação.
// Ler uma URL escolhida pelo modelo pede (como mouse/teclado), com "Sempre nesta sessão".
//
// Conteúdo de páginas é DADO: o system prompt do agente já proíbe seguir instruções encontradas neles.

import { spawn } from "node:child_process";
import os from "node:os";

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const SEARCH_URL = "https://html.duckduckgo.com/html/";
const MAX_QUERY_CHARS = 400;
const MAX_URL_CHARS = 2000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 30_000;
const MAX_SNIPPET_CHARS = 400;

// ---------- HTML → texto (mínimo, sem dependências) ----------

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", agrave: "à", atilde: "ã", acirc: "â", ccedil: "ç",
  eacute: "é", ecirc: "ê", iacute: "í", oacute: "ó", ocirc: "ô", uacute: "ú", uuml: "ü", ouml: "ö", auml: "ä",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  hellip: "…", mdash: "—", ndash: "–", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
  euro: "€", pound: "£", deg: "°", sect: "§", para: "¶", times: "×", divide: "÷",
};

export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ""; }
    })
    .replace(/&([a-zA-Z]+);/g, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

// Remove tags e devolve texto corrido (tags internas, como <b> nos resumos, viram espaço).
export function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Página inteira → texto legível: joga fora script/style/noscript, preserva quebras dos blocos principais.
export function htmlToText(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/blockquote|\/pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function pageTitle(html) {
  return stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
}

// ---------- URLs e proteção SSRF (o fetch roda na máquina do usuário) ----------

// Recusa nomes e IPs que apontem para a própria máquina ou rede interna.
export function isInternalHost(rawHost) {
  const host = String(rawHost).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (host.includes(":")) { // IPv6 literal
    if (host === "::" || host === "::1") return true;
    if (/^f[cd]/.test(host.replace(/^::/, ""))) return true; // ULA fc00::/7
    if (host.replace(/^::/, "").startsWith("fe8") || host.replace(/^::/, "").startsWith("fec")) return true; // link-local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host); // IPv4 mapeado em IPv6
    return mapped ? isInternalHost(mapped[1]) : /^ff/.test(host); // multicast
  }
  return false;
}

// Aceita só http(s) público. Lança erro com mensagem clara para o modelo.
// allowInternal: usado apenas pelos testes (servidor local); o padrão é sempre recusar.
export function parseHttpUrl(raw, { allowInternal = false } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`URL inválida: '${String(raw).slice(0, 100)}'. Use o formato http://site.com/caminho ou https://...`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Só é possível acessar http e https (recebido: '${url.protocol}').`);
  }
  if (!allowInternal && isInternalHost(url.hostname)) {
    throw new Error("Endereço recusado por segurança: hosts internos e locais não podem ser acessados por esta ferramenta.");
  }
  return url;
}

// ---------- HTTP com timeout (o sinal do usuário cancela junto) ----------

function withTimeout(userSignal, ms) {
  const timer = AbortSignal.timeout(ms);
  return { signal: userSignal ? AbortSignal.any([userSignal, timer]) : timer, timedOut: () => timer.aborted };
}

async function httpGet(fetchImpl, url, timeoutMs, userSignal) {
  const guard = withTimeout(userSignal, timeoutMs);
  try {
    return await fetchImpl(url, {
      redirect: "follow",
      signal: guard.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.7",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
      },
    });
  } catch (error) {
    if (userSignal?.aborted) throw new Error("Acesso à web cancelado pelo usuário.");
    if (guard.timedOut()) throw new Error(`Tempo esgotado (${Math.round(timeoutMs / 1000)}s) ao acessar ${url}.`);
    throw new Error(`Não foi possível conectar a ${url}: ${error?.cause?.code ?? error?.message ?? error}`);
  }
}

// Lê o corpo com teto de tamanho (uma resposta gigante não pode lotar a memória).
// Devolve os BYTES: o charset só é decidido depois, olhando o content-type (páginas em iso-8859-1 etc.).
async function readBody(response, timeoutGuard) {
  const reader = response.body?.getReader?.();
  if (!reader) return { bytes: new TextEncoder().encode(await response.text()), tooBig: false };
  const chunks = [];
  let total = 0;
  let tooBig = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > MAX_BODY_BYTES) {
        tooBig = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } catch (error) {
    if (timeoutGuard?.timedOut()) throw new Error(`Tempo esgotado ao baixar a página (limite: ${MAX_BODY_BYTES} bytes).`);
    throw error;
  }
  return { bytes: Buffer.concat(chunks), tooBig };
}

// Charset da resposta: do cabeçalho; senão da tag <meta charset> no começo do HTML; senão utf-8.
function charsetOf(contentType, bodyBytes) {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) return fromHeader;
  const head = bodyBytes.subarray(0, 4096).toString("latin1");
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
}

function decodeBody(bodyBytes, charset) {
  try {
    return new TextDecoder(charset).decode(bodyBytes);
  } catch {
    return new TextDecoder("utf-8").decode(bodyBytes); // charset desconhecido: melhor esforço
  }
}

// ---------- Busca: DuckDuckGo (endpoint HTML, sem chave, sem custo) ----------

// Links do DuckDuckGo vêm como redirect: //duckduckgo.com/l/?uddg=<url codificada>
function decodeDdgHref(raw) {
  let href = decodeEntities(String(raw));
  if (href.startsWith("//")) href = `https:${href}`;
  else if (href.startsWith("/")) href = `https://duckduckgo.com${href}`;
  try {
    const target = new URL(href).searchParams.get("uddg");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

// Aceita pequenas variações na marcação do DuckDuckGo; devolve no máximo `limit` resultados.
export function parseDdgResults(html, limit) {
  const anchors = [...String(html).matchAll(/<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...String(html).matchAll(/<a\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => stripTags(m[1]));
  const results = [];
  for (const match of anchors) {
    if (results.length >= limit) break;
    const url = decodeDdgHref(/href="([^"]*)"/i.exec(match[0])?.[1] ?? "");
    const title = stripTags(match[1]);
    if (!url || !/^https?:/i.test(url) || !title) continue;
    results.push({ title, url, snippet: (snippets[results.length] ?? "").slice(0, MAX_SNIPPET_CHARS) });
  }
  return results;
}

// ---------- Abrir abas no navegador (open_url) ----------

// Comando que abre o navegador PADRÃO com a URL. No Windows o "start" é interno do cmd:
// a URL vai entre aspas para o "&" das queries não virar separador de comandos, e o ""
// vazio é o título da janela (sem ele o start confundiria a URL com o título).
// windowsVerbatimArguments: as aspas são as nossas (controle total sobre o que o cmd vê).
export function buildOpenUrlCommand(platform, url) {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/c", "start", "", `"${url}"`], options: { windowsVerbatimArguments: true } };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

// Dispara a abertura e espera só o comando de abrir terminar (o navegador segue por conta
// própria, desanexado do agente). Erro do comando vira mensagem clara; abertura lenta não
// trava a tarefa (teto de espera otimista).
function openInBrowser(url, { platform, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const { command, args, options } = buildOpenUrlCommand(platform, url);
    let child;
    try {
      child = spawnImpl(command, args, { detached: true, stdio: "ignore", ...options });
    } catch (error) {
      reject(new Error(`Não foi possível abrir o navegador (${error.message}).`));
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("error", onError);
      child.removeListener?.("exit", onExit);
      fn(value);
    };
    const timer = setTimeout(() => finish(resolve), 5_000); // abertura lenta: assume que abriu
    timer.unref?.();
    const onError = (error) => finish(reject, new Error(
      `Não foi possível abrir o navegador padrão (${error?.code ?? error?.message ?? "erro desconhecido"}). ` +
        (platform === "linux" ? "Confira se o xdg-open existe (pacote xdg-utils)." : "Confira o navegador padrão do sistema.")
    ));
    const onExit = (code) => {
      if (code === 0) finish(resolve);
      else finish(reject, new Error(`O navegador não abriu (o comando de abertura terminou com código ${code}).`));
    };
    child.on?.("error", onError);
    child.on?.("exit", onExit);
    child.unref?.();
  });
}

// ---------- As ferramentas ----------

// fetchImpl é injetável (os testes usam servidor local e respostas falsas).
export function createWebTools({
  fetchImpl = fetch,
  fetchTimeoutMs = 20_000,
  searchTimeoutMs = 15_000,
  allowInternalHosts = false,
  platform = os.platform(),
  spawnImpl = spawn,
} = {}) {
  const webSearch = {
    name: "web_search",
    description:
      "Pesquisa na web (DuckDuckGo) e devolve uma lista de resultados com título, endereço e resumo. " +
      "Use para encontrar páginas sobre um assunto; depois use web_fetch para ler o conteúdo de um resultado.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: MAX_QUERY_CHARS, description: "O que pesquisar (termos de busca)." },
        max_results: { type: "integer", minimum: 1, maximum: 10, description: "Quantos resultados devolver (padrão: 5)." },
      },
      required: ["query"],
    },

    async execute({ query, max_results = 5 }, { signal } = {}) {
      const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
      const response = await httpGet(fetchImpl, url, searchTimeoutMs, signal);
      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          throw new Error(`A busca foi limitada pelo DuckDuckGo (${response.status}). Espere alguns instantes e tente de novo.`);
        }
        throw new Error(`A busca falhou (status ${response.status}). Tente novamente.`);
      }
      const guard = withTimeout(signal, searchTimeoutMs);
      const { bytes } = await readBody(response, guard);
      const results = parseDdgResults(new TextDecoder().decode(bytes), Math.min(max_results, 10));
      if (results.length === 0) {
        return `A busca por "${query}" não encontrou resultados. Tente outras palavras-chave.`;
      }
      const lines = [`Resultados da busca por "${query}" (DuckDuckGo):`];
      for (const [index, result] of results.entries()) {
        lines.push(`${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`);
      }
      return lines.join("\n");
    },
  };

  const webFetch = {
    name: "web_fetch",
    description:
      "Abre um endereço http(s) público e devolve o texto legível da página (sem HTML). " +
      "Para saber o endereço, pesquise primeiro com web_search. Não abre arquivos como PDF nem imagens.",
    requiresConfirmation: true,
    allowSessionApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: MAX_URL_CHARS, description: "Endereço completo, ex.: https://exemplo.com/pagina" },
      },
      required: ["url"],
    },

    // Valida ANTES de incomodar o usuário: URL inválida ou host interno nem chega ao painel.
    async prepare({ url }) {
      const parsed = parseHttpUrl(url, { allowInternal: allowInternalHosts });
      return `Abrir a página ${parsed.href} e trazer o texto dela para leitura.`;
    },

    async execute({ url }, { signal } = {}) {
      const parsed = parseHttpUrl(url, { allowInternal: allowInternalHosts });
      const response = await httpGet(fetchImpl, parsed, fetchTimeoutMs, signal);
      if (!response.ok) {
        throw new Error(`A página respondeu com erro ${response.status}${response.statusText ? ` (${response.statusText})` : ""}: ${parsed.href}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const type = contentType.split(";")[0].trim().toLowerCase();
      if (type && !/^(text\/|application\/(xhtml\+xml|xml|json|rss\+xml|atom\+xml))/.test(type)) {
        throw new Error(`A página não parece ser texto (content-type: '${type}'). Esta ferramenta lê páginas, não arquivos como PDF ou imagens.`);
      }

      const guard = withTimeout(signal, fetchTimeoutMs);
      const { bytes, tooBig } = await readBody(response, guard);
      const raw = decodeBody(bytes, charsetOf(contentType, bytes));
      const looksHtml = /html/i.test(type) || /<html|<!doctype/i.test(raw);
      const title = looksHtml ? pageTitle(raw) : "";
      const text = (looksHtml ? htmlToText(raw) : raw.replace(/\r\n/g, "\n")).trim();

      const total = text.length;
      const clipped = total > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
      const parts = [`Página: ${parsed.href}`, ...(title ? [`Título: ${title}`] : []), "", clipped];
      if (tooBig) parts.push(`\n[página cortada: o servidor enviou mais de ${MAX_BODY_BYTES} bytes]`);
      if (total > MAX_TEXT_CHARS) parts.push(`\n[texto truncado: mostrando ${MAX_TEXT_CHARS} de ${total} caracteres]`);
      return parts.join("\n");
    },
  };

  // Abrir abas é o que o usuário mais pede ("Jarvis, abre o YouTube"): não exige
  // confirmação, como web_search. As guardas: só http(s) público (hosts internos
  // bloqueados) e a instrução de abrir apenas o que foi pedido/serve à tarefa.
  const openUrl = {
    name: "open_url",
    description:
      "Abre um endereço http(s) no navegador padrão do usuário, em uma nova aba, SEM pedir confirmação. " +
      "Use quando o usuário pedir para abrir um site (ex.: 'abra o YouTube', 'abre o WhatsApp Web'). " +
      "Não lê o conteúdo da página: para ler, use web_fetch; para pesquisar, web_search. " +
      "Só abra endereços que o usuário pediu ou que claramente servem à tarefa atual.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: MAX_URL_CHARS, description: "Endereço completo, ex.: https://www.youtube.com" },
      },
      required: ["url"],
    },

    async execute({ url }, { signal } = {}) {
      const parsed = parseHttpUrl(url, { allowInternal: allowInternalHosts });
      if (signal?.aborted) throw new Error("Ação cancelada pelo usuário.");
      await openInBrowser(parsed.href, { platform, spawnImpl });
      return `Abri ${parsed.href} no navegador. Não vejo a página daqui; se precisar do conteúdo, use web_fetch.`;
    },
  };

  return [webSearch, webFetch, openUrl];
}
