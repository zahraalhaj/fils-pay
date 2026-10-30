/**
 * One malformed outbox event must not stall reporting forever (#57). The
 * isolating pass applies the good events, parks the bad one in
 * reporting_dead_letters and moves the watermark past both.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("runConsumerPass.deadLetter.new.test.ts requires DATABASE_URL");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const config = { consumerBatchLimit: 500 };

test.after(async () => {
  await pool.end();
});

test("isolating pass dead-letters the malformed event and applies the rest", async () => {
  // Drain anything already pending so this test only sees its own events.
  await runConsumerPass(pool, config, { isolateFailures: true });

  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`dead-letter ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;

  const bad = await enqueueEvent(pool, {
    eventType: "transaction.voided",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: {}, // no merchantId → NOT NULL violation in the rollup
  });
  const good = await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 1_000, feeFils: 25, newStatus: "captured", capturedTotalFils: 1_000 },
  });
  assert.ok(good.id > bad.id, "the good event sits behind the bad one");

  await assert.rejects(runConsumerPass(pool, config), "the normal pass still fails as a whole");

  const result = await runConsumerPass(pool, config, { isolateFailures: true });
  assert.equal(result.deadLetteredCount, 1);

  const parked = await pool.query(`SELECT event_type FROM reporting_dead_letters WHERE outbox_event_id = $1`, [bad.id]);
  assert.equal(parked.rows.length, 1);
  const volume = await pool.query<{ captured_count: number }>(
    `SELECT captured_count FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(volume.rows[0]?.captured_count, 1, "the good event behind it was applied");

  const next = await runConsumerPass(pool, config);
  assert.equal(next.processedCount, 0, "the worker is no longer stuck");
});
