/**
 * Impersonation is read-only (HANDOVER). Capture and void only required
 * authentication, so an admin "viewing as" a merchant could capture or void
 * that merchant's payments, recorded as a merchant_session write (#49).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { startImpersonation } from "../admin/impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("impersonationReadOnly.new.test.ts requires DATABASE_URL");
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

test("an impersonation grant can read but cannot capture or void", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Test Merchant impersonation-ro ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label: "k" });

  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 5_000, card: VALID_CARD, reference: "imp" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const txnId = (auth.json() as { id: string }).id;

  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused', 'Imp RO', 'super_admin') RETURNING id`,
    [`imp-ro-${randomUUID()}@admin.test`],
  );
  const grant = await startImpersonation(pool, { adminUserId: admin.rows[0]!.id, merchantId, ttlMinutes: 15 });
  const cookie = { cookie: `${config.impersonationCookieName}=${grant.rawToken}` };

  const read = await app.inject({ method: "GET", url: `/v1/transactions/${txnId}`, headers: cookie });
  assert.equal(read.statusCode, 200, read.body);

  for (const action of ["capture", "void"]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/transactions/${txnId}/${action}`,
      headers: { ...cookie, "idempotency-key": randomUUID() },
      payload: {},
    });
    assert.equal(res.statusCode, 403, `${action}: ${res.body}`);
  }

  const after = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [txnId]);
  assert.equal(after.rows[0]!.status, "authorized");
});
