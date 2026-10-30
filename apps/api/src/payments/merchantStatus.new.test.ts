/**
 * #61: a suspended merchant can't keep taking payments through an existing
 * API key or session — settlement skips non-active merchants, so the money
 * would be taken and never paid out.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { verifyApiKey } from "../apiKeys/verify.js";
import { recordKycReview } from "../onboarding/review.js";
import { lookupSession } from "../auth/sessions.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { authorizeTransaction } from "./authorize.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("merchantStatus.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

test("suspending a merchant stops its API keys, sessions and new authorizations", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Suspended ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "s" });
  const token = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at) VALUES ($1, $2, true, now() + interval '1 hour')`,
    [u.rows[0]!.id, sha256Hex(token)],
  );
  assert.ok(await verifyApiKey(pool, key.rawKey));
  assert.ok(await lookupSession(pool, token));

  await pool.query(`UPDATE merchants SET status = 'suspended' WHERE id = $1`, [merchantId]);

  assert.equal(await verifyApiKey(pool, key.rawKey), null);
  assert.equal(await lookupSession(pool, token), null);
  const auth = await authorizeTransaction(pool, app.acquirer, {
    merchantId,
    amountFils: 1000 as never,
    card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" },
    idempotencyKey: randomUUID(),
    actor: { type: "system" },
  });
  assert.equal(auth.statusCode, 403);
  assert.equal((auth.body as { error: string }).error, "merchant_not_active");
});
