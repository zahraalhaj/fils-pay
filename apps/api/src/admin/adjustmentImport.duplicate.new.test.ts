/**
 * The same adjustment CSV must not be applied twice by accident (#2): the
 * August file was posted twice and nothing stopped it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { applyAdjustmentImport } from "./adjustmentImport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("adjustmentImport.duplicate.new.test.ts requires DATABASE_URL");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function setup() {
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'not-a-real-hash', 'Duplicate Import Test', 'finance') RETURNING id`,
    [`adj-dup-${randomUUID()}@admin.test`],
  );
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`adj-dup-merchant-${randomUUID()}`],
  );
  return { adminUserId: admin.rows[0]!.id, merchantId: merchant.rows[0]!.id };
}

async function ledgerTotal(merchantId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM adjustment_import_rows WHERE merchant_id = $1`,
    [merchantId],
  );
  return Number(r.rows[0]!.n);
}

test("re-uploading the same rows (even under another filename) is refused with 409", async () => {
  const { adminUserId, merchantId } = await setup();
  const rows = [{ merchantId, amount: "4.750", reason: "August residue" }];

  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "aug.csv", rows });
  await assert.rejects(
    applyAdjustmentImport(pool, { adminUserId, originalFilename: "aug (1).csv", rows }),
    (err: { statusCode?: number; code?: string }) => err.statusCode === 409 && err.code === "duplicate_import",
  );
  assert.equal(await ledgerTotal(merchantId), 1, "the rows were posted once");
});

test("allowDuplicate: true posts identical rows deliberately", async () => {
  const { adminUserId, merchantId } = await setup();
  const rows = [{ merchantId, amount: "1.000", reason: "monthly fee" }];

  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "a.csv", rows });
  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "a.csv", rows, allowDuplicate: true });
  assert.equal(await ledgerTotal(merchantId), 2);
});
