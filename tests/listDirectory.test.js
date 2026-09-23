import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { createListDirectoryTool } from "../src/tools/listDirectory.js";

let base, ws, registry;
before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ls-"));
  ws = path.join(base, "ws");
  await fs.mkdir(path.join(ws, "sub"), { recursive: true });
  await fs.mkdir(path.join(ws, "vazia"));
  await fs.mkdir(path.join(ws, "muitos"));
  await fs.mkdir(path.join(base, "fora"));
  await fs.writeFile(path.join(ws, "b.txt"), "b");
  await fs.writeFile(path.join(ws, "a.txt"), "a");
  await fs.writeFile(path.join(ws, "café ção.txt"), "x");
  await fs.writeFile(path.join(base, "fora", "segredo.txt"), "SEGREDO");
  for (let i = 0; i < 600; i++) await fs.writeFile(path.join(ws, "muitos", `f${String(i).padStart(3, "0")}.txt`), "");
  registry = new ToolRegistry();
  registry.register(createListDirectoryTool({ workspaceDir: ws }));
});
after(() => fs.rm(base, { recursive: true, force: true }));
const ls = (input) => registry.execute("list_directory", input);

test("sem path lista a raiz; pastas terminam com /", async () => {
  const r = await ls({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.output.split("\n"), ["a.txt", "b.txt", "café ção.txt", "muitos/", "sub/", "vazia/"]);
});

test("'.', './' e subpastas", async () => {
  assert.equal((await ls({ path: "." })).ok, true);
  assert.equal((await ls({ path: "./" })).ok, true);
  assert.equal((await ls({ path: "sub" })).output, "(diretório vazio)");
  assert.equal((await ls({ path: "vazia" })).output, "(diretório vazio)");
});

test("arquivo, inexistente e caminho vazio dão erros claros", async () => {
  assert.match((await ls({ path: "a.txt" })).error, /é um arquivo, não um diretório.*read_file/);
  assert.match((await ls({ path: "nao-existe" })).error, /Pasta não encontrado/);
  assert.match((await ls({ path: "" })).error, /não vazio/);
  assert.match((await ls({ path: 5 })).error, /string/);
});

test("não sai do workspace", async () => {
  for (const p of ["..", "../fora", "sub/../../fora", path.join(base, "fora"), "/etc"]) {
    const r = await ls({ path: p });
    assert.equal(r.ok, false, p);
    assert.match(r.error, /fora do diretório de trabalho/, p);
  }
});

test("links simbólicos: marcados com @ e bloqueados se apontam para fora", async (t) => {
  try {
    await fs.symlink(path.join(base, "fora"), path.join(ws, "link-fora"));
    await fs.symlink(path.join(ws, "sub"), path.join(ws, "link-dentro"));
  } catch {
    return t.skip("sem suporte a links simbólicos");
  }
  const root = (await ls({})).output.split("\n");
  assert.ok(root.includes("link-fora@") && root.includes("link-dentro@"));
  const escaped = await ls({ path: "link-fora" });
  assert.equal(escaped.ok, false);
  assert.match(escaped.error, /link simbólico/);
  assert.ok(!JSON.stringify(escaped).includes("segredo"));
  assert.equal((await ls({ path: "link-dentro" })).ok, true);
});

test("pastas sensíveis (.git, .ssh) não são listadas", async () => {
  await fs.mkdir(path.join(ws, ".git"), { recursive: true });
  await fs.writeFile(path.join(ws, ".git", "config"), "token=SEGREDO");
  const r = await ls({ path: ".git" });
  assert.equal(r.ok, false);
  assert.match(r.error, /sensível/);
});

test("listas muito grandes são truncadas com aviso", async () => {
  const r = await ls({ path: "muitos" });
  assert.equal(r.ok, true);
  assert.match(r.output, /mostrando 500 de 600/);
  assert.equal(r.output.split("\n").filter((l) => l.startsWith("f")).length, 500);
});
