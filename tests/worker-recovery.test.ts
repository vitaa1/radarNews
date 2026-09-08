import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import worker from "../src/index.ts";
import { SOURCES } from "../src/config.ts";
import { sqliteDatabase } from "./support/sqlite-d1.ts";

const SECRET = "teste-local-sem-credencial-real-123456";
const NOW = "2026-09-05T12:00:00.000Z";
const ANALYSIS = {
  resumo: "Resumo factual suficientemente longo para passar pela validação do Worker.",
  classificacao: "Comunicado", prioridade: "Média",
  publico_alvo: "Jogadores interessados nas novidades oficiais.",
  angulo_diferenciado: "Explicar o impacto prático do comunicado com base na fonte oficial.",
  gancho_abertura: "Esta novidade oficial muda um ponto importante para os jogadores.",
  titulos: ["Primeiro título", "Segundo título", "Terceiro título"],
  conceito_thumbnail: "Imagem oficial em destaque.",
  estrategia_retencao: "Apresentar a mudança e explicar o impacto com base na fonte oficial.",
  experimento_crescimento: "Testar o gancho e comparar a retenção com o histórico do canal.",
  roteiro_curto: "Roteiro factual suficientemente longo para ser aceito pelo Worker. ".repeat(8),
  pontos_a_verificar: "Conferir a fonte oficial.",
};

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(NOW) });
  t.mock.method(console, "error", () => undefined);
  const database = sqliteDatabase();
  t.after(() => database.sqlite.close());
  const env = { DB: database.DB, SHARED_SECRET: SECRET,
    TELEGRAM_BOT_TOKEN: "ficticio", TELEGRAM_CHAT_ID: "ficticio" };
  const network = { fetches: 0, sourceItems: 20, redirects: 0,
    messages: [] as string[], telegram: (): Response => Response.json({ ok: true, result: { message_id: 1 } }) };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    network.fetches += 1;
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.telegram.org") {
      assert.equal(init?.redirect, "manual", "Telegram não deve ampliar o orçamento com redirects");
      network.messages.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return network.telegram();
    }
    assert.ok(["supercell.com", "www.youtube.com"].includes(url.hostname));
    const step = Number(url.searchParams.get("step") ?? 0);
    if (step < network.redirects) {
      url.searchParams.set("step", String(step + 1));
      return new Response(null, { status: 302, headers: { Location: url.href } });
    }
    const youtube = url.hostname === "www.youtube.com";
    const path = url.pathname.includes("/announcement/") ? "/en/news/" : "/en/games/brawlstars/blog/news/";
    const body = youtube ? "<feed>" + Array.from({ length: network.sourceItems }, (_, i) =>
      `<entry><yt:videoId>video${String(i).padStart(6, "0")}</yt:videoId><title>Vídeo ${i}</title></entry>`).join("") + "</feed>"
      : Array.from({ length: network.sourceItems }, (_, i) => `<a href="${path}noticia-${i}/">Título ' seguro ${i}</a>`).join("");
    const response = new Response(body, { headers: { "Content-Type": youtube ? "application/atom+xml" : "text/html" } });
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  });
  const request = (path: string, payload?: unknown, method = "POST", secret = SECRET) =>
    worker.fetch(new Request("https://radar.example" + path, { method,
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }), env);
  const seed = (n: number, status = "pending", sent = false, analysis: string | null = JSON.stringify(ANALYSIS)) => {
    const id = n.toString(16).padStart(64, "0");
    database.sqlite.prepare(`INSERT INTO items
      (id,source_id,source_name,title,url,discovered_at,status,alert_sent_at,analysis_json,analysis_ready_at)
      VALUES(?,'audit','Auditoria',?,? ,?, ?, ?, ?, ?)`)
      .run(id, `Item ${n}`, `https://supercell.com/en/news/audit-${n}/`,
        new Date(Date.parse(NOW) - 100_000 + n * 1_000).toISOString(), status, sent ? NOW : null, analysis, NOW);
    return id;
  };
  const row = (id: string) => database.sqlite.prepare("SELECT * FROM items WHERE id=?").get(id)!;
  const baselines = () => {
    for (const source of SOURCES) database.sqlite.prepare("INSERT INTO metadata VALUES(?,?)").run(`baseline:${source.id}`, NOW);
  };
  return { database, network, request, seed, row, baselines };
}

test("coleta em lote preserva baseline, deduplicação e estados sem exceder orçamento", async (t) => {
  const s = setup(t);
  const first = await s.request("/api/run");
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { baselineStored: number }).baselineStored, 60);
  assert.equal(s.network.messages.length, 0);
  assert.equal(s.database.calls, 18);
  assert.equal(s.database.sqlite.prepare("SELECT count(*) AS n FROM items WHERE status='ignored'").get()?.n, 60);
  s.database.calls = 0;
  const again = await s.request("/api/run");
  assert.equal((await again.json() as { inserted: number }).inserted, 0);
  assert.equal(s.database.calls, 15);
  assert.equal(s.database.sqlite.prepare("SELECT count(*) AS n FROM items").get()?.n, 60);
});

test("coleta nova guarda artigos pendentes e vídeos processados com apóstrofo como dado", async (t) => {
  const s = setup(t); s.baselines();
  const result = await s.request("/api/run");
  assert.equal((await result.json() as { inserted: number }).inserted, 60);
  assert.equal(s.database.sqlite.prepare("SELECT count(*) AS n FROM items WHERE status='pending'").get()?.n, 40);
  assert.equal(s.database.sqlite.prepare("SELECT count(*) AS n FROM items WHERE status='processed' AND analysis_required=0 AND processed_at IS NOT NULL").get()?.n, 20);
  assert.equal(s.database.sqlite.prepare("SELECT title FROM items WHERE source_id='supercell-brawl-blog' LIMIT 1").get()?.title, "Título ' seguro 0");
});

for (const failPersistence of [false, true]) {
  test(`orçamento máximo inclui redirects, backlog e falha de persistência=${failPersistence}`, async (t) => {
    const s = setup(t);
    s.network.redirects = 5;
    for (let i = 0; i < 20; i++) s.seed(i, "ready", true);
    for (let i = 20; i < 40; i++) s.seed(i);
    s.database.beforeQuery = (sql) => {
      assert.ok(s.database.calls + s.network.fetches <= 50, "Limite Free excedido");
      if (failPersistence && (sql.includes("SET alert_sent_at") || sql.includes("SET status = 'processed'"))) {
        throw new Error("Falha sintética de persistência");
      }
    };
    const response = await s.request("/api/run");
    assert.equal(response.status, 200);
    assert.equal(s.network.messages.length, 2);
    assert.equal(s.database.calls + s.network.fetches, failPersistence ? 47 : 45);
  });
}

test("falha permanente de alerta sai do caminho e reenvio manual não repete análise", async (t) => {
  const s = setup(t); s.baselines();
  const bad = s.seed(0, "processed", false, null), good = s.seed(1);
  s.network.telegram = () => Response.json({ ok: false }, { status: 400 });
  await s.request("/api/run");
  assert.equal(s.row(bad).alert_dead_lettered_at, NOW);
  assert.equal(s.row(bad).alert_failure_count, 1);
  s.network.telegram = () => Response.json({ ok: true, result: { message_id: 8 } });
  await s.request("/api/run");
  assert.equal(s.row(good).alert_message_id, 8);
  assert.equal(s.row(bad).alert_attempt_count, 1);
  assert.equal((await s.request(`/api/items/${bad}/retry-delivery`, { kind: "alert" })).status, 200);
  await s.request("/api/run");
  assert.equal(s.row(bad).alert_sent_at, NOW);
  assert.equal(s.row(bad).status, "processed");
  assert.equal(s.row(bad).alert_failure_count, 0);
  assert.equal(s.row(bad).analysis_attempt_count, 0);
});

for (const kind of ["alert", "analysis"] as const) {
  test(`${kind}: backoff, retry_after, quinta falha e reenvio preservam os estados`, async (t) => {
    const s = setup(t); s.baselines();
    const id = s.seed(0, kind === "analysis" ? "ready" : "pending", kind === "analysis");
    s.network.telegram = () => Response.json({ ok: false, parameters: { retry_after: 3600 } }, { status: 429 });
    await s.request("/api/run");
    assert.equal(s.row(id)[`${kind}_next_retry_at`], "2026-09-05T13:00:00.000Z");
    // Outro ciclo não pode burlar a espera da pauta ou do alerta.
    const before = s.row(id)[`${kind}_attempt_count`];
    await s.request("/api/run");
    assert.equal(s.row(id)[`${kind}_attempt_count`], before);
    s.network.telegram = () => Response.json({ ok: false }, { status: 503 });
    for (const delay of [15, 60, 240]) {
      t.mock.timers.setTime(Date.parse(String(s.row(id)[`${kind}_next_retry_at`])));
      const now = Date.now();
      await s.request("/api/run");
      assert.equal(Date.parse(String(s.row(id)[`${kind}_next_retry_at`])) - now, delay * 60_000);
    }
    t.mock.timers.setTime(Date.parse(String(s.row(id)[`${kind}_next_retry_at`])));
    await s.request("/api/run");
    assert.equal(s.row(id)[`${kind}_failure_count`], 5);
    assert.ok(s.row(id)[`${kind}_dead_lettered_at`]);
    assert.equal(s.row(id)[`${kind}_next_retry_at`], null);
    const status = await (await s.request("/api/status", undefined, "GET")).json() as { deliveries: Record<string, number>; failedItems: Array<{ id: string }> };
    assert.equal(status.deliveries[`${kind}_quarantined`], 1);
    assert.ok(status.failedItems.some((item) => item.id === id));
    assert.equal((await s.request(`/api/items/${id}/retry-delivery`, { kind })).status, 200);
    s.network.telegram = () => Response.json({ ok: true, result: { message_id: 9 } });
    await s.request("/api/run");
    assert.equal(s.row(id)[`${kind}_message_id`], 9);
    assert.equal(s.row(id)[`${kind}_dead_lettered_at`], null);
    assert.equal(s.row(id)[`${kind}_failure_count`], 0);
  });
}

test("pauta inválida entra em quarentena sem impedir entrega posterior", async (t) => {
  const s = setup(t); s.baselines();
  const id = s.seed(0, "ready", true, "{inválido");
  const good = s.seed(1, "ready", true);
  await s.request("/api/run");
  assert.equal(s.row(id).analysis_dead_lettered_at, NOW);
  await s.request("/api/run");
  assert.equal(s.row(good).status, "processed");
  assert.equal(s.row(id).analysis_attempt_count, 1);
});

test("reenvio exige autenticação, tipo fechado, quarentena e ausência de lease ativo", async (t) => {
  const s = setup(t);
  const id = s.seed(0);
  const path = `/api/items/${id}/retry-delivery`;
  assert.equal((await s.request(path, { kind: "alert" }, "POST", "errado")).status, 401);
  assert.equal((await s.request(path, { kind: "alert; DROP TABLE items" })).status, 400);
  assert.equal((await s.request(path, { kind: "alert" })).status, 404);
  s.database.sqlite.prepare("UPDATE items SET alert_dead_lettered_at=?,alert_claim_token='ocupado',alert_claim_expires_at=?").run(NOW, "2026-09-05T13:00:00.000Z");
  assert.equal((await s.request(path, { kind: "alert" })).status, 404);
  assert.equal(s.row(id).alert_claim_token, "ocupado");
});

test("expiração de backlog não esgota orçamento da reserva e mantém exclusividade", async (t) => {
  const s = setup(t);
  for (let i = 0; i < 60; i++) s.seed(i, "processing");
  s.database.sqlite.prepare("UPDATE items SET claim_token='antigo',claim_expires_at='2026-09-04T12:00:00.000Z'").run();
  const response = await s.request("/api/items/claim");
  assert.equal(response.status, 200);
  assert.equal(s.database.calls, 23);
  assert.equal(s.database.sqlite.prepare("SELECT count(*) AS n FROM items WHERE retry_count=1").get()?.n, 20);
  const id = s.seed(100);
  const claims = await Promise.all(Array.from({ length: 3 }, () => s.request("/api/items/claim")));
  const items = (await Promise.all(claims.map((r) => r.json()))) as Array<{ items: Array<{ id: string }> }>;
  assert.deepEqual(items.flatMap((r) => r.items).map((item) => item.id), [id]);
});

test("migração de recuperação preserva dados legados e contadores de tentativas", () => {
  const s = sqliteDatabase(4);
  try {
    s.sqlite.prepare(`INSERT INTO items
      (id,source_id,source_name,title,url,discovered_at,status,analysis_json,alert_message_id,alert_attempt_count)
      VALUES('legado','audit','Auditoria','Título','https://supercell.com/en/news/legado/',?,'ready',?,123,12)`)
      .run(NOW, JSON.stringify(ANALYSIS));
    s.sqlite.exec(readFileSync(new URL("../migrations/0005_delivery_recovery.sql", import.meta.url), "utf8"));
    const row = s.sqlite.prepare("SELECT * FROM items WHERE id='legado'").get()!;
    assert.equal(row.status, "ready");
    assert.equal(row.analysis_json, JSON.stringify(ANALYSIS));
    assert.equal(row.alert_message_id, 123);
    assert.equal(row.alert_attempt_count, 12);
    assert.equal(row.alert_failure_count, 0);
    assert.equal(row.analysis_failure_count, 0);
    assert.equal(row.alert_dead_lettered_at, null);
  } finally { s.sqlite.close(); }
});

test("erro permanente sem JSON entra em quarentena sem registrar corpo externo", async (t) => {
  const s = setup(t); s.baselines();
  const id = s.seed(0);
  s.network.telegram = () => new Response("Conteúdo externo que não deve ser registrado", { status: 400 });
  await s.request("/api/run");
  assert.equal(s.row(id).alert_dead_lettered_at, NOW);
  assert.equal(s.row(id).alert_error, "Telegram HTTP 400");
});

test("falha de entrega não sobrescreve estado quando outro executor assume o lease", async (t) => {
  const s = setup(t); s.baselines();
  const id = s.seed(0);
  s.network.telegram = () => {
    s.database.sqlite.prepare("UPDATE items SET alert_claim_token='novo-executor',alert_error='preservar' WHERE id=?").run(id);
    return Response.json({ ok: false }, { status: 503 });
  };
  await s.request("/api/run");
  assert.equal(s.row(id).alert_failure_count, 0);
  assert.equal(s.row(id).alert_claim_token, "novo-executor");
  assert.equal(s.row(id).alert_error, "preservar");
});

test("redirecionamento do Telegram não encaminha a pauta nem amplia os fetches", async (t) => {
  const s = setup(t); s.baselines();
  const id = s.seed(0);
  s.network.telegram = () => new Response(null, { status: 302, headers: { Location: "https://destino-invalido.example/" } });
  await s.request("/api/run");
  assert.equal(s.network.fetches, 4);
  assert.equal(s.row(id).alert_sent_at, null);
  assert.equal(s.row(id).alert_failure_count, 1);
  assert.equal(s.row(id).alert_error, "Telegram HTTP 302");
});
