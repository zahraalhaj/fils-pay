/**
 * Reusing a capture idempotency key on a DIFFERENT transaction (#13).
 * Keys are scoped per (merchant, endpoint), so with a hash of the body alone
 * the second call matched the first and replayed its 200 — transaction B was
 * never captured but the client was told it was.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("captureIdempotency.crossTxn.new.test.ts requires DATABASE_URL");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
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

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

test("same capture key + same body on another transaction → 422, second transaction untouched", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Test Merchant capture-key-reuse ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label: "k" });
  const headers = { authorization: `Bearer ${rawKey}` };

  async function authorize() {
    const res = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { amountFils: 5_000, card: VALID_CARD, reference: "k" },
    });
    assert.equal(res.statusCode, 201, res.body);
    return (res.json() as { id: string }).id;
  }
  const txnA = await authorize();
  const txnB = await authorize();
  const key = randomUUID();

  const first = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txnA}/capture`,
    headers: { ...headers, "idempotency-key": key },
    payload: {},
  });
  assert.equal(first.statusCode, 200, first.body);

  const second = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txnB}/capture`,
    headers: { ...headers, "idempotency-key": key },
    payload: {},
  });
  assert.equal(second.statusCode, 422, second.body);
  assert.equal(second.json().error, "idempotency_key_reused");

  const b = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [txnB]);
  assert.equal(b.rows[0]!.status, "authorized");
});
