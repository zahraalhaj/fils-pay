/**
 * settlement.batch_closed when the day had real captures but reporting has no
 * merchant_daily_volume row for it (the lagging-rollup case the parity check
 * exists to detect): it must warn, still record the payout trend, and never
 * throw — a throw stalls the whole consumer behind this one event.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent } from "./applyEvent.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("applyEvent.batchRollup.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

test.after(async () => {
  await pool.end();
});

test("batch_closed with captures but no rollup row records the payout trend instead of throwing", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`batch rollup ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 5000, 5000, $2) RETURNING id`,
    [merchantId, `acqref_${randomUUID()}`],
  );
  // 10:00 Bahrain on 2026-01-05 — a real capture that reporting never rolled up.
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
     VALUES ($1, 'captured', 5000, 'system', '2026-01-05T07:00:00Z')`,
    [txn.rows[0]!.id],
  );
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-01-05', 'closed', 5000, 125, 4875, now()) RETURNING id`,
    [merchantId],
  );

  await withTransaction(pool, (client) =>
    applyEvent(client, {
      id: 1,
      event_type: "settlement.batch_closed",
      aggregate_id: batch.rows[0]!.id,
      payload: {
        merchantId,
        batchId: batch.rows[0]!.id,
        batchDate: "2026-01-05",
        grossFils: 5000,
        feeFils: 125,
        netPayoutFils: 4875,
      },
      created_at: new Date("2026-01-05T21:00:00Z"),
    }),
  );

  const trend = await pool.query(
    `SELECT net_payout_fils FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batch.rows[0]!.id],
  );
  assert.equal(trend.rows.length, 1);
  assert.equal(Number(trend.rows[0].net_payout_fils), 4875);
});
