import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  formatAnalysisMessage,
  processingFailureState,
  type EditorialAnalysis,
} from "../src/index.ts";
import { fakeDatabase } from "./support/fake-d1.ts";

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
  estrategia_retencao: "Apresentar a mudança, explicar o impacto e encerrar com o que ainda falta confirmar.",
  experimento_crescimento: "Testar somente o gancho e comparar a retenção em 30 segundos com o histórico.",
  roteiro_curto: "Roteiro factual suficientemente longo para ser aceito pelo Worker. ".repeat(8),
  pontos_a_verificar: "Conferir a fonte oficial",
} satisfies EditorialAnalysis;

test("aplica backoff progressivo e envia a quinta falha para a fila de falhas", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  assert.deepEqual(processingFailureState(0, now), {
    retryCount: 1,
    nextRetryAt: "2026-08-30T12:05:00.000Z",
    deadLetteredAt: null,
  });
  assert.deepEqual(processingFailureState(3, now), {
    retryCount: 4,
    nextRetryAt: "2026-08-30T16:00:00.000Z",
    deadLetteredAt: null,
  });
  assert.deepEqual(processingFailureState(4, now), {
    retryCount: 5,
    nextRetryAt: null,
    deadLetteredAt: "2026-08-30T12:00:00.000Z",
  });
});

test("complete exige que a reserva ainda esteja dentro do prazo", async () => {
  const statements: { sql: string; bindings: unknown[] }[] = [];
  const db = fakeDatabase([{ changes: 0 }], statements);
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
  assert.equal(response.status, 409);
  assert.match(statements[0]?.sql ?? "", /claim_expires_at IS NOT NULL/);
  assert.match(statements[0]?.sql ?? "", /claim_expires_at >= \?5/);
});

test("complete rejeita pauta sem os campos de diferenciação", async () => {
  const statements: { sql: string; bindings: unknown[] }[] = [];
  const db = fakeDatabase([], statements);
  const { angulo_diferenciado: _removed, ...incompleteAnalysis } = VALID_ANALYSIS;
  const response = await worker.fetch(
    new Request(`https://radar.example/api/items/${ITEM_ID}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ claimToken: "claim", analysis: incompleteAnalysis }),
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  assert.equal(response.status, 400);
  assert.equal(statements.length, 0);
});

test("complete rejeita roteiro curto demais para a duração proposta", async () => {
  const statements: { sql: string; bindings: unknown[] }[] = [];
  const db = fakeDatabase([], statements);
  const response = await worker.fetch(
    new Request(`https://radar.example/api/items/${ITEM_ID}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        claimToken: "claim",
        analysis: { ...VALID_ANALYSIS, roteiro_curto: "Roteiro curto demais. ".repeat(10) },
      }),
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  assert.equal(response.status, 400);
  assert.equal(statements.length, 0);
});

test("claim inclui ângulos recentes válidos e ignora análise corrompida", async () => {
  const statements: { sql: string; bindings: unknown[] }[] = [];
  const db = fakeDatabase(
    [
      { results: [] },
      { changes: 1 },
      {
        results: [
          {
            id: ITEM_ID,
            source_id: "supercell-brawl-blog",
            source_name: "Supercell",
            title: "Nova notícia",
            url: "https://supercell.com/en/news/nova-noticia/",
            published_at: "2026-08-30T12:00:00.000Z",
            discovered_at: "2026-08-30T12:01:00.000Z",
            status: "processing",
            analysis_json: null,
          },
        ],
      },
      {
        results: [
          {
            title: "Vídeo anterior",
            analysis_json: JSON.stringify(VALID_ANALYSIS),
            processed_at: "2026-08-29T12:00:00.000Z",
          },
          {
            title: "Registro corrompido",
            analysis_json: "{json inválido",
            processed_at: "2026-08-28T12:00:00.000Z",
          },
        ],
      },
    ],
    statements,
  );
  const response = await worker.fetch(
    new Request("https://radar.example/api/items/claim?limit=1", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    items: unknown[];
    editorialHistory: Array<Record<string, unknown>>;
  };
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.editorialHistory, [
    {
      title: "Vídeo anterior",
      classification: "Comunicado",
      angle: VALID_ANALYSIS.angulo_diferenciado,
      processedAt: "2026-08-29T12:00:00.000Z",
    },
  ]);
  assert.match(statements[3]?.sql ?? "", /LIMIT 8/);
});

test("mensagem editorial mantém experimento, fonte e referência dentro do limite", () => {
  const longAnalysis: EditorialAnalysis = {
    ...VALID_ANALYSIS,
    resumo: VALID_ANALYSIS.resumo.repeat(30),
    publico_alvo: VALID_ANALYSIS.publico_alvo.repeat(30),
    angulo_diferenciado: VALID_ANALYSIS.angulo_diferenciado.repeat(30),
    gancho_abertura: VALID_ANALYSIS.gancho_abertura.repeat(30),
    titulos: VALID_ANALYSIS.titulos.map((title) => title.repeat(30)) as [
      string,
      string,
      string,
    ],
    conceito_thumbnail: VALID_ANALYSIS.conceito_thumbnail.repeat(30),
    estrategia_retencao: VALID_ANALYSIS.estrategia_retencao.repeat(30),
    experimento_crescimento: VALID_ANALYSIS.experimento_crescimento.repeat(30),
    roteiro_curto: VALID_ANALYSIS.roteiro_curto.repeat(30),
    pontos_a_verificar: VALID_ANALYSIS.pontos_a_verificar.repeat(30),
  };
  const message = formatAnalysisMessage(
    {
      id: ITEM_ID,
      source_id: "supercell-brawl-blog",
      source_name: "Supercell",
      title: "Notícia oficial ".repeat(30),
      url: "https://supercell.com/en/news/noticia-oficial/",
      published_at: null,
      discovered_at: "2026-08-30T12:00:00.000Z",
      status: "ready",
      analysis_json: null,
    },
    longAnalysis,
  );
  assert.ok(message.length <= 4_000);
  assert.match(message, /EXPERIMENTO DE CRESCIMENTO/);
  assert.match(message, /Fonte oficial: https:\/\/supercell\.com/);
  assert.match(message, new RegExp(`Referência: ${ITEM_ID.slice(0, 12)}`));
});

test("falha da memória editorial não perde a reserva da pauta", async () => {
  const statements: { sql: string; bindings: unknown[] }[] = [];
  const db = fakeDatabase(
    [
      { results: [] },
      { changes: 1 },
      {
        results: [
          {
            id: ITEM_ID,
            source_id: "supercell-brawl-blog",
            source_name: "Supercell",
            title: "Nova notícia",
            url: "https://supercell.com/en/news/nova-noticia/",
            published_at: null,
            discovered_at: "2026-08-30T12:01:00.000Z",
            status: "processing",
            analysis_json: null,
          },
        ],
      },
      { error: new Error("D1 temporariamente indisponível") },
    ],
    statements,
  );
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const response = await worker.fetch(
      new Request("https://radar.example/api/items/claim", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      { DB: db, SHARED_SECRET: SECRET },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      items: unknown[];
      editorialHistory: unknown[];
    };
    assert.equal(body.items.length, 1);
    assert.deepEqual(body.editorialHistory, []);
  } finally {
    console.error = originalError;
  }
});

test("dry-run libera sem incrementar retry_count", async () => {
  const statements: { sql: string; bindings: unknown[] }[] = [];
  const db = fakeDatabase([{ first: { retry_count: 2 } }, { changes: 1 }], statements);
  const response = await worker.fetch(
    new Request(`https://radar.example/api/items/${ITEM_ID}/release`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        claimToken: "claim",
        error: "Teste --dry-run",
        countFailure: false,
      }),
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.retryCount, 2);
  assert.equal(body.nextRetryAt, null);
  assert.equal(statements[1]?.bindings[0], 2);
  assert.equal(statements[1]?.bindings[1], null);
  assert.match(statements[1]?.sql ?? "", /claim_expires_at >= \?7/);
});

test("permite recolocar manualmente um item da fila de falhas", async () => {
  const statements: { sql: string; bindings: unknown[] }[] = [];
  const db = fakeDatabase([{ changes: 1 }], statements);
  const response = await worker.fetch(
    new Request(`https://radar.example/api/items/${ITEM_ID}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    { DB: db, SHARED_SECRET: SECRET },
  );
  assert.equal(response.status, 200);
  assert.match(statements[0]?.sql ?? "", /dead_lettered_at = NULL/);
});
