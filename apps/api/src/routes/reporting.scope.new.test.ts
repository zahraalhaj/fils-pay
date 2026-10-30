/**
 * /v1/reporting scoping and date windows.
 * - A merchant may only report on a split child of its own (it used to be
 *   enough for the requested merchant to be anyone's split child).
 * - /export-summary requires authentication.
 * - A plain YYYY-MM-DD `from` is Bahrain midnight, not UTC midnight (#65).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reporting.scope.new.test.ts requires DATABASE_URL");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchantWithKey(label: string) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Test Merchant ${label} ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label });
  return { merchantId, headers: { authorization: `Bearer ${rawKey}` } };
}

async function insertTransaction(merchantId: string, occurredAt: string, reference: string) {
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, occurred_at, acquirer_reference)
     VALUES ($1, 'captured', 1000, 1000, $2, $3, $4)`,
    [merchantId, reference, occurredAt, `acq-${randomUUID()}`],
  );
}

function report(headers: Record<string, string>, filter: Record<string, string>) {
  return app.inject({
    method: "GET",
    url: `/v1/reporting/transactions?filter=${encodeURIComponent(JSON.stringify(filter))}`,
    headers,
  });
}

test("a merchant cannot report on another parent's split child", async () => {
  const parent = await merchantWithKey("report-parent");
  const child = await merchantWithKey("report-child");
  const outsider = await merchantWithKey("report-outsider");
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
     VALUES ($1, $2, 10000)`,
    [parent.merchantId, child.merchantId],
  );
  await insertTransaction(child.merchantId, new Date().toISOString(), "child-secret");

  const asOutsider = await report(outsider.headers, { merchantId: child.merchantId });
  assert.equal(asOutsider.statusCode, 200, asOutsider.body);
  const outsiderRows = asOutsider.json() as Array<{ merchantId: string }>;
  assert.ok(outsiderRows.every((r) => r.merchantId === outsider.merchantId), "outsider sees only its own rows");

  const asParent = await report(parent.headers, { merchantId: child.merchantId });
  const parentRows = asParent.json() as Array<{ reference: string }>;
  assert.ok(parentRows.some((r) => r.reference === "child-secret"), "the real parent still sees its child");
});

test("GET /v1/reporting/export-summary requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(res.statusCode, 401, res.body);
});

test("a date-only `from` starts at Bahrain midnight", async () => {
  const m = await merchantWithKey("report-bahrain-day");
  // 2026-03-01 01:00 Bahrain = 2026-02-28 22:00 UTC: belongs to 1 March.
  await insertTransaction(m.merchantId, "2026-02-28T22:00:00Z", "early-march-1");
  // 2026-02-28 23:30 Bahrain = 20:30 UTC: belongs to 28 Feb.
  await insertTransaction(m.merchantId, "2026-02-28T20:30:00Z", "late-feb-28");

  const res = await report(m.headers, { from: "2026-03-01", to: "2026-03-02" });
  assert.equal(res.statusCode, 200, res.body);
  const refs = (res.json() as Array<{ reference: string }>).map((r) => r.reference);
  assert.deepEqual(refs, ["early-march-1"]);
});
