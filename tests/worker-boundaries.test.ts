import assert from "node:assert/strict";
import test from "node:test";
import worker, { type EditorialAnalysis, type StoredItem } from "../src/index.ts";
import {
  databaseBySql,
  fakeDatabase,
  type RecordedStatement,
} from "./support/fake-d1.ts";

const SECRET = "s".repeat(32);
const ITEM_ID = "a".repeat(64);

const VALID_ANALYSIS = {
  resumo: "Resumo factual suficientemente longo para passar pela validação do Worker.",
  classificacao: "Comunicado",
  prioridade: "Média",
  publico_alvo: "Jogadores de Brawl Stars interessados nas novidades oficiais.",
  angulo_diferenciado: "Explicar o impacto prático do comunicado sem repetir apenas o anúncio.",
  gancho_abertura: "A novidade oficial muda um ponto importante para quem acompanha o jogo.",
  titulos: ["Primeiro título", "Segundo título", "Terceiro título"],
  conceito_thumbnail: "Elemento oficial em destaque e o texto curto NOVA MUDANÇA.",
  estrategia_retencao: "Apresentar a mudança, explicar o impacto e encerrar com o que falta confirmar.",
  experimento_crescimento: "Testar somente o gancho e comparar a retenção com o histórico do canal.",
  roteiro_curto: "Roteiro factual suficientemente longo para ser aceito pelo Worker. ".repeat(8),
  pontos_a_verificar: "Conferir a fonte oficial",
} satisfies EditorialAnalysis;

const ALERT_ITEM: StoredItem = {
  id: ITEM_ID,
  source_id: "supercell-brawl-blog",
  source_name: "Supercell",
  title: "Nova publicação oficial",
  url: "https://supercell.com/en/news/nova-publicacao/",
  published_at: null,
  discovered_at: "2026-09-03T12:00:00.000Z",
  status: "pending",
  analysis_json: null,
  analysis_required: 1,
};

function responseAt(
  body: string,
  url: string,
  contentType: string,
  options: { status?: number; location?: string } = {},
): Response {
  const headers = new Headers({ "Content-Type": contentType });
  if (options.location) headers.set("Location", options.location);
  const response = new Response(body, { status: options.status ?? 200, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function validSourceResponse(url: string): Response {
  if (url.includes("youtube.com")) {
    return responseAt(
      `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
        <entry><yt:videoId>B38eWbSuSiM</yt:videoId><title>Vídeo um</title></entry>
        <entry><yt:videoId>AbCdEfGhI12</yt:videoId><title>Vídeo dois</title></entry>
      </feed>`,
      url,
      "application/atom+xml",
    );
  }
  if (url.includes("/announcement/")) {
    return responseAt(
      `<a href="/en/news/anuncio-um/">Anúncio um</a>
       <a href="/en/news/anuncio-dois/">Anúncio dois</a>`,
      url,
      "text/html; charset=utf-8",
    );
  }
  return responseAt(
    `<a href="/en/games/brawlstars/blog/news/noticia-um/">Notícia um</a>
     <a href="/en/games/brawlstars/blog/esports/noticia-dois/">Notícia dois</a>`,
    url,
    "text/html; charset=utf-8",
  );
}

test("health é público e envia cabeçalhos defensivos", async () => {
  const response = await worker.fetch(new Request("https://radar.example/health"), {
    DB: fakeDatabase([], []),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "radarNews",
    version: "1.3.0",
  });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'none'");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("rotas protegidas recusam segredo ausente, curto ou incorreto", async () => {
  const cases = [
    { configured: undefined, authorization: `Bearer ${SECRET}` },
    { configured: "curto", authorization: "Bearer curto" },
    { configured: SECRET, authorization: undefined },
    { configured: SECRET, authorization: `Bearer ${"x".repeat(32)}` },
  ];

  for (const current of cases) {
    const request = current.authorization
      ? new Request("https://radar.example/api/status", {
          headers: { Authorization: current.authorization },
        })
      : new Request("https://radar.example/api/status");
    const env = current.configured
      ? { DB: fakeDatabase([], []), SHARED_SECRET: current.configured }
      : { DB: fakeDatabase([], []) };
    const response = await worker.fetch(
      request,
      env,
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Não autorizado" });
  }
});

test("rota protegida desconhecida responde 404 sem consultar o banco", async () => {
  const statements: RecordedStatement[] = [];
  const response = await worker.fetch(
    new Request("https://radar.example/api/desconhecida", {
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: fakeDatabase([], statements), SHARED_SECRET: SECRET },
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Rota não encontrada" });
  assert.equal(statements.length, 0);
});

test("complete recusa JSON inválido ou maior que o limite antes do banco", async () => {
  const bodies = [
    "{",
    JSON.stringify({ value: "x".repeat(30_001) }),
    JSON.stringify({ value: "á".repeat(16_000) }),
  ];

  for (const body of bodies) {
    const statements: RecordedStatement[] = [];
    const response = await worker.fetch(
      new Request(`https://radar.example/api/items/${ITEM_ID}/complete`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SECRET}`,
          "Content-Type": "application/json",
        },
        body,
      }),
      { DB: fakeDatabase([], statements), SHARED_SECRET: SECRET },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "JSON inválido ou muito grande" });
    assert.equal(statements.length, 0);
  }
});

test("complete respeita Content-Length antes de ler o corpo", async () => {
  const statements: RecordedStatement[] = [];
  const response = await worker.fetch(
    new Request(`https://radar.example/api/items/${ITEM_ID}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
        "Content-Length": "30001",
      },
      body: "{}",
    }),
    { DB: fakeDatabase([], statements), SHARED_SECRET: SECRET },
  );

  assert.equal(response.status, 400);
  assert.equal(statements.length, 0);
});

test("complete cancela o stream ao ultrapassar o limite real de bytes", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(20_000));
      controller.enqueue(new Uint8Array(20_000));
    },
    cancel() {
      canceled = true;
    },
  });
  const statements: RecordedStatement[] = [];
  const response = await worker.fetch(
    new Request(
      `https://radar.example/api/items/${ITEM_ID}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SECRET}`,
          "Content-Type": "application/json",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    ),
    { DB: fakeDatabase([], statements), SHARED_SECRET: SECRET },
  );

  assert.equal(response.status, 400);
  assert.equal(canceled, true);
  assert.equal(statements.length, 0);
});

test("complete aceita análise e sinaliza entrega pendente quando o lease está ocupado", async () => {
  const statements: RecordedStatement[] = [];
  const db = fakeDatabase([{ changes: 1 }, { changes: 0 }], statements);
  const response = await worker.fetch(
    new Request(`https://radar.example/api/items/${ITEM_ID}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ claimToken: "claim", analysis: VALID_ANALYSIS }),
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    id: ITEM_ID,
    delivered: false,
    deliveryPending: true,
  });
  assert.match(statements[0]?.sql ?? "", /SET status = 'ready'/);
  assert.match(statements[1]?.sql ?? "", /SET analysis_claim_token/);
});

test("status consolida filas, entregas, metadados e falhas", async () => {
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results(sql) {
        if (sql.includes("GROUP BY CASE")) return [{ status: "pending", total: 2 }];
        if (sql.includes("key LIKE 'baseline:%'")) {
          return [{ key: "baseline:blog", value: "2026-09-03T12:00:00.000Z" }];
        }
        if (sql.includes("key LIKE 'monitor:%'")) {
          return [{ key: "monitor:last_result", value: "ok" }];
        }
        if (sql.includes("dead_lettered_at IS NOT NULL")) {
          return [{ id: ITEM_ID, title: "Falhou", retry_count: 5 }];
        }
        return [];
      },
      first(sql) {
        if (sql.includes("oldest_pending_at")) {
          return { pending: 2, waiting_retry: 1, failed: 1, oldest_pending_at: null };
        }
        if (sql.includes("alert_attempts")) {
          return { alert_attempts: 3, analysis_attempts: 2, alert_errors: 0 };
        }
        return null;
      },
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/status", {
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.deepEqual(body.counts, [{ status: "pending", total: 2 }]);
  assert.deepEqual(body.queue, {
    pending: 2,
    waiting_retry: 1,
    failed: 1,
    oldest_pending_at: null,
  });
  assert.deepEqual(body.deliveries, {
    alert_attempts: 3,
    analysis_attempts: 2,
    alert_errors: 0,
  });
  assert.equal(statements.length, 6);
});

test("erro inesperado do banco vira resposta 500 sem vazar detalhes", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const db = databaseBySql(
    { error: () => new Error("segredo interno do banco") },
    [],
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/status", {
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );

  assert.equal(response.status, 500);
  const raw = await response.text();
  assert.match(raw, /Erro interno/);
  assert.doesNotMatch(raw, /segredo interno/);
});

test("monitor cria linha de base para as três fontes oficiais", async (t) => {
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    fetched.push(url);
    return validSourceResponse(url);
  });
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    { changes: (sql) => (sql.includes("INSERT OR IGNORE INTO items") ? 1 : 0) },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as {
    ok: boolean;
    baselineStored: number;
    sources: Array<Record<string, unknown>>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.baselineStored, 6);
  assert.equal(body.sources.length, 3);
  assert.ok(body.sources.every((source) => source.baselineCreated === true));
  assert.equal(fetched.length, 3);
  const inserts = statements.filter((statement) =>
    statement.sql.includes("INSERT OR IGNORE INTO items"),
  );
  assert.equal(inserts.length, 6);
  assert.ok(inserts.every((statement) => statement.bindings[7] === "ignored"));
  assert.deepEqual(
    inserts.map((statement) => statement.bindings[8]),
    [1, 1, 1, 1, 0, 0],
  );
});

test("agendamento executa o monitor e registra o resultado", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const log = t.mock.method(console, "log", () => undefined);
  t.mock.method(globalThis, "fetch", async () =>
    new Response("indisponível", { status: 503 }),
  );

  await worker.scheduled(
    {} as ScheduledController,
    { DB: fakeDatabase([], []) },
    {} as ExecutionContext,
  );

  assert.equal(log.mock.callCount(), 1);
  assert.equal(log.mock.calls[0]?.arguments[0], "Execução agendada concluída");
  assert.equal((log.mock.calls[0]?.arguments[1] as { ok: boolean }).ok, false);
});

test("monitor insere novidades com o estado correto após a linha de base", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
    validSourceResponse(requestUrl(input)),
  );
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      first: (sql) => (sql.includes("SELECT value FROM metadata") ? { value: "ok" } : null),
      changes: (sql) => (sql.includes("INSERT OR IGNORE INTO items") ? 1 : 0),
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as {
    inserted: number;
    baselineStored: number;
    sources: Array<Record<string, unknown>>;
  };

  assert.equal(body.inserted, 6);
  assert.equal(body.baselineStored, 0);
  assert.ok(body.sources.every((source) => source.inserted === 2));
  const inserts = statements.filter((statement) =>
    statement.sql.includes("INSERT OR IGNORE INTO items"),
  );
  assert.deepEqual(
    inserts.map((statement) => statement.bindings[7]),
    ["pending", "pending", "pending", "pending", "processed", "processed"],
  );
  assert.ok(inserts.slice(0, 4).every((statement) => statement.bindings[9] === null));
  assert.ok(inserts.slice(4).every((statement) => typeof statement.bindings[9] === "string"));
});

test("monitor isola redirecionamento, MIME e formato inválidos por fonte", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes("/blog/")) {
      return responseAt("conteúdo", "https://evil.example/coleta", "text/html");
    }
    if (url.includes("/announcement/")) {
      return responseAt("{}", url, "application/json");
    }
    return responseAt(
      `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
        <entry><yt:videoId>B38eWbSuSiM</yt:videoId><title>Único vídeo</title></entry>
      </feed>`,
      url,
      "application/xml",
    );
  });

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: fakeDatabase([], []), SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as {
    ok: boolean;
    sources: Array<{ error: string }>;
  };

  assert.equal(body.ok, false);
  assert.match(body.sources[0]?.error ?? "", /domínio não autorizado/);
  assert.match(body.sources[1]?.error ?? "", /Tipo de conteúdo inesperado/);
  assert.match(body.sources[2]?.error ?? "", /Poucos artigos reconhecidos/);
});

test("monitor recusa salto intermediário para host não autorizado", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    fetched.push(url);
    if (url.includes("/blog/")) {
      return responseAt("", url, "text/html", {
        status: 302,
        location: "https://evil.example/coleta",
      });
    }
    return new Response("indisponível", { status: 503 });
  });

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: fakeDatabase([], []), SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as { sources: Array<{ error: string }> };

  assert.match(body.sources[0]?.error ?? "", /domínio não autorizado/);
  assert.ok(fetched.every((url) => !url.includes("evil.example")));
});

test("monitor segue redirecionamento relativo dentro do host oficial", async (t) => {
  const fetched: string[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    fetched.push(url);
    signals.push(init?.signal);
    if (url.endsWith("/blog/page/1/")) {
      return responseAt("", url, "text/html", {
        status: 302,
        location: "/en/games/brawlstars/blog/page/1/?redirected=1",
      });
    }
    return validSourceResponse(url);
  });
  const db = databaseBySql(
    { changes: (sql) => (sql.includes("INSERT OR IGNORE INTO items") ? 1 : 0) },
    [],
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as { ok: boolean; baselineStored: number };

  assert.equal(body.ok, true);
  assert.equal(body.baselineStored, 6);
  assert.equal(fetched.length, 4);
  assert.ok(fetched.some((url) => url.endsWith("?redirected=1")));
  const blogSignals = fetched
    .map((url, index) => ({ url, signal: signals[index] }))
    .filter(({ url }) => url.includes("/blog/"))
    .map(({ signal }) => signal);
  assert.equal(blogSignals.length, 2);
  assert.ok(blogSignals[0]);
  assert.equal(blogSignals[0], blogSignals[1]);
});

test("monitor limita redirecionamentos e cancela cada resposta intermediária", async (t) => {
  t.mock.method(console, "error", () => undefined);
  let blogRequests = 0;
  let canceled = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (!url.includes("/blog/")) return new Response("indisponível", { status: 503 });
    blogRequests += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        canceled += 1;
      },
    });
    const response = new Response(stream, {
      status: 302,
      headers: {
        "Content-Type": "text/html",
        Location: `/en/games/brawlstars/blog/page/1/?hop=${blogRequests}`,
      },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  });

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: fakeDatabase([], []), SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as { sources: Array<{ error: string }> };

  assert.match(body.sources[0]?.error ?? "", /limite de redirecionamentos/);
  assert.equal(blogRequests, 6);
  assert.equal(canceled, 6);
});

test("monitor rejeita Content-Length acima do limite antes de ler o corpo", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    const contentType = url.includes("youtube.com") ? "application/xml" : "text/html";
    const response = responseAt("não deve ser lido", url, contentType);
    response.headers.set("Content-Length", "1500001");
    return response;
  });

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: fakeDatabase([], []), SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as {
    ok: boolean;
    sources: Array<{ error: string }>;
  };

  assert.equal(body.ok, false);
  assert.ok(body.sources.every((source) => /excedeu o limite/.test(source.error)));
});

test("monitor cancela resposta transmitida acima do limite", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (!url.includes("/blog/")) return new Response("indisponível", { status: 503 });
    return responseAt("x".repeat(1_500_001), url, "text/html");
  });

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: fakeDatabase([], []), SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as {
    ok: boolean;
    sources: Array<{ error: string }>;
  };

  assert.equal(body.ok, false);
  assert.match(body.sources[0]?.error ?? "", /excedeu o limite/);
});

test("monitor envia alerta pelo Telegram e persiste o message id", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const telegramBodies: Array<Record<string, unknown>> = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("api.telegram.org")) {
        telegramBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 321 } }), {
          status: 200,
        });
      }
      return new Response("indisponível", { status: 503 });
    },
  );
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results(sql) {
        return sql.includes("status != 'ignored' AND alert_sent_at IS NULL")
          ? [ALERT_ITEM]
          : [];
      },
      changes(sql) {
        return sql.includes("SET alert_claim_token") ||
          sql.includes("SET alert_claim_expires_at = ?1") ||
          sql.includes("SET alert_sent_at")
          ? 1
          : 0;
      },
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    {
      DB: db,
      SHARED_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "token-de-teste",
      TELEGRAM_CHAT_ID: "123",
    },
  );
  const body = (await response.json()) as { alerts: Record<string, number> };

  assert.deepEqual(body.alerts, { sent: 1, failed: 0 });
  assert.equal(telegramBodies.length, 1);
  assert.equal(telegramBodies[0]?.chat_id, "123");
  assert.match(String(telegramBodies[0]?.text), /Nova publicação oficial/);
  const delivered = statements.find((statement) =>
    statement.sql.includes("alert_message_id = ?4"),
  );
  assert.equal(delivered?.bindings[3], 321);
  assert.match(delivered?.sql ?? "", /alert_claim_expires_at >= \?5/);
  assert.equal(typeof delivered?.bindings[4], "string");
});

test("alerta não é contabilizado quando a finalização perde o lease", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    return url.includes("api.telegram.org")
      ? new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }))
      : new Response("indisponível", { status: 503 });
  });
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results: (sql) =>
        sql.includes("status != 'ignored' AND alert_sent_at IS NULL") ? [ALERT_ITEM] : [],
      changes: (sql) =>
        sql.includes("SET alert_claim_token") ||
        sql.includes("SET alert_claim_expires_at = ?1")
          ? 1
          : 0,
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    {
      DB: db,
      SHARED_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "token-de-teste",
      TELEGRAM_CHAT_ID: "123",
    },
  );
  const body = (await response.json()) as { alerts: Record<string, number> };

  assert.deepEqual(body.alerts, { sent: 0, failed: 1 });
  assert.equal(
    statements.some((statement) => statement.sql.includes("SET alert_error = ?1")),
    false,
  );
  const finalization = statements.find((statement) =>
    statement.sql.includes("alert_message_id = ?4"),
  );
  assert.match(finalization?.sql ?? "", /alert_claim_expires_at >= \?5/);
});

test("alerta não chama o Telegram quando perde o lease antes do envio", async (t) => {
  t.mock.method(console, "error", () => undefined);
  let telegramCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes("api.telegram.org")) telegramCalls += 1;
    return new Response("indisponível", { status: 503 });
  });
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results: (sql) =>
        sql.includes("status != 'ignored' AND alert_sent_at IS NULL") ? [ALERT_ITEM] : [],
      changes: (sql) => (sql.includes("SET alert_claim_token") ? 1 : 0),
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    {
      DB: db,
      SHARED_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "token-de-teste",
      TELEGRAM_CHAT_ID: "123",
    },
  );
  const body = (await response.json()) as { alerts: Record<string, number> };

  assert.deepEqual(body.alerts, { sent: 0, failed: 1 });
  assert.equal(telegramCalls, 0);
  assert.equal(
    statements.some(
      (statement) =>
        statement.sql.includes("alert_message_id = ?4") ||
        statement.sql.includes("SET alert_error = ?1"),
    ),
    false,
  );
});

test("falha HTTP do Telegram libera o lease do alerta para nova tentativa", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    return url.includes("api.telegram.org")
      ? new Response("indisponível", { status: 502 })
      : new Response("indisponível", { status: 503 });
  });
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results: (sql) =>
        sql.includes("status != 'ignored' AND alert_sent_at IS NULL") ? [ALERT_ITEM] : [],
      changes: (sql) =>
        sql.includes("SET alert_claim_token") ||
        sql.includes("SET alert_claim_expires_at = ?1") ||
        sql.includes("SET alert_error = ?1")
          ? 1
          : 0,
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    {
      DB: db,
      SHARED_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "token-de-teste",
      TELEGRAM_CHAT_ID: "123",
    },
  );
  const body = (await response.json()) as { alerts: Record<string, number> };

  assert.deepEqual(body.alerts, { sent: 0, failed: 1 });
  const released = statements.find((statement) =>
    statement.sql.includes("SET alert_error = ?1"),
  );
  assert.match(String(released?.bindings[0]), /Telegram HTTP 502/);
  assert.match(released?.sql ?? "", /alert_claim_token = NULL/);
});

test("monitor entrega análise pronta e finaliza o item", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 654 } }));
    }
    return new Response("indisponível", { status: 503 });
  });
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results(sql) {
        if (sql.includes("status = 'ready' AND alert_sent_at IS NOT NULL")) {
          return [{ id: ITEM_ID }];
        }
        return [];
      },
      first(sql) {
        if (sql.includes("status = 'ready' AND analysis_claim_token = ?2")) {
          return {
            ...ALERT_ITEM,
            status: "ready",
            analysis_json: JSON.stringify(VALID_ANALYSIS),
          };
        }
        return null;
      },
      changes(sql) {
        return sql.includes("SET analysis_claim_token") ||
          sql.includes("SET analysis_claim_expires_at = ?1") ||
          sql.includes("analysis_message_id = ?4")
          ? 1
          : 0;
      },
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    {
      DB: db,
      SHARED_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "token-de-teste",
      TELEGRAM_CHAT_ID: "123",
    },
  );
  const body = (await response.json()) as { analyses: Record<string, number> };

  assert.deepEqual(body.analyses, { sent: 1, failed: 0, skipped: 0 });
  const delivered = statements.find((statement) =>
    statement.sql.includes("analysis_message_id = ?4"),
  );
  assert.equal(delivered?.bindings[3], 654);
  assert.match(delivered?.sql ?? "", /analysis_claim_expires_at >= \?5/);
  assert.equal(typeof delivered?.bindings[4], "string");
});

test("análise não é finalizada quando a persistência perde o lease", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    return url.includes("api.telegram.org")
      ? new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }))
      : new Response("indisponível", { status: 503 });
  });
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results: (sql) =>
        sql.includes("status = 'ready' AND alert_sent_at IS NOT NULL")
          ? [{ id: ITEM_ID }]
          : [],
      first: (sql) =>
        sql.includes("status = 'ready' AND analysis_claim_token = ?2")
          ? { ...ALERT_ITEM, status: "ready", analysis_json: JSON.stringify(VALID_ANALYSIS) }
          : null,
      changes: (sql) =>
        sql.includes("SET analysis_claim_token") ||
        sql.includes("SET analysis_claim_expires_at = ?1")
          ? 1
          : 0,
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    {
      DB: db,
      SHARED_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "token-de-teste",
      TELEGRAM_CHAT_ID: "123",
    },
  );
  const body = (await response.json()) as { analyses: Record<string, number> };

  assert.deepEqual(body.analyses, { sent: 0, failed: 1, skipped: 0 });
  assert.equal(
    statements.some((statement) => statement.sql.includes("SET last_error = ?1")),
    false,
  );
  const finalization = statements.find((statement) =>
    statement.sql.includes("analysis_message_id = ?4"),
  );
  assert.match(finalization?.sql ?? "", /analysis_claim_expires_at >= \?5/);
});

test("análise não chama o Telegram quando perde o lease antes do envio", async (t) => {
  t.mock.method(console, "error", () => undefined);
  let telegramCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes("api.telegram.org")) telegramCalls += 1;
    return new Response("indisponível", { status: 503 });
  });
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results: (sql) =>
        sql.includes("status = 'ready' AND alert_sent_at IS NOT NULL")
          ? [{ id: ITEM_ID }]
          : [],
      first: (sql) =>
        sql.includes("status = 'ready' AND analysis_claim_token = ?2")
          ? { ...ALERT_ITEM, status: "ready", analysis_json: JSON.stringify(VALID_ANALYSIS) }
          : null,
      changes: (sql) => (sql.includes("SET analysis_claim_token") ? 1 : 0),
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    {
      DB: db,
      SHARED_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "token-de-teste",
      TELEGRAM_CHAT_ID: "123",
    },
  );
  const body = (await response.json()) as { analyses: Record<string, number> };

  assert.deepEqual(body.analyses, { sent: 0, failed: 1, skipped: 0 });
  assert.equal(telegramCalls, 0);
  assert.equal(
    statements.some(
      (statement) =>
        statement.sql.includes("analysis_message_id = ?4") ||
        statement.sql.includes("SET last_error = ?1"),
    ),
    false,
  );
});

test("análise armazenada inválida libera o lease e permanece pronta", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async () =>
    new Response("indisponível", { status: 503 }),
  );
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results: (sql) =>
        sql.includes("status = 'ready' AND alert_sent_at IS NOT NULL")
          ? [{ id: ITEM_ID }]
          : [],
      first: (sql) =>
        sql.includes("status = 'ready' AND analysis_claim_token = ?2")
          ? { ...ALERT_ITEM, status: "ready", analysis_json: "{inválido" }
          : null,
      changes: (sql) =>
        sql.includes("SET analysis_claim_token") || sql.includes("SET last_error = ?1")
          ? 1
          : 0,
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    {
      DB: db,
      SHARED_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "token-de-teste",
      TELEGRAM_CHAT_ID: "123",
    },
  );
  const body = (await response.json()) as { analyses: Record<string, number> };

  assert.deepEqual(body.analyses, { sent: 0, failed: 1, skipped: 0 });
  const released = statements.find((statement) =>
    statement.sql.includes("SET last_error = ?1"),
  );
  assert.match(String(released?.bindings[0]), /JSON/);
  assert.match(released?.sql ?? "", /analysis_claim_token = NULL/);
});

test("item pronto ausente libera o lease com erro controlado", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async () =>
    new Response("indisponível", { status: 503 }),
  );
  const statements: RecordedStatement[] = [];
  const db = databaseBySql(
    {
      results: (sql) =>
        sql.includes("status = 'ready' AND alert_sent_at IS NOT NULL")
          ? [{ id: ITEM_ID }]
          : [],
      first: () => null,
      changes: (sql) =>
        sql.includes("SET analysis_claim_token") ||
        sql.includes("Análise armazenada ausente")
          ? 1
          : 0,
    },
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as { analyses: Record<string, number> };

  assert.deepEqual(body.analyses, { sent: 0, failed: 1, skipped: 0 });
  const released = statements.find((statement) =>
    statement.sql.includes("Análise armazenada ausente"),
  );
  assert.ok(released);
  assert.match(released.sql, /analysis_claim_token = NULL/);
});

test("claim expira reserva antiga e aplica backoff antes de reservar", async () => {
  const statements: RecordedStatement[] = [];
  const db = fakeDatabase(
    [
      { results: [{ id: ITEM_ID, claim_token: "antigo", retry_count: 1 }] },
      { changes: 1 },
      { changes: 0 },
      { results: [] },
    ],
    statements,
  );

  const response = await worker.fetch(
    new Request("https://radar.example/api/items/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  const body = (await response.json()) as { items: unknown[] };

  assert.equal(response.status, 200);
  assert.deepEqual(body.items, []);
  assert.equal(statements[1]?.bindings[0], 2);
  assert.equal(statements[1]?.bindings[3], ITEM_ID);
  assert.equal(statements[1]?.bindings[4], "antigo");
  assert.match(statements[1]?.sql ?? "", /reserva de processamento expirou/);
});
