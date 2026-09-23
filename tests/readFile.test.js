import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { createReadFileTool } from "../src/tools/readFile.js";

let base;
let workspace;
let registry;

before(async () => {
  // base/
  //   secret.txt            <- FORA do workspace
  //   ws-evil/file.txt      <- pasta irmã com nome parecido, FORA do workspace
  //   ws/                   <- o workspace
  base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-test-"));
  workspace = path.join(base, "ws");
  await fs.mkdir(path.join(workspace, "sub", "dir"), { recursive: true });
  await fs.mkdir(path.join(base, "ws-evil"));

  await fs.writeFile(path.join(base, "secret.txt"), "SEGREDO");
  await fs.writeFile(path.join(base, "ws-evil", "file.txt"), "SEGREDO-EVIL");
  await fs.writeFile(path.join(workspace, "hello.txt"), "olá mundo");
  await fs.writeFile(path.join(workspace, "sub", "dir", "deep.txt"), "no fundo");
  await fs.writeFile(path.join(workspace, "empty.txt"), "");
  await fs.writeFile(path.join(workspace, "especial.txt"), "café ção 日本語 🚀\nlinha 2\ttab");
  await fs.writeFile(path.join(workspace, "relatório final ção.txt"), "nome com acento e espaço");
  await fs.writeFile(path.join(workspace, "img.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
  await fs.writeFile(path.join(workspace, "big.txt"), "a".repeat(150 * 1024));
  await fs.writeFile(path.join(workspace, ".env"), "ANTHROPIC_API_KEY=segredo");
  await fs.writeFile(path.join(workspace, ".env.local"), "segredo-local");
  await fs.writeFile(path.join(workspace, ".env.production"), "segredo-prod");
  await fs.writeFile(path.join(workspace, ".env.example.bak"), "segredo-bak");
  await fs.writeFile(path.join(workspace, ".npmrc"), "segredo-npm");
  await fs.writeFile(path.join(workspace, "id_rsa"), "segredo-ssh");
  await fs.writeFile(path.join(workspace, ".env.example"), "ANTHROPIC_API_KEY=sua-chave-aqui");
  await fs.writeFile(path.join(workspace, "..leading-dots.txt"), "começa com dois pontos");

  registry = new ToolRegistry();
  registry.register(createReadFileTool({ workspaceDir: workspace }));
});

after(() => fs.rm(base, { recursive: true, force: true }));

const read = (p) => registry.execute("read_file", { path: p });

test("1. arquivo existente", async () => {
  assert.deepEqual(await read("hello.txt"), { ok: true, output: "olá mundo", images: [] });
});

test("2. arquivo inexistente", async () => {
  const r = await read("nao-existe.txt");
  assert.equal(r.ok, false);
  assert.match(r.error, /Arquivo não encontrado: 'nao-existe.txt'/);
});

test("2b. 'arquivo/algo' quando arquivo não é diretório", async () => {
  const r = await read("hello.txt/abc");
  assert.equal(r.ok, false);
  assert.match(r.error, /não encontrado/);
});

test("3. caminho apontando para diretório", async () => {
  for (const p of ["sub", "sub/dir", ".", "./"]) {
    const r = await read(p);
    assert.equal(r.ok, false, p);
    assert.match(r.error, /é um diretório/, p);
  }
});

test("4. arquivos dentro do workspace (incluindo subpastas e ../ interno)", async () => {
  assert.equal((await read("sub/dir/deep.txt")).output, "no fundo");
  assert.equal((await read("./sub/dir/deep.txt")).output, "no fundo");
  assert.equal((await read("sub/../hello.txt")).output, "olá mundo");
  assert.equal((await read(path.join(workspace, "hello.txt"))).output, "olá mundo");
  assert.equal((await read("..leading-dots.txt")).output, "começa com dois pontos");
});

test("5. tentativas de sair do workspace", async () => {
  const attempts = [
    "../secret.txt",
    "sub/../../secret.txt",
    "./../secret.txt",
    "../ws-evil/file.txt", // pasta irmã com prefixo igual
    "sub/dir/../../../secret.txt",
    path.join(base, "secret.txt"), // caminho absoluto
    "/etc/passwd",
    "..",
    "../",
  ];
  for (const p of attempts) {
    const r = await read(p);
    assert.equal(r.ok, false, `deveria bloquear: ${p}`);
    assert.match(r.error, /fora do diretório de trabalho/, p);
    assert.ok(!JSON.stringify(r).includes("SEGREDO"), `vazou conteúdo: ${p}`);
  }
});

test("5b. links simbólicos que escapam do workspace", async (t) => {
  try {
    await fs.symlink(path.join(base, "secret.txt"), path.join(workspace, "link-arquivo.txt"));
    await fs.symlink(base, path.join(workspace, "link-dir"));
    await fs.symlink(path.join(workspace, "hello.txt"), path.join(workspace, "link-interno.txt"));
    await fs.symlink(path.join(workspace, ".env"), path.join(workspace, "notas.txt"));
  } catch {
    return t.skip("sistema não permite criar links simbólicos");
  }

  for (const p of ["link-arquivo.txt", "link-dir/secret.txt"]) {
    const r = await read(p);
    assert.equal(r.ok, false, p);
    assert.match(r.error, /link simbólico/, p);
    assert.ok(!JSON.stringify(r).includes("SEGREDO"));
  }

  // link que aponta para dentro do workspace é permitido
  assert.equal((await read("link-interno.txt")).output, "olá mundo");

  // link com nome inocente apontando para .env continua bloqueado
  const r = await read("notas.txt");
  assert.equal(r.ok, false);
  assert.match(r.error, /\.env/);
  assert.ok(!JSON.stringify(r).includes("segredo"));
});

test("6. arquivo vazio", async () => {
  assert.deepEqual(await read("empty.txt"), { ok: true, output: "(arquivo vazio)", images: [] });
});

test("7. caracteres especiais no conteúdo e no nome", async () => {
  assert.equal((await read("especial.txt")).output, "café ção 日本語 🚀\nlinha 2\ttab");
  assert.equal((await read("relatório final ção.txt")).output, "nome com acento e espaço");
});

test("arquivos .env são bloqueados, .env.example é permitido", async () => {
  for (const p of [".env", ".env.local", ".ENV", ".ENV.Local", ".env.production", ".env.example.bak", "./.env", "sub/../.env", ".npmrc", "id_rsa"]) {
    const r = await read(p);
    assert.equal(r.ok, false, p);
    assert.match(r.error, /\.env/, p);
    assert.ok(!JSON.stringify(r).includes("segredo"));
  }
  assert.equal((await read(".env.example")).ok, true);
  assert.equal((await read(".envrc")).ok, false); // não existe: "não encontrado", mas NÃO bloqueado por ser sensível
});

test("arquivo binário é recusado", async () => {
  const r = await read("img.bin");
  assert.equal(r.ok, false);
  assert.match(r.error, /binário/);
});

test("arquivo grande é truncado com aviso", async () => {
  const r = await read("big.txt");
  assert.equal(r.ok, true);
  assert.match(r.output, /arquivo truncado/);
  assert.ok(r.output.length < 100 * 1024 + 300);
});

test("parâmetro path ausente, inválido ou vazio", async () => {
  assert.match((await registry.execute("read_file", {})).error, /'path' é obrigatório/);
  assert.match((await read(123)).error, /'path' deve ser do tipo string/);
  assert.match((await read("")).error, /não vazio/);
  assert.match((await read("   ")).error, /não vazio/);
  assert.match((await read("a\0b")).error, /inválido/);
});

test("workspace inexistente gera erro claro", async () => {
  const broken = new ToolRegistry();
  broken.register(createReadFileTool({ workspaceDir: path.join(base, "nao-existe") }));
  const r = await broken.execute("read_file", { path: "x.txt" });
  assert.equal(r.ok, false);
  assert.match(r.error, /diretório de trabalho/);
});
