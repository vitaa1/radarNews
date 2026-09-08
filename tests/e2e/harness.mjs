import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, copyFile, rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { Miniflare, Response, convertV4MiniflareOptions } from "miniflare";
import { analysis, archive, article } from "./fixtures.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const secret = "segredo-ficticio-exclusivo-do-e2e-123456";
const execFileAsync = promisify(execFile);

export async function harness(t) {
  // Nenhum .env, perfil pessoal ou banco do usuário entra no sandbox da CLI.
  await mkdir(join(root, ".wrangler"), { recursive: true });
  const directory = await mkdtemp(join(root, ".wrangler", "e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = join(directory, "local");
  await mkdir(local);
  for (const file of await readdir(join(root, "local"))) {
    if (file.endsWith(".py")) await copyFile(join(root, "local", file), join(local, file));
  }
  const state = { edition: 2, telegramStatus: 200, ollamaStatus: 200,
    sourceRedirect: false, workerRedirect: false, messages: [], prompts: [], completions: [], blocked: [] };
  const bundle = await build({ entryPoints: [join(root, "src/index.ts")], bundle: true,
    write: false, format: "esm", platform: "browser", target: "es2022" });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-30",
    d1Databases: ["DB"], bindings: { SHARED_SECRET: secret,
      TELEGRAM_BOT_TOKEN: "ficticio", TELEGRAM_CHAT_ID: "ficticio" },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "api.telegram.org" && url.pathname === "/botficticio/sendMessage") {
        const payload = await request.json();
        state.messages.push({ status: state.telegramStatus, text: payload.text });
        return Response.json(state.telegramStatus === 200
          ? { ok: true, result: { message_id: state.messages.length } }
          : { ok: false }, { status: state.telegramStatus });
      }
      if (["supercell.com", "www.youtube.com"].includes(url.hostname)) {
        const fixture = archive(url, state.edition);
        return new Response(fixture.body, { headers: { "Content-Type": fixture.contentType } });
      }
      state.blocked.push(url.hostname);
      return new Response("Destino externo recusado", { status: 502 });
    },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir(join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = await readFile(join(root, "migrations", file), "utf8");
    // Os arquivos atuais não contêm ponto e vírgula dentro de literais SQL.
    for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  const api = async (path, body, method = "POST", token = secret) => {
    const response = await mf.dispatchFetch("https://worker.test" + path, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const server = createServer(async (request, response) => {
    try {
      const parts = [];
      let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > 100_000) throw new Error("Pedido de fixture grande demais");
        parts.push(part);
      }
      const body = Buffer.concat(parts).toString("utf8");
      const host = request.headers.host;
      if (host === "worker.test") {
        if (state.workerRedirect) {
          response.writeHead(302, { Location: "https://fora-das-fixtures.example/" });
          response.end();
          return;
        }
        if (request.url.endsWith("/complete")) state.completions.push(JSON.parse(body));
        const result = await mf.dispatchFetch("https://worker.test" + request.url, {
          method: request.method, headers: request.headers,
          ...(["GET", "HEAD"].includes(request.method) ? {} : { body }),
        });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
      } else if (host === "ollama.test" && request.url === "/api/chat") {
        const payload = JSON.parse(body);
        state.prompts.push(payload);
        response.writeHead(state.ollamaStatus, { "Content-Type": "application/json" });
        response.end(JSON.stringify(state.ollamaStatus === 200
          ? { message: { content: JSON.stringify(analysis) } } : { error: "Falha simulada" }));
      } else if (host === "supercell.com" && request.url.startsWith("/en/games/brawlstars/blog/news/")) {
        if (state.sourceRedirect) {
          response.writeHead(302, { Location: "https://fora-das-fixtures.example/" });
          response.end();
        } else {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.end(article);
        }
      } else {
        state.blocked.push(host);
        response.writeHead(502);
        response.end("Destino externo recusado");
      }
    } catch {
      response.writeHead(500);
      response.end("Falha no servidor de fixtures");
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const python = async (dryRun = false) => {
    // Não herda proxies, tokens, PYTHONPATH ou configuração editorial do usuário.
    const env = {};
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LD_LIBRARY_PATH"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { WORKER_URL: "https://worker.test", SHARED_SECRET: secret,
      OLLAMA_URL: "https://ollama.test", OLLAMA_MODEL: "modelo-ficticio", LOCAL_BATCH_SIZE: "1",
      PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" });
    const executable = process.env.RADAR_TEST_PYTHON || "python";
    const prefix = JSON.parse(process.env.RADAR_TEST_PYTHON_ARGS || "[]");
    assert.ok(Array.isArray(prefix) && prefix.every((arg) => typeof arg === "string"));
    const args = [...prefix, "-I", "-S", "-B", join(root, "tests/e2e/python-entry.py"), join(local, "processador.py"),
      String(server.address().port), ...(dryRun ? ["--dry-run"] : [])];
    try {
      const result = await execFileAsync(executable, args, { cwd: directory, env, timeout: 20_000, maxBuffer: 200_000 });
      return { code: 0, ...result };
    } catch (error) {
      if (typeof error.code !== "number" || error.killed) throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const discover = async () => {
    const initial = await api("/api/run");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.baselineStored, 6);
    assert.equal(state.messages.length, 0);
    state.edition = 3;
    const next = await api("/api/run");
    assert.equal(next.body.inserted, 1);
    assert.equal(next.body.alerts.sent, 1);
    return (await db.prepare("SELECT id FROM items WHERE status='pending'").first()).id;
  };
  const row = (id) => db.prepare("SELECT * FROM items WHERE id=?1").bind(id).first();
  return { state, db, api, python, discover, row };
}
