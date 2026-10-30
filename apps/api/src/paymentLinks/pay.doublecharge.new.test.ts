/**
 * Incident 2026-05-14 / FP-202: a slow first payment outlived its
 * reservation, a second buyer re-claimed the link, and both were charged.
 * Now only the attempt that still holds the reservation can capture.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { payPaymentLink } from "./pay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("pay.doublecharge.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

test("a slow payer whose reservation was taken over can't also be charged", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Double charge ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const token = `plink_${randomUUID()}`;
  const link = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 5000, now() + interval '1 day', 'merchant_api_key', $3) RETURNING id`,
    [merchantId, token, randomUUID()],
  );

  // Buyer A's authorization is slow; buyer B's is instant.
  const real = app.acquirer;
  let first = true;
  const slowFirst: AcquirerSimulator = {
    authorize: async (req) => {
      if (first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      return real.authorize(req);
    },
    capture: (req) => real.capture(req),
    refund: (req) => real.refund(req),
  };
  // A 1 s reservation, so A's has expired by the time B arrives.
  const linkConfig = { paymentLinkReservationTimeoutSeconds: 1 };

  const buyerA = payPaymentLink(pool, slowFirst, linkConfig, { token, card: CARD, idempotencyKey: randomUUID() });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const buyerB = await payPaymentLink(pool, slowFirst, linkConfig, { token, card: CARD, idempotencyKey: randomUUID() });
  const resultA = await buyerA;

  assert.equal(buyerB.statusCode, 200, JSON.stringify(buyerB.body));
  assert.equal(resultA.statusCode, 409, JSON.stringify(resultA.body));

  const txns = await pool.query<{ status: string; captured_fils: string }>(
    `SELECT status, captured_fils FROM transactions WHERE merchant_id = $1 ORDER BY created_at`,
    [merchantId],
  );
  const captured = txns.rows.filter((t) => Number(t.captured_fils) > 0);
  assert.equal(captured.length, 1, `exactly one charge, got ${JSON.stringify(txns.rows)}`);
  assert.ok(txns.rows.some((t) => t.status === "voided"), "the losing attempt's authorization is voided");

  const paid = await pool.query<{ status: string; transaction_id: string }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [link.rows[0]!.id],
  );
  assert.equal(paid.rows[0]!.status, "paid");
});

test("FP-187: an expired link can't be paid by claiming an old submittedAt", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Expired link ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const token = `plink_${randomUUID()}`;
  await pool.query(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 5000, now() - interval '1 day', 'merchant_api_key', $3)`,
    [merchantId, token, randomUUID()],
  );

  const res = await payPaymentLink(pool, app.acquirer, { paymentLinkReservationTimeoutSeconds: 60 }, {
    token,
    card: CARD,
    idempotencyKey: randomUUID(),
    submittedAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
  });
  assert.equal(res.statusCode, 410, JSON.stringify(res.body));
});
