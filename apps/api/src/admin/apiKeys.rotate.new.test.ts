/**
 * #47: rotating a key retires the old one — it works during a 24 h overlap
 * and then stops. It used to stay valid forever.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { verifyApiKey } from "../apiKeys/verify.js";
import { rotateApiKeyAsAdmin } from "./apiKeys.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("apiKeys.rotate.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

test("a rotated-out key works during the overlap, then stops", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Rotate ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Rotator', 'finance') RETURNING id`,
    [`rotator-${randomUUID()}@admin.test`],
  );
  const oldKey = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "old" });
  const oldRow = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [merchantId]);

  const rotated = await rotateApiKeyAsAdmin(pool, config, {
    merchantId,
    apiKeyId: oldRow.rows[0]!.id,
    adminUserId: admin.rows[0]!.id,
  });

  assert.ok(await verifyApiKey(pool, oldKey.rawKey), "old key still works during the overlap");
  assert.ok(await verifyApiKey(pool, rotated.rawKey), "new key works");

  await pool.query(`UPDATE api_keys SET revoke_after = now() - interval '1 second' WHERE id = $1`, [oldRow.rows[0]!.id]);
  assert.equal(await verifyApiKey(pool, oldKey.rawKey), null, "old key stops after the overlap");
  assert.ok(await verifyApiKey(pool, rotated.rawKey));
});
