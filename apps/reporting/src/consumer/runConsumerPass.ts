import type { Pool } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { readCursor, advanceCursor } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

// am: refund.succeeded not here yet. when refunds ship just add it to the list
export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.batch_closed",
  "refund.succeeded",
];

/**
 * Keys this worker's row in reporting_outbox_cursor. Two processes using the
 * same name serialize on that row, so a catch-up run beside a live worker
 * cannot apply an event twice.
 */
export const CONSUMER_NAME = "reporting";

/**
 * The one function both the NOTIFY handler and the poll timer call.
 * Everything — the read of due outbox_events, every rollup
 * upsert `applyEvent` performs, and the watermark advance — happens inside
 * one `withTransaction` call: either the whole batch of up-to-
 * `consumerBatchLimit` events is applied *and* the watermark moves past all
 * of them, atomically, or (on any error) nothing in this pass is applied
 * and the watermark is untouched — the next pass simply re-selects the
 * identical event range and retries. This is the exact property that makes
 * the watermark alone sufficient for exactly-once application, with no
 * separate per-event dedup table the way webhook_deliveries needs one.
 *
 * The `SELECT` below is a plain, unlocked read — no row lock, no
 * `FOR UPDATE`, no mutation of any outbox_events column — identical
 * posture to webhooks/dispatcher.ts's Step A.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
  options: { isolateFailures?: boolean } = {},
): Promise<{ processedCount: number; deadLetteredCount?: number }> {
  if (options.isolateFailures) {
    return runIsolatingPass(pool, config);
  }
  return withTransaction(pool, async (client) => {
    const cursor = await readCursor(client, CONSUMER_NAME);

    // MK 2026-06: ids come from a sequence, they're monotonic. fine for now.
    const eventsResult = await client.query<OutboxEventRow>(
      `SELECT id, event_type, aggregate_id, payload, created_at
         FROM outbox_events
        WHERE id > $1
          AND event_type = ANY($2::text[])
        ORDER BY id ASC
        LIMIT $3`,
      [cursor.lastProcessedId.toString(), REPORTING_EVENT_TYPES, config.consumerBatchLimit],
    );

    // FH: redundant with ORDER BY id ASC (last row is max). harmless
    let maxId = cursor.lastProcessedId;
    for (const row of eventsResult.rows) {
      await applyEvent(client, row);
      const rowId = BigInt(row.id);
      if (rowId > maxId) maxId = rowId;
    }

    if (eventsResult.rows.length > 0) {
      await advanceCursor(client, CONSUMER_NAME, maxId);
    }

    return { processedCount: eventsResult.rows.length };
  });
}

/**
 * Fallback the listener uses after repeated failed passes: each event is
 * applied under its own SAVEPOINT, and one that throws is recorded in
 * reporting_dead_letters and skipped, so a single malformed event can no
 * longer stall the worker. The watermark still advances atomically with
 * every write in the pass.
 */
async function runIsolatingPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
): Promise<{ processedCount: number; deadLetteredCount: number }> {
  return withTransaction(pool, async (client) => {
    const cursor = await readCursor(client, CONSUMER_NAME);
    const eventsResult = await client.query<OutboxEventRow>(
      `SELECT id, event_type, aggregate_id, payload, created_at
         FROM outbox_events
        WHERE id > $1
          AND event_type = ANY($2::text[])
        ORDER BY id ASC
        LIMIT $3`,
      [cursor.lastProcessedId.toString(), REPORTING_EVENT_TYPES, config.consumerBatchLimit],
    );

    let maxId = cursor.lastProcessedId;
    let deadLetteredCount = 0;
    for (const row of eventsResult.rows) {
      await client.query("SAVEPOINT reporting_event");
      try {
        await applyEvent(client, row);
        await client.query("RELEASE SAVEPOINT reporting_event");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT reporting_event");
        await client.query(
          `INSERT INTO reporting_dead_letters (outbox_event_id, consumer_name, event_type, error)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (outbox_event_id) DO NOTHING`,
          [row.id, CONSUMER_NAME, row.event_type, err instanceof Error ? err.message : String(err)],
        );
        deadLetteredCount++;
      }
      const rowId = BigInt(row.id);
      if (rowId > maxId) maxId = rowId;
    }

    if (eventsResult.rows.length > 0) {
      await advanceCursor(client, CONSUMER_NAME, maxId);
    }
    return { processedCount: eventsResult.rows.length - deadLetteredCount, deadLetteredCount };
  });
}
