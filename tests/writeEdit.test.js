import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { createWriteFileTool } from "../src/tools/writeFile.js";
import { createEditFileTool } from "../src/tools/editFile.js";

let base, ws, registry, asks;

// Um ambiente novo por teste: nenhum teste depende do resultado de outro.
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-we-"));
  ws = path.join(base, "ws");
  await fs.mkdir(path.join(ws, "sub"), { recursive: true });
  await fs.writeFile(path.join(ws, "exist.txt"), "conteúdo original");
  registry = new ToolRegistry();
  registry.register(createWriteFileTool({ workspaceDir: ws }));
  registry.register(createEditFileTool({ workspaceDir: ws }));
  asks = [];
});
afterEach(() => fs.rm(base, { recursive: true, force: true }));

const yes = async (request) => (asks.push(request), "yes");
const write = (input, confirm = yes) => registry.execute("write_file", input, { confirm });
const edit = (input, confirm = yes) => registry.execute("edit_file", input, { confirm });
const exists = (p) => fs.access(p).then(() => true, () => false);
const read = (p) => fs.readFile(path.join(ws, p), "utf8");

// ===================== write_file =====================
test("write: cria arquivo novo e pastas que faltam, mostrando prévia ao usuário", async () => {
  const r = await write({ path: "novo/dir/a.txt", content: "olá mundo" });
  assert.equal(r.ok, true, r.error);
  assert.equal(await read("novo/dir/a.txt"), "olá mundo");
  assert.match(asks[0].description, /Criar o arquivo 'novo\/dir\/a.txt'/);
  assert.match(asks[0].description, /olá mundo/);
});

test("write: sem confirm ou com 'no', nada é criado", async () => {
  assert.equal((await registry.execute("write_file", { path: "x.txt", content: "a" })).denied, true);
  assert.equal((await write({ path: "y.txt", content: "a" }, async () => "no")).denied, true);
  assert.equal(await exists(path.join(ws, "x.txt")), false);
  assert.equal(await exists(path.join(ws, "y.txt")), false);
});

test("write: arquivo existente exige overwrite=true e a descrição avisa", async () => {
  const blocked = await write({ path: "exist.txt", content: "novo" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /já existe.*edit_file/);
  assert.equal(asks.length, 0); // recusado ANTES de perguntar
  assert.equal(await read("exist.txt"), "conteúdo original");

  const ok = await write({ path: "exist.txt", content: "substituído", overwrite: true });
  assert.equal(ok.ok, true);
  assert.match(asks[0].description, /SOBRESCREVER/);
  assert.equal(await read("exist.txt"), "substituído");
});

test("write: preserva conteúdo exato (acentos, CRLF, emoji, vazio)", async () => {
  const content = "a\r\nb é ç 日本語 🚀\n\ttab";
  await write({ path: "cr.txt", content });
  assert.equal(await read("cr.txt"), content);
  await write({ path: "vazio.txt", content: "" });
  assert.equal(await read("vazio.txt"), "");
});

test("write: não escreve fora do workspace nem pergunta ao usuário", async () => {
  for (const p of ["../fora.txt", "sub/../../fora.txt", path.join(base, "fora.txt"), "/tmp/agent-abs-teste.txt"]) {
    const r = await write({ path: p, content: "x" });
    assert.equal(r.ok, false, p);
    assert.match(r.error, /fora do diretório de trabalho/, p);
  }
  assert.equal(asks.length, 0);
  assert.equal(await exists(path.join(base, "fora.txt")), false);
  assert.equal(await exists("/tmp/agent-abs-teste.txt"), false);
});

test("write: arquivos e pastas sensíveis são bloqueados", async () => {
  for (const p of [".env", ".env.local", ".npmrc", ".git/hooks/pre-commit", ".ssh/authorized_keys", "sub/.env", "id_rsa"]) {
    const r = await write({ path: p, content: "x" });
    assert.equal(r.ok, false, p);
    assert.match(r.error, /sensível/, p);
  }
  assert.equal(await exists(path.join(ws, ".git")), false); // nem a pasta foi criada
  assert.equal(asks.length, 0);
});

test("write: link simbólico QUEBRADO apontando para fora não cria arquivo no destino", async (t) => {
  const target = path.join(base, "criado-fora.txt");
  try { await fs.symlink(target, path.join(ws, "pendurado.txt")); } catch { return t.skip("sem links simbólicos"); }
  const r = await write({ path: "pendurado.txt", content: "PWN", overwrite: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /quebrado/);
  assert.equal(await exists(target), false);
});

test("write: pasta-link apontando para fora é bloqueada", async (t) => {
  try { await fs.symlink(base, path.join(ws, "linkdir")); } catch { return t.skip("sem links simbólicos"); }
  const r = await write({ path: "linkdir/pwn.txt", content: "PWN" });
  assert.equal(r.ok, false);
  assert.match(r.error, /link simbólico/);
  assert.equal(await exists(path.join(base, "pwn.txt")), false);
  // mesmo com subpastas que ainda não existem
  const deep = await write({ path: "linkdir/a/b/pwn.txt", content: "PWN" });
  assert.equal(deep.ok, false);
  assert.equal(await exists(path.join(base, "a")), false);
});

test("write: link para dentro de .git não contorna o bloqueio", async (t) => {
  await fs.mkdir(path.join(ws, ".git", "hooks"), { recursive: true });
  try { await fs.symlink(path.join(ws, ".git"), path.join(ws, "gitlink")); } catch { return t.skip("sem links simbólicos"); }
  const r = await write({ path: "gitlink/hooks/pre-commit", content: "#!/bin/sh\nrm -rf ~" });
  assert.equal(r.ok, false);
  assert.match(r.error, /sensível/);
  assert.equal(await exists(path.join(ws, ".git", "hooks", "pre-commit")), false);
});

test("write: diretórios, caminhos por dentro de arquivo e limites de tamanho", async () => {
  assert.match((await write({ path: "sub", content: "x", overwrite: true })).error, /diretório/);
  assert.equal((await write({ path: "exist.txt/filho.txt", content: "x" })).ok, false);
  assert.match((await write({ path: "grande.txt", content: "a".repeat(1_000_001) })).error, /no máximo/);
  // 400 mil caracteres de 3 bytes = 1,2 MB: passa no limite de caracteres, mas não no de bytes
  assert.match((await write({ path: "grande2.txt", content: "日".repeat(400_000) })).error, /grande demais/);
  assert.match((await write({ path: "x.txt", content: 42 })).error, /string/);
  assert.match((await write({ path: "", content: "x" })).error, /não vazio/);
});

test("write: se o arquivo surgir entre a aprovação e a gravação, não é sobrescrito", async () => {
  const confirm = async () => {
    await fs.writeFile(path.join(ws, "corrida.txt"), "criado por outro processo");
    return "yes";
  };
  const r = await write({ path: "corrida.txt", content: "meu conteúdo" }, confirm);
  assert.equal(r.ok, false);
  assert.match(r.error, /já existe/);
  assert.equal(await read("corrida.txt"), "criado por outro processo");
});

// ===================== edit_file =====================
test("edit: troca um trecho único e mostra o que sai e o que entra", async () => {
  await fs.writeFile(path.join(ws, "code.js"), "const a = 1;\nconst b = 2;\n");
  const r = await edit({ path: "code.js", old_string: "const b = 2;", new_string: "const b = 3;" });
  assert.equal(r.ok, true, r.error);
  assert.equal(await read("code.js"), "const a = 1;\nconst b = 3;\n");
  assert.match(asks[0].description, /--- remover ---\nconst b = 2;/);
  assert.match(asks[0].description, /--- inserir ---\nconst b = 3;/);
});

test("edit: trecho não encontrado, múltiplo ou inválido gera erro e não altera o arquivo", async () => {
  await fs.writeFile(path.join(ws, "m.txt"), "foo bar foo");
  assert.match((await edit({ path: "m.txt", old_string: "zzz", new_string: "x" })).error, /não foi encontrado/);
  assert.match((await edit({ path: "m.txt", old_string: "foo", new_string: "x" })).error, /aparece 2 vezes/);
  assert.match((await edit({ path: "m.txt", old_string: "", new_string: "x" })).error, /não pode ser vazio/);
  assert.match((await edit({ path: "m.txt", old_string: "foo", new_string: "foo" })).error, /iguais/);
  assert.equal(await read("m.txt"), "foo bar foo");
  assert.equal(asks.length, 0);
});

test("edit: ocorrências SOBREPOSTAS contam como ambíguas ('aa' em 'aaa')", async () => {
  await fs.writeFile(path.join(ws, "o.txt"), "aaa");
  const r = await edit({ path: "o.txt", old_string: "aa", new_string: "X" });
  assert.equal(r.ok, false);
  assert.match(r.error, /aparece 2 vezes/);
  assert.equal(await read("o.txt"), "aaa");
});

test("edit: new_string com $&, $1, $$ é literal (não é padrão de regex)", async () => {
  await fs.writeFile(path.join(ws, "d.txt"), "preço: ALVO fim");
  await edit({ path: "d.txt", old_string: "ALVO", new_string: "$& $1 $$ $` $'" });
  assert.equal(await read("d.txt"), "preço: $& $1 $$ $` $' fim");
});

test("edit: old_string com caracteres de regex e várias linhas é literal", async () => {
  await fs.writeFile(path.join(ws, "r.txt"), "x = a.b*c(d)[e]\nlinha2\nfim");
  const r = await edit({ path: "r.txt", old_string: "a.b*c(d)[e]\nlinha2", new_string: "OK" });
  assert.equal(r.ok, true, r.error);
  assert.equal(await read("r.txt"), "x = OK\nfim");
});

test("edit: arquivo CRLF com trecho LF dá erro com dica sobre \\r\\n", async () => {
  await fs.writeFile(path.join(ws, "w.txt"), "a\r\nb\r\n");
  const r = await edit({ path: "w.txt", old_string: "a\nb", new_string: "x" });
  assert.equal(r.ok, false);
  assert.match(r.error, /\\r\\n/);
});

test("edit: inexistente, diretório, binário, fora do workspace e sensível", async () => {
  await fs.writeFile(path.join(ws, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  await fs.writeFile(path.join(ws, ".env"), "K=segredo");
  await fs.writeFile(path.join(base, "fora.txt"), "FORA");
  const e = (p) => edit({ path: p, old_string: "a", new_string: "b" });
  assert.match((await e("nao-existe.txt")).error, /não encontrado/);
  assert.match((await e("sub")).error, /diretório/);
  assert.match((await e("bin.dat")).error, /binário/);
  assert.match((await e("../fora.txt")).error, /fora do diretório/);
  assert.match((await e(".env")).error, /sensível/);
  assert.equal(await fs.readFile(path.join(base, "fora.txt"), "utf8"), "FORA");
  assert.equal(await read(".env"), "K=segredo");
});

test("edit: negado ou sem confirmação não altera o arquivo", async () => {
  const before = await read("exist.txt");
  assert.equal((await registry.execute("edit_file", { path: "exist.txt", old_string: "original", new_string: "X" })).denied, true);
  assert.equal((await edit({ path: "exist.txt", old_string: "original", new_string: "X" }, async () => "no")).denied, true);
  assert.equal(await read("exist.txt"), before);
});

test("edit: se o arquivo mudar entre a aprovação e a gravação, a edição falha em vez de corromper", async () => {
  const confirm = async () => {
    await fs.writeFile(path.join(ws, "exist.txt"), "outro conteúdo totalmente diferente");
    return "yes";
  };
  const r = await edit({ path: "exist.txt", old_string: "original", new_string: "X" }, confirm);
  assert.equal(r.ok, false);
  assert.match(r.error, /não foi encontrado/);
  assert.equal(await read("exist.txt"), "outro conteúdo totalmente diferente");
});

test("edit: arquivo grande demais é recusado", async () => {
  await fs.writeFile(path.join(ws, "big.txt"), "a".repeat(1_000_100));
  assert.match((await edit({ path: "big.txt", old_string: "a", new_string: "b" })).error, /grande demais/);
});
