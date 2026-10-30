/**
 * The negotiated discount is applied inside captureTransaction, so every
 * capture path gets it — payment-link payments called captureTransaction
 * directly and never got the discount, which was only applied in the API
 * route, after the capture had committed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { captureTransaction } from "./capture.js";
import { applyCaptureDiscountAdjustment } from "./discountAdjustment.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("captureDiscount.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

test("captureTransaction itself posts the negotiated discount rebate, exactly once", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, 250, 2000) RETURNING id`,
    [`Discount capture ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "discount" });
  const keyRow = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [merchantId]);

  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${key.rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 10_000, card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const transactionId = (auth.json() as { id: string }).id;

  // Called directly, the way paymentLinks/pay.ts does — no route involved.
  const captured = await captureTransaction(pool, app.acquirer, {
    transactionId,
    merchantId,
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: keyRow.rows[0]!.id },
  });
  assert.equal(captured.statusCode, 200, JSON.stringify(captured.body));
  // The old after-the-fact helper must now be a no-op for this capture.
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  const fee = await pool.query<{ net: string; rebates: string }>(
    `SELECT SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) AS net,
            COUNT(*) FILTER (WHERE description = 'capture: negotiated discount adjustment' AND direction = 'debit') AS rebates
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [transactionId],
  );
  // 10,000 at 250 bps = 250 fee; 20% discount = 50 rebate; 200 kept.
  assert.equal(Number(fee.rows[0]!.net), 200);
  assert.equal(Number(fee.rows[0]!.rebates), 1);
});
