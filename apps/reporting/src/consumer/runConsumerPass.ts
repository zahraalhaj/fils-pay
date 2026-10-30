import type { Pool, PoolClient } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { readCursor, advanceCursor, type ConsumerCursor } from "./cursor.js";
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
    const rows = await selectDueEvents(client, cursor, config.consumerBatchLimit);

    for (const row of rows) {
      await applyEvent(client, row);
    }

    if (rows.length > 0) {
      await advanceCursor(client, CONSUMER_NAME, positionOf(rows[rows.length - 1]!));
    }

    return { processedCount: rows.length };
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
    const rows = await selectDueEvents(client, cursor, config.consumerBatchLimit);

    let deadLetteredCount = 0;
    for (const row of rows) {
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
    }

    if (rows.length > 0) {
      await advanceCursor(client, CONSUMER_NAME, positionOf(rows[rows.length - 1]!));
    }
    return { processedCount: rows.length - deadLetteredCount, deadLetteredCount };
  });
}

type DueEventRow = OutboxEventRow & { txid: string };

/**
 * Next events after `cursor`, in (txid, id) order. Ids are assigned at
 * INSERT but visible only at COMMIT, so id order let the watermark pass an
 * event whose transaction was still open, losing it for good (#74). Rows
 * written by a transaction older than the snapshot's xmin are final: every
 * such transaction has committed or aborted, and any later outbox write has
 * a txid >= xmin, so it sorts after everything returned here. A long-open
 * transaction anywhere in the database delays reporting until it ends.
 */
async function selectDueEvents(
  client: PoolClient,
  cursor: ConsumerCursor,
  limit: number,
): Promise<DueEventRow[]> {
  const result = await client.query<DueEventRow>(
    `SELECT id, txid::text AS txid, event_type, aggregate_id, payload, created_at
       FROM outbox_events
      WHERE (txid, id) > ($1::xid8, $2::bigint)
        AND txid < pg_snapshot_xmin(pg_current_snapshot())
        AND event_type = ANY($3::text[])
      ORDER BY txid ASC, id ASC
      LIMIT $4`,
    [cursor.lastProcessedTxid.toString(), cursor.lastProcessedId.toString(), REPORTING_EVENT_TYPES, limit],
  );
  return result.rows;
}

function positionOf(row: DueEventRow): ConsumerCursor {
  return { lastProcessedTxid: BigInt(row.txid), lastProcessedId: BigInt(row.id) };
}
