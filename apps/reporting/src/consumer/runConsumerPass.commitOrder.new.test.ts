/**
 * Outbox ids are handed out at INSERT but become visible at COMMIT, so a
 * transaction holding id N can commit after id N+1 was already consumed.
 * The pass must not move its watermark past an event that is still in
 * flight, or that event never reaches the reports (#74).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("runConsumerPass.commitOrder.new.test.ts requires DATABASE_URL");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const config = { consumerBatchLimit: 500 };

test.after(async () => {
  await pool.end();
});

function captured(merchantId: string, amountFils: number) {
  return {
    eventType: "transaction.captured" as const,
    aggregateType: "transaction" as const,
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: amountFils, feeFils: 0, newStatus: "captured", capturedTotalFils: amountFils },
  };
}

for (const isolateFailures of [false, true]) {
  test(`an event committed after a later id was consumed is still applied (isolateFailures=${isolateFailures})`, async () => {
    await runConsumerPass(pool, config, { isolateFailures: true });

    const merchant = await pool.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`commit-order ${randomUUID()}`],
    );
    const merchantId = merchant.rows[0]!.id;

    const slow = await pool.connect();
    try {
      await slow.query("BEGIN");
      const early = await enqueueEvent(slow, captured(merchantId, 1_000));
      const late = await enqueueEvent(pool, captured(merchantId, 2_000));
      assert.ok(late.id > early.id, "the committed event has the higher id");

      await runConsumerPass(pool, config, { isolateFailures });
      await slow.query("COMMIT");
    } catch (err) {
      await slow.query("ROLLBACK");
      throw err;
    } finally {
      slow.release();
    }

    await runConsumerPass(pool, config, { isolateFailures });

    const volume = await pool.query<{ captured_count: number; captured_fils: string }>(
      `SELECT SUM(captured_count)::int AS captured_count, SUM(captured_gross_fils)::text AS captured_fils
         FROM merchant_daily_volume WHERE merchant_id = $1`,
      [merchantId],
    );
    assert.equal(volume.rows[0]?.captured_count, 2, "both captures reach the rollup");
    assert.equal(volume.rows[0]?.captured_fils, "3000");
  });
}
