import {
  ANALYSIS_RETENTION_DAYS,
  CLAIM_MINUTES,
  DELIVERY_LEASE_MINUTES,
  MAX_PROCESSING_RETRIES,
  MAX_CLAIM_ITEMS,
  MAX_SOURCE_HTML_BYTES,
  PROCESSING_RETRY_BACKOFF_MINUTES,
  SOURCE_FETCH_TIMEOUT_MS,
  SOURCES,
  USER_AGENT,
  type SourceDefinition,
} from "./config.ts";
import { parseSourceArchive } from "./source-parser.ts";

interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  SHARED_SECRET?: string;
}

interface NewsItem {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string | null;
  analysisRequired: boolean;
}

export interface StoredItem {
  id: string;
  source_id: string;
  source_name: string;
  title: string;
  url: string;
  published_at: string | null;
  discovered_at: string;
  status: string;
  analysis_json: string | null;
  retry_count?: number;
  next_retry_at?: string | null;
  dead_lettered_at?: string | null;
  analysis_required?: number;
}

export interface EditorialAnalysis {
  resumo: string;
  classificacao:
    | "Atualização"
    | "Evento"
    | "Esports"
    | "Parceria"
    | "Comunicado"
    | "Outro";
  prioridade: "Alta" | "Média" | "Baixa";
  publico_alvo: string;
  angulo_diferenciado: string;
  gancho_abertura: string;
  titulos: [string, string, string];
  conceito_thumbnail: string;
  estrategia_retencao: string;
  experimento_crescimento: string;
  roteiro_curto: string;
  pontos_a_verificar: string;
}

interface EditorialHistoryItem {
  title: string;
  classification: EditorialAnalysis["classificacao"];
  angle: string;
  processedAt: string;
}

interface SourceRunResult {
  source: SourceDefinition;
  items?: NewsItem[];
  error?: string;
}

const ANALYSIS_CATEGORIES = [
  "Atualização",
  "Evento",
  "Esports",
  "Parceria",
  "Comunicado",
  "Outro",
] as const;
const PRIORITIES = ["Alta", "Média", "Baixa"] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      console.error("Erro não tratado na requisição", error);
      return json({ error: "Erro interno. Consulte os logs do Worker." }, 500);
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const result = await runMonitor(env);
    console.log("Execução agendada concluída", result);
  },
};

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "radarNews", version: "1.3.0" });
  }

  if (!(await isAuthorized(request, env.SHARED_SECRET))) {
    return json({ error: "Não autorizado" }, 401);
  }

  if (request.method === "POST" && url.pathname === "/api/run") {
    return json(await runMonitor(env));
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    return statusResponse(env);
  }

  if (request.method === "POST" && url.pathname === "/api/items/claim") {
    return claimPendingItems(url, env);
  }

  const itemRoute = url.pathname.match(
    /^\/api\/items\/([a-f0-9]{64})\/(complete|release|retry)$/,
  );
  if (request.method === "POST" && itemRoute?.[1] && itemRoute[2]) {
    if (itemRoute[2] === "complete") {
      return completeItem(request, env, itemRoute[1]);
    }
    if (itemRoute[2] === "retry") {
      return retryItem(env, itemRoute[1]);
    }
    return releaseItem(request, env, itemRoute[1]);
  }

  return json({ error: "Rota não encontrada" }, 404);
}

async function runMonitor(env: Env): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  await recordMetadata(env, "monitor:last_started_at", startedAt);
  const collected = await Promise.all(
    SOURCES.map(async (source): Promise<SourceRunResult> => {
      try {
        return { source, items: await collectSource(source) };
      } catch (error) {
        const message = errorMessage(error);
        console.error(`Falha ao consultar ${source.name}: ${message}`);
        return { source, error: message };
      }
    }),
  );

  let inserted = 0;
  let baselineStored = 0;
  const sources: Record<string, unknown>[] = [];

  for (const result of collected) {
    if (!result.items) {
      await recordMetadata(
        env,
        `source:${result.source.id}:last_error`,
        `${new Date().toISOString()} ${result.error ?? "Erro desconhecido"}`.slice(0, 1_000),
      );
      sources.push({ id: result.source.id, ok: false, error: result.error });
      continue;
    }

    await recordMetadata(
      env,
      `source:${result.source.id}:last_success_at`,
      new Date().toISOString(),
    );

    const baselineKey = `baseline:${result.source.id}`;
    const initialized = await env.DB.prepare(
      "SELECT value FROM metadata WHERE key = ?1",
    )
      .bind(baselineKey)
      .first<{ value: string }>();

    if (!initialized) {
      for (const item of result.items) {
        if (await insertItem(env, item, "ignored")) baselineStored += 1;
      }
      await env.DB.prepare(
        "INSERT INTO metadata (key, value) VALUES (?1, ?2)",
      )
        .bind(baselineKey, new Date().toISOString())
        .run();
      sources.push({
        id: result.source.id,
        ok: true,
        baselineCreated: true,
        found: result.items.length,
      });
      continue;
    }

    let sourceInserted = 0;
    for (const item of result.items) {
      if (await insertItem(env, item, item.analysisRequired ? "pending" : "processed")) {
        sourceInserted += 1;
        inserted += 1;
      }
    }
    sources.push({
      id: result.source.id,
      ok: true,
      found: result.items.length,
      inserted: sourceInserted,
    });
  }

  const alerts = await deliverPendingAlerts(env);
  const analyses = await deliverReadyAnalyses(env);
  const retention = await pruneOldAnalysisPayloads(env);
  const ok = collected.some((result) => result.items !== undefined);
  const completedAt = new Date().toISOString();
  await recordMetadata(env, "monitor:last_completed_at", completedAt);
  await recordMetadata(env, "monitor:last_result", ok ? "ok" : "failed");

  return {
    ok,
    startedAt,
    completedAt,
    inserted,
    baselineStored,
    alerts,
    analyses,
    retention,
    sources,
  };
}

async function collectSource(source: SourceDefinition): Promise<NewsItem[]> {
  const response = await fetch(source.archiveUrl, {
    headers: {
      Accept:
        source.kind === "brawl-youtube"
          ? "application/atom+xml,application/xml,text/xml"
          : "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = response.headers.get("Content-Type") ?? "";
  const finalUrl = new URL(response.url);
  const expectedHostname =
    source.kind === "brawl-youtube" ? "www.youtube.com" : "supercell.com";
  if (
    finalUrl.protocol !== "https:" ||
    finalUrl.hostname !== expectedHostname ||
    (finalUrl.port !== "" && finalUrl.port !== "443") ||
    finalUrl.username !== "" ||
    finalUrl.password !== ""
  ) {
    throw new Error("A fonte redirecionou para um domínio não autorizado");
  }
  const normalizedContentType = contentType.toLowerCase();
  const validContentType =
    source.kind === "brawl-youtube"
      ? normalizedContentType.includes("xml")
      : normalizedContentType.includes("text/html");
  if (!validContentType) {
    throw new Error(`Tipo de conteúdo inesperado: ${contentType || "desconhecido"}`);
  }

  const parsed = parseSourceArchive(
    source,
    await readResponseTextWithLimit(response, MAX_SOURCE_HTML_BYTES),
  );
  if (parsed.length < 2) {
    throw new Error("Poucos artigos reconhecidos; a página pode ter mudado");
  }

  return Promise.all(
    parsed.map(async (item) => ({
      id: await sha256(item.url),
      sourceId: source.id,
      sourceName: source.name,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      analysisRequired: source.processing === "analysis",
    })),
  );
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`A fonte excedeu o limite de ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("Resposta maior que o limite permitido");
      throw new Error(`A fonte excedeu o limite de ${maxBytes} bytes`);
    }
    chunks.push(part.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function insertItem(
  env: Env,
  item: NewsItem,
  status: "ignored" | "pending" | "processed",
): Promise<boolean> {
  const discoveredAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO items
      (id, source_id, source_name, title, url, published_at, discovered_at, status,
       analysis_required, processed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      item.id,
      item.sourceId,
      item.sourceName,
      item.title,
      item.url,
      item.publishedAt,
      discoveredAt,
      status,
      item.analysisRequired ? 1 : 0,
      status === "processed" ? discoveredAt : null,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function deliverPendingAlerts(
  env: Env,
): Promise<{ sent: number; failed: number }> {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, source_id, source_name, title, url, published_at,
            discovered_at, status, analysis_json, analysis_required
     FROM items
     WHERE status != 'ignored' AND alert_sent_at IS NULL
       AND (
         alert_claim_token IS NULL
         OR alert_claim_expires_at IS NULL
         OR alert_claim_expires_at < ?1
       )
     ORDER BY discovered_at ASC
     LIMIT 20`,
  )
    .bind(now)
    .all<StoredItem>();

  let sent = 0;
  let failed = 0;
  for (const item of rows.results ?? []) {
    const claimToken = crypto.randomUUID();
    const claimExpiresAt = deliveryLeaseExpiration();
    const claimed = await env.DB.prepare(
      `UPDATE items
       SET alert_claim_token = ?1, alert_claim_expires_at = ?2,
           alert_attempt_count = alert_attempt_count + 1,
           alert_last_attempt_at = ?4
       WHERE id = ?3 AND status != 'ignored' AND alert_sent_at IS NULL
         AND (
           alert_claim_token IS NULL
           OR alert_claim_expires_at IS NULL
           OR alert_claim_expires_at < ?4
         )`,
    )
      .bind(claimToken, claimExpiresAt, item.id, new Date().toISOString())
      .run();
    if ((claimed.meta.changes ?? 0) === 0) continue;

    try {
      const messageId = await sendTelegram(
        env,
        [
          "🚨 Nova publicação oficial encontrada",
          "",
          `Fonte: ${item.source_name}`,
          `Título: ${item.title}`,
          "",
          item.url,
          "",
          item.analysis_required === 0
            ? "Conteúdo do canal social oficial; este item gera somente alerta."
            : "A pauta em português será enviada quando o processador local estiver ligado.",
          `Referência: ${item.id.slice(0, 12)}`,
        ].join("\n"),
      );
      await env.DB.prepare(
        `UPDATE items
         SET alert_sent_at = ?1, alert_error = NULL,
             alert_claim_token = NULL, alert_claim_expires_at = NULL,
             alert_message_id = ?4
         WHERE id = ?2 AND alert_claim_token = ?3`,
      )
        .bind(new Date().toISOString(), item.id, claimToken, messageId)
        .run();
      sent += 1;
    } catch (error) {
      failed += 1;
      const message = errorMessage(error).slice(0, 500);
      console.error(`Falha no alerta do item ${item.id}: ${message}`);
      await env.DB.prepare(
        `UPDATE items
         SET alert_error = ?1, alert_claim_token = NULL,
             alert_claim_expires_at = NULL
         WHERE id = ?2 AND alert_claim_token = ?3`,
      )
        .bind(message, item.id, claimToken)
        .run();
    }
  }
  return { sent, failed };
}

async function claimPendingItems(url: URL, env: Env): Promise<Response> {
  const requested = Number(url.searchParams.get("limit") ?? String(MAX_CLAIM_ITEMS));
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_CLAIM_ITEMS)
    : MAX_CLAIM_ITEMS;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLAIM_MINUTES * 60_000).toISOString();
  const claimToken = crypto.randomUUID();

  await expireStaleProcessingClaims(env, now.toISOString());

  await env.DB.prepare(
    `UPDATE items
     SET status = 'processing', claim_token = ?1, claim_expires_at = ?2,
          last_error = NULL
     WHERE id IN (
       SELECT id FROM items
       WHERE status = 'pending' AND analysis_required = 1 AND dead_lettered_at IS NULL
         AND (next_retry_at IS NULL OR next_retry_at <= ?3)
       ORDER BY retry_count ASC, discovered_at ASC
       LIMIT ?4
     )
     AND status = 'pending' AND analysis_required = 1 AND dead_lettered_at IS NULL
     AND (next_retry_at IS NULL OR next_retry_at <= ?3)`,
  )
    .bind(claimToken, expiresAt, now.toISOString(), limit)
    .run();

  const claimed = await env.DB.prepare(
    `SELECT id, source_id, source_name, title, url, published_at,
            discovered_at, status, analysis_json
     FROM items
     WHERE claim_token = ?1 AND status = 'processing'
     ORDER BY discovered_at ASC`,
  )
    .bind(claimToken)
    .all<StoredItem>();

  const items = (claimed.results ?? []).map(publicItem);
  let editorialHistory: EditorialHistoryItem[] = [];
  if (items.length > 0) {
    try {
      editorialHistory = await recentEditorialHistory(env);
    } catch (error) {
      console.error(`Não foi possível carregar a memória editorial: ${errorMessage(error)}`);
    }
  }

  return json({
    claimToken,
    expiresAt,
    items,
    editorialHistory,
  });
}

async function recentEditorialHistory(env: Env): Promise<EditorialHistoryItem[]> {
  const recent = await env.DB.prepare(
    `SELECT title, analysis_json, processed_at
     FROM items
     WHERE status = 'processed' AND analysis_json IS NOT NULL
       AND processed_at IS NOT NULL
     ORDER BY processed_at DESC
     LIMIT 8`,
  ).all<{ title: string; analysis_json: string; processed_at: string }>();

  const history: EditorialHistoryItem[] = [];
  for (const row of recent.results ?? []) {
    try {
      const analysis = parseAnalysis(JSON.parse(row.analysis_json), true);
      if (!analysis) continue;
      history.push({
        title: clampText(row.title, 180),
        classification: analysis.classificacao,
        angle: clampText(analysis.angulo_diferenciado, 280),
        processedAt: row.processed_at,
      });
    } catch {
      // Uma análise antiga corrompida não pode impedir a próxima reserva.
    }
  }
  return history;
}

async function completeItem(
  request: Request,
  env: Env,
  itemId: string,
): Promise<Response> {
  const payload = await readJsonBody(request);
  if (!payload) return json({ error: "JSON inválido ou muito grande" }, 400);

  const claimToken = stringValue(payload.claimToken);
  const analysis = parseAnalysis(payload.analysis);
  if (!claimToken || !analysis) {
    return json(
      { error: "Informe claimToken e uma análise completa no formato esperado" },
      400,
    );
  }

  const update = await env.DB.prepare(
    `UPDATE items
     SET status = 'ready', analysis_json = ?1, analysis_ready_at = ?2,
          claim_token = NULL, claim_expires_at = NULL, last_error = NULL,
          next_retry_at = NULL, dead_lettered_at = NULL
     WHERE id = ?3 AND status = 'processing' AND claim_token = ?4
       AND claim_expires_at IS NOT NULL AND claim_expires_at >= ?5`,
  )
    .bind(
      JSON.stringify(analysis),
      new Date().toISOString(),
      itemId,
      claimToken,
      new Date().toISOString(),
    )
    .run();

  if ((update.meta.changes ?? 0) === 0) {
    return json({ error: "Reserva expirada, inválida ou já concluída" }, 409);
  }

  const delivery = await deliverReadyItem(env, itemId);
  const delivered = delivery === "sent";
  return json(
    delivered
      ? { ok: true, id: itemId, delivered: true }
      : { ok: true, id: itemId, delivered: false, deliveryPending: true },
    delivered ? 200 : 202,
  );
}

async function releaseItem(
  request: Request,
  env: Env,
  itemId: string,
): Promise<Response> {
  const payload = await readJsonBody(request);
  if (!payload) return json({ error: "JSON inválido ou muito grande" }, 400);
  const claimToken = stringValue(payload.claimToken);
  if (!claimToken) return json({ error: "claimToken ausente" }, 400);
  const lastError = clampText(stringValue(payload.error) || "Falha local", 500);
  const countFailure = payload.countFailure !== false;
  const now = new Date();

  const state = await env.DB.prepare(
    `SELECT retry_count FROM items
     WHERE id = ?1 AND status = 'processing' AND claim_token = ?2
       AND claim_expires_at IS NOT NULL AND claim_expires_at >= ?3`,
  )
    .bind(itemId, claimToken, now.toISOString())
    .first<{ retry_count: number }>();
  if (!state) {
    return json({ error: "Reserva expirada, inválida ou já liberada" }, 409);
  }

  const failure = countFailure
    ? processingFailureState(state.retry_count, now)
    : { retryCount: state.retry_count, nextRetryAt: null, deadLetteredAt: null };
  const result = await env.DB.prepare(
    `UPDATE items
     SET status = 'pending', claim_token = NULL, claim_expires_at = NULL,
         retry_count = ?1, last_error = ?2, next_retry_at = ?3,
         dead_lettered_at = ?4
     WHERE id = ?5 AND status = 'processing' AND claim_token = ?6
       AND claim_expires_at IS NOT NULL AND claim_expires_at >= ?7`,
  )
    .bind(
      failure.retryCount,
      countFailure ? lastError : null,
      failure.nextRetryAt,
      failure.deadLetteredAt,
      itemId,
      claimToken,
      new Date().toISOString(),
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return json({ error: "A reserva mudou durante a liberação" }, 409);
  }
  return json({
    ok: true,
    released: true,
    retryCount: failure.retryCount,
    nextRetryAt: failure.nextRetryAt,
    deadLettered: failure.deadLetteredAt !== null,
  });
}

async function retryItem(env: Env, itemId: string): Promise<Response> {
  const result = await env.DB.prepare(
    `UPDATE items
     SET status = 'pending', retry_count = 0, last_error = NULL,
         next_retry_at = NULL, dead_lettered_at = NULL,
         claim_token = NULL, claim_expires_at = NULL
     WHERE id = ?1 AND dead_lettered_at IS NOT NULL`,
  )
    .bind(itemId)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return json({ error: "Item não encontrado na fila de falhas" }, 404);
  }
  return json({ ok: true, id: itemId, queued: true });
}

interface ProcessingFailureState {
  retryCount: number;
  nextRetryAt: string | null;
  deadLetteredAt: string | null;
}

export function processingFailureState(
  currentRetryCount: number,
  now = new Date(),
): ProcessingFailureState {
  const retryCount = Math.max(0, Math.trunc(currentRetryCount)) + 1;
  if (retryCount >= MAX_PROCESSING_RETRIES) {
    return {
      retryCount,
      nextRetryAt: null,
      deadLetteredAt: now.toISOString(),
    };
  }
  const backoffIndex = Math.min(
    retryCount - 1,
    PROCESSING_RETRY_BACKOFF_MINUTES.length - 1,
  );
  const delayMinutes = PROCESSING_RETRY_BACKOFF_MINUTES[backoffIndex]!;
  return {
    retryCount,
    nextRetryAt: new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
    deadLetteredAt: null,
  };
}

async function expireStaleProcessingClaims(env: Env, now: string): Promise<number> {
  const stale = await env.DB.prepare(
    `SELECT id, claim_token, retry_count FROM items
     WHERE status = 'processing'
       AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at < ?1)
     ORDER BY claim_expires_at ASC
     LIMIT 50`,
  )
    .bind(now)
    .all<{ id: string; claim_token: string | null; retry_count: number }>();
  let expired = 0;
  for (const item of stale.results ?? []) {
    const failure = processingFailureState(item.retry_count, new Date(now));
    const result = await env.DB.prepare(
      `UPDATE items
       SET status = 'pending', claim_token = NULL, claim_expires_at = NULL,
           retry_count = ?1, last_error = 'A reserva de processamento expirou',
           next_retry_at = ?2, dead_lettered_at = ?3
       WHERE id = ?4 AND status = 'processing'
         AND (claim_token = ?5 OR (?5 IS NULL AND claim_token IS NULL))
         AND (claim_expires_at IS NULL OR claim_expires_at < ?6)`,
    )
      .bind(
        failure.retryCount,
        failure.nextRetryAt,
        failure.deadLetteredAt,
        item.id,
        item.claim_token,
        now,
      )
      .run();
    expired += result.meta.changes ?? 0;
  }
  return expired;
}

async function deliverReadyAnalyses(
  env: Env,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT id FROM items
     WHERE status = 'ready' AND alert_sent_at IS NOT NULL
       AND (
         analysis_claim_token IS NULL
         OR analysis_claim_expires_at IS NULL
         OR analysis_claim_expires_at < ?1
       )
     ORDER BY analysis_ready_at ASC
     LIMIT 10`,
  )
    .bind(now)
    .all<{ id: string }>();
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows.results ?? []) {
    const result = await deliverReadyItem(env, row.id);
    if (result === "sent") sent += 1;
    else if (result === "failed") failed += 1;
    else skipped += 1;
  }
  return { sent, failed, skipped };
}

async function deliverReadyItem(
  env: Env,
  itemId: string,
): Promise<"sent" | "failed" | "skipped"> {
  const claimToken = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE items
     SET analysis_claim_token = ?1, analysis_claim_expires_at = ?2,
         analysis_attempt_count = analysis_attempt_count + 1,
         analysis_last_attempt_at = ?4
     WHERE id = ?3 AND status = 'ready' AND alert_sent_at IS NOT NULL
       AND (
         analysis_claim_token IS NULL
         OR analysis_claim_expires_at IS NULL
         OR analysis_claim_expires_at < ?4
       )`,
  )
    .bind(
      claimToken,
      deliveryLeaseExpiration(),
      itemId,
      new Date().toISOString(),
    )
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return "skipped";

  const item = await env.DB.prepare(
    `SELECT id, source_id, source_name, title, url, published_at,
            discovered_at, status, analysis_json
     FROM items
     WHERE id = ?1 AND status = 'ready' AND analysis_claim_token = ?2`,
  )
    .bind(itemId, claimToken)
    .first<StoredItem>();
  if (!item?.analysis_json) {
    await env.DB.prepare(
      `UPDATE items
       SET last_error = 'Análise armazenada ausente', analysis_claim_token = NULL,
           analysis_claim_expires_at = NULL
       WHERE id = ?1 AND analysis_claim_token = ?2`,
    )
      .bind(itemId, claimToken)
      .run();
    return "failed";
  }

  try {
    const analysis = parseAnalysis(JSON.parse(item.analysis_json), true);
    if (!analysis) throw new Error("Análise armazenada em formato inválido");
    const messageId = await sendTelegram(env, formatAnalysisMessage(item, analysis));
    await env.DB.prepare(
      `UPDATE items
       SET status = 'processed', processed_at = ?1, last_error = NULL,
           analysis_claim_token = NULL, analysis_claim_expires_at = NULL,
           analysis_message_id = ?4
       WHERE id = ?2 AND status = 'ready' AND analysis_claim_token = ?3`,
    )
      .bind(new Date().toISOString(), itemId, claimToken, messageId)
      .run();
    return "sent";
  } catch (error) {
    const message = errorMessage(error).slice(0, 500);
    console.error(`Falha ao entregar pauta ${itemId}: ${message}`);
    await env.DB.prepare(
      `UPDATE items
       SET last_error = ?1, analysis_claim_token = NULL,
           analysis_claim_expires_at = NULL
       WHERE id = ?2 AND status = 'ready' AND analysis_claim_token = ?3`,
    )
      .bind(message, itemId, claimToken)
      .run();
    return "failed";
  }
}

function deliveryLeaseExpiration(): string {
  return new Date(Date.now() + DELIVERY_LEASE_MINUTES * 60_000).toISOString();
}

export function formatAnalysisMessage(item: StoredItem, analysis: EditorialAnalysis): string {
  const titleKinds = ["Pesquisável", "Intrigante", "Equilibrado"];
  const titles = analysis.titulos
    .map((title, index) => `${index + 1}. ${titleKinds[index]}: ${clampText(title, 110)}`)
    .join("\n");
  return [
    "🧠 Pauta criada pela IA local",
    "",
    clampText(item.title, 180),
    "",
    `Classificação: ${analysis.classificacao}`,
    `Prioridade: ${analysis.prioridade}`,
    "",
    "PÚBLICO-ALVO",
    clampText(analysis.publico_alvo, 140),
    "",
    "RESUMO",
    clampText(analysis.resumo, 450),
    "",
    "ÂNGULO DIFERENCIADO",
    clampText(analysis.angulo_diferenciado, 280),
    "",
    "GANCHO DE ABERTURA",
    clampText(analysis.gancho_abertura, 180),
    "",
    "IDEIAS DE TÍTULO",
    titles,
    "",
    "CONCEITO DE THUMBNAIL",
    clampText(analysis.conceito_thumbnail, 180),
    "",
    "ESTRATÉGIA DE RETENÇÃO",
    clampText(analysis.estrategia_retencao, 260),
    "",
    "EXPERIMENTO DE CRESCIMENTO",
    clampText(analysis.experimento_crescimento, 220),
    "",
    "ROTEIRO CURTO",
    clampText(analysis.roteiro_curto, 900),
    "",
    "O QUE VERIFICAR",
    clampText(analysis.pontos_a_verificar, 140),
    "",
    `Fonte oficial: ${clampText(item.url, 200)}`,
    `Referência: ${item.id.slice(0, 12)}`,
  ]
    .join("\n")
    .slice(0, 4_000);
}

async function sendTelegram(env: Env, message: string): Promise<number | null> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurado");
  }

  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        chat_id: chatId,
        text: message.slice(0, 4_000),
        disable_web_page_preview: true,
      }),
    });
  } catch {
    throw new Error("Não foi possível conectar à API do Telegram");
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("O Telegram devolveu uma resposta JSON inválida");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("O Telegram devolveu uma resposta inesperada");
  }
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) throw new Error("O Telegram não confirmou o envio");
  const result = body.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const messageId = (result as Record<string, unknown>).message_id;
  return typeof messageId === "number" && Number.isSafeInteger(messageId)
    ? messageId
    : null;
}

async function statusResponse(env: Env): Promise<Response> {
  const [counts, baselines, operations, queue, deliveries, failedItems] = await Promise.all([
    env.DB.prepare(
      `SELECT CASE WHEN dead_lettered_at IS NOT NULL THEN 'failed' ELSE status END AS status,
              COUNT(*) AS total
       FROM items
       GROUP BY CASE WHEN dead_lettered_at IS NOT NULL THEN 'failed' ELSE status END
       ORDER BY status`,
    ).all<{ status: string; total: number }>(),
    env.DB.prepare(
      "SELECT key, value FROM metadata WHERE key LIKE 'baseline:%' ORDER BY key",
    ).all<{ key: string; value: string }>(),
    env.DB.prepare(
      `SELECT key, value FROM metadata
       WHERE key LIKE 'monitor:%' OR key LIKE 'source:%'
       ORDER BY key`,
    ).all<{ key: string; value: string }>(),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' AND dead_lettered_at IS NULL THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN next_retry_at IS NOT NULL AND dead_lettered_at IS NULL THEN 1 ELSE 0 END) AS waiting_retry,
         SUM(CASE WHEN dead_lettered_at IS NOT NULL THEN 1 ELSE 0 END) AS failed,
         MIN(CASE WHEN status = 'pending' AND dead_lettered_at IS NULL THEN discovered_at END) AS oldest_pending_at
       FROM items`,
    ).first<Record<string, number | string | null>>(),
    env.DB.prepare(
      `SELECT
         SUM(alert_attempt_count) AS alert_attempts,
         SUM(analysis_attempt_count) AS analysis_attempts,
         SUM(CASE WHEN alert_error IS NOT NULL AND alert_sent_at IS NULL THEN 1 ELSE 0 END) AS alert_errors,
         SUM(CASE WHEN status = 'ready' AND last_error IS NOT NULL THEN 1 ELSE 0 END) AS analysis_errors
       FROM items`,
    ).first<Record<string, number | null>>(),
    env.DB.prepare(
      `SELECT id, title, url, retry_count, last_error, dead_lettered_at
       FROM items WHERE dead_lettered_at IS NOT NULL
       ORDER BY dead_lettered_at DESC LIMIT 20`,
    ).all<{
      id: string;
      title: string;
      url: string;
      retry_count: number;
      last_error: string | null;
      dead_lettered_at: string;
    }>(),
  ]);
  return json({
    ok: true,
    counts: counts.results ?? [],
    queue: queue ?? {},
    deliveries: deliveries ?? {},
    failedItems: failedItems.results ?? [],
    baselines: baselines.results ?? [],
    operations: operations.results ?? [],
  });
}

async function recordMetadata(env: Env, key: string, value: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO metadata (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
      .bind(key, value)
      .run();
  } catch (error) {
    console.error(`Falha ao registrar metadado ${key}: ${errorMessage(error)}`);
  }
}

async function pruneOldAnalysisPayloads(env: Env): Promise<{ pruned: number }> {
  const cutoff = new Date(
    Date.now() - ANALYSIS_RETENTION_DAYS * 24 * 60 * 60_000,
  ).toISOString();
  const result = await env.DB.prepare(
    `UPDATE items SET analysis_json = NULL
     WHERE status = 'processed' AND processed_at < ?1 AND analysis_json IS NOT NULL`,
  )
    .bind(cutoff)
    .run();
  return { pruned: result.meta.changes ?? 0 };
}

function parseAnalysis(value: unknown, allowLegacy = false): EditorialAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const resumo = stringValue(input.resumo);
  const classificacao = stringValue(input.classificacao);
  const prioridade = stringValue(input.prioridade);
  const publicoAlvo = stringValue(input.publico_alvo) ||
    (allowLegacy ? "Público não definido nesta pauta criada pela versão anterior." : "");
  const angulo = stringValue(input.angulo_diferenciado) ||
    (allowLegacy ? "Escolha um recorte próprio antes de publicar esta pauta legada." : "");
  const gancho = stringValue(input.gancho_abertura) ||
    (allowLegacy ? "Reescreva a abertura para entregar imediatamente a promessa do título." : "");
  const thumbnail = stringValue(input.conceito_thumbnail) ||
    (allowLegacy ? "Crie uma imagem simples, precisa e coerente com o título escolhido." : "");
  const retencao = stringValue(input.estrategia_retencao) ||
    (allowLegacy ? "Antecipe o ponto mais forte e revise a retenção depois da publicação." : "");
  const experimento = stringValue(input.experimento_crescimento) ||
    (allowLegacy
      ? "Use esta pauta como linha de base e teste apenas uma variável por publicação."
      : "");
  const roteiro = stringValue(input.roteiro_curto);
  const verificacao = stringValue(input.pontos_a_verificar);
  const titles = Array.isArray(input.titulos)
    ? input.titulos.map(stringValue).filter(Boolean)
    : [];

  if (
    resumo.length < 40 ||
    !ANALYSIS_CATEGORIES.includes(
      classificacao as (typeof ANALYSIS_CATEGORIES)[number],
    ) ||
    !PRIORITIES.includes(prioridade as (typeof PRIORITIES)[number]) ||
    publicoAlvo.length < 12 ||
    angulo.length < 30 ||
    gancho.length < 30 ||
    titles.length !== 3 ||
    titles.some((title) => title.length < 5) ||
    thumbnail.length < 15 ||
    retencao.length < 30 ||
    experimento.length < 30 ||
    roteiro.length < 80 ||
    roteiro.split(/\s+/).length < 65 ||
    roteiro.split(/\s+/).length > 160 ||
    verificacao.length < 2
  ) {
    return null;
  }

  return {
    resumo: clampText(resumo, 2_000),
    classificacao: classificacao as EditorialAnalysis["classificacao"],
    prioridade: prioridade as EditorialAnalysis["prioridade"],
    publico_alvo: clampText(publicoAlvo, 500),
    angulo_diferenciado: clampText(angulo, 1_000),
    gancho_abertura: clampText(gancho, 700),
    titulos: titles.map((title) => clampText(title, 220)) as [string, string, string],
    conceito_thumbnail: clampText(thumbnail, 700),
    estrategia_retencao: clampText(retencao, 1_000),
    experimento_crescimento: clampText(experimento, 700),
    roteiro_curto: clampText(roteiro, 3_000),
    pontos_a_verificar: clampText(verificacao, 1_000),
  };
}

async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > 30_000) return null;
  try {
    const raw = await request.text();
    if (raw.length > 30_000) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function isAuthorized(request: Request, secret?: string): Promise<boolean> {
  const expected = secret?.trim();
  if (!expected || expected.length < 24) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  const [expectedHash, suppliedHash] = await Promise.all([
    sha256Bytes(expected),
    sha256Bytes(supplied),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedHash.length; index += 1) {
    difference |= expectedHash[index]! ^ suppliedHash[index]!;
  }
  return difference === 0;
}

function publicItem(item: StoredItem): Record<string, unknown> {
  return {
    id: item.id,
    source: item.source_name,
    title: item.title,
    url: item.url,
    publishedAt: item.published_at,
    discoveredAt: item.discovered_at,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampText(value: string, max: number): string {
  const clean = value.replace(/\u0000/g, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256(value: string): Promise<string> {
  const digest = await sha256Bytes(value);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
