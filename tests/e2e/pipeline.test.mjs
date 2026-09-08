import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./harness.mjs";

test("E2E: coleta → CLI Python → leitura HTML → Ollama → D1 → Telegram", { timeout: 40_000 }, async (t) => {
  const h = await harness(t);
  const id = await h.discover();
  const run = await h.python();
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Pauta enviada ao Telegram/);
  assert.equal((await h.row(id)).status, "processed");
  assert.equal(h.state.messages.length, 2);
  assert.match(h.state.messages[1].text, /Pauta criada/);
  const prompt = h.state.prompts[0].messages[1].content;
  assert.match(prompt, /Não foram divulgadas recompensas/);
  assert.doesNotMatch(prompt, /Navegação que deve ser ignorada|Rodapé que deve ser ignorado/);
  assert.equal((await h.api(`/api/items/${id}/complete`, h.state.completions[0])).status, 409);
  await h.api("/api/run");
  assert.equal(h.state.messages.length, 2);
  assert.equal((await h.api("/api/status", undefined, "GET")).body.queue.pending, 0);
  assert.deepEqual(h.state.blocked, []);
});

test("E2E: falha do modelo, backoff, dry-run e recuperação em processos distintos", { timeout: 40_000 }, async (t) => {
  const h = await harness(t);
  const id = await h.discover();
  h.state.ollamaStatus = 503;
  assert.equal((await h.python()).code, 1);
  assert.equal((await h.row(id)).retry_count, 1);
  assert.ok((await h.row(id)).next_retry_at);
  const waiting = await h.python();
  assert.match(waiting.stdout, /Nenhuma pauta pendente/);
  assert.equal(h.state.prompts.length, 1);
  // Avança somente a elegibilidade do item sintético, sem sleeps de minutos.
  await h.db.prepare("UPDATE items SET next_retry_at='2000-01-01T00:00:00.000Z' WHERE id=?1").bind(id).run();
  h.state.ollamaStatus = 200;
  const dry = await h.python(true);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal((await h.row(id)).status, "pending");
  assert.equal((await h.row(id)).retry_count, 1);
  assert.equal(h.state.messages.length, 1);
  assert.equal((await h.python()).code, 0);
  assert.equal((await h.row(id)).status, "processed");
  assert.equal(h.state.messages.length, 2);
});

test("E2E: entrega diferida, quarentena e reenvio autenticado sem regenerar", { timeout: 40_000 }, async (t) => {
  const h = await harness(t);
  const id = await h.discover();
  h.state.telegramStatus = 503;
  const run = await h.python();
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Telegram será tentado novamente/);
  assert.equal((await h.row(id)).status, "ready");
  await h.api("/api/run");
  assert.equal(h.state.messages.length, 2);
  await h.db.prepare("UPDATE items SET analysis_next_retry_at='2000-01-01T00:00:00.000Z' WHERE id=?1").bind(id).run();
  h.state.telegramStatus = 400;
  await h.api("/api/run");
  assert.ok((await h.row(id)).analysis_dead_lettered_at);
  assert.equal((await h.api(`/api/items/${id}/retry-delivery`, { kind: "analysis" })).status, 200);
  h.state.telegramStatus = 200;
  await h.api("/api/run");
  assert.equal((await h.row(id)).status, "processed");
  assert.equal(h.state.prompts.length, 1);
  assert.equal(h.state.messages.filter((message) => message.status === 200).length, 2);
});

test("E2E: leitor recusa redirecionamento da fonte e devolve a pauta sem chamar o modelo", { timeout: 40_000 }, async (t) => {
  const h = await harness(t);
  const id = await h.discover();
  h.state.sourceRedirect = true;
  const run = await h.python();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /domínio não autorizado/);
  assert.equal((await h.row(id)).status, "pending");
  assert.equal((await h.row(id)).retry_count, 1);
  assert.equal(h.state.prompts.length, 0);
  assert.deepEqual(h.state.blocked, []);
});

test("E2E: redirecionamento autenticado do Worker é recusado antes da reserva", { timeout: 40_000 }, async (t) => {
  const h = await harness(t);
  const id = await h.discover();
  h.state.workerRedirect = true;
  const run = await h.python();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /redirecionamento/);
  assert.equal((await h.row(id)).claim_token, null);
  assert.equal((await h.row(id)).retry_count, 0);
  assert.equal(h.state.prompts.length, 0);
  assert.deepEqual(h.state.blocked, []);
});

test("Integração D1: autenticação, reservas concorrentes e lease incorreto", { timeout: 40_000 }, async (t) => {
  const h = await harness(t);
  const id = await h.discover();
  assert.equal((await h.api("/api/items/claim", undefined, "POST", "incorreto")).status, 401);
  const claims = await Promise.all(Array.from({ length: 8 }, () => h.api("/api/items/claim")));
  assert.ok(claims.every((claim) => claim.status === 200));
  const reserved = claims.filter((claim) => claim.body.items.length > 0);
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].body.items[0].id, id);
  assert.equal((await h.api(`/api/items/${id}/release`, { claimToken: "incorreto" })).status, 409);
  assert.equal((await h.row(id)).status, "processing");
  const release = await h.api(`/api/items/${id}/release`, { claimToken: reserved[0].body.claimToken, countFailure: false });
  assert.equal(release.status, 200);
  assert.equal((await h.row(id)).status, "pending");
  assert.equal((await h.row(id)).retry_count, 0);
});
