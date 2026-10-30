/**
 * Settlement summary for a transaction captured in several parts (#7).
 * The summary used to sum the transaction's running `captured_fils` once per
 * capture event, so a 3-part capture of 9,000 fils reported 3,000 + 6,000 +
 * 9,000 = 18,000. It must equal what CloseBatch sums: each event's own
 * `amount_fils`.
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
  throw new Error("settlementSummary.multicapture.new.test.ts requires DATABASE_URL");
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

function todayBahrainDateString(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addOneCalendarDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test("GET /v1/settlement/summary counts a multi-part capture once, at its captured total", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Test Merchant summary-multicapture ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label: "summary" });
  const headers = { authorization: `Bearer ${rawKey}` };

  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { amountFils: 9_000, card: VALID_CARD, reference: "multi" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const txnId = (auth.json() as { id: string }).id;

  for (const amountFils of [3_000, 3_000, 3_000]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/transactions/${txnId}/capture`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { amountFils },
    });
    assert.equal(res.statusCode, 200, res.body);
  }

  const from = todayBahrainDateString();
  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/summary?from=${from}&to=${addOneCalendarDay(from)}`,
    headers,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { transactionCount: number; totalCapturedFils: number };
  assert.equal(body.transactionCount, 1);
  assert.equal(body.totalCapturedFils, 9_000);
});
