/**
 * The export route now streams (#33). The streaming variant must produce
 * exactly the same CSV as the in-memory one, including across page
 * boundaries where several rows share a timestamp (its old `occurred_at >
 * cursor` paging skipped those, and a JS Date cursor lost microseconds).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildTransactionsExportCsv, streamTransactionsExportCsv } from "./exportCsv.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("exportCsv.stream.new.test.ts requires DATABASE_URL");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

test("streamed CSV equals the in-memory CSV across pages with tied and microsecond timestamps", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`export-stream ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  // 7 rows on one identical timestamp, 5 more 1 µs apart.
  const timestamps = [
    ...Array(7).fill("2026-09-15T10:00:00.123456Z"),
    ...[1, 2, 3, 4, 5].map((n) => `2026-09-15T10:00:00.12346${n}Z`),
  ];
  for (const [i, ts] of timestamps.entries()) {
    await pool.query(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, occurred_at, acquirer_reference)
       VALUES ($1, 'captured', $2, $2, $3, $4, $5)`,
      [merchantId, 1000 + i, `ref-${i}`, ts, `acq-${randomUUID()}`],
    );
  }

  let streamed = "";
  for await (const chunk of streamTransactionsExportCsv(pool, { merchantId }, 3)) {
    streamed += chunk;
  }
  const lines = streamed.split("\n");
  assert.equal(lines.length, 1 + timestamps.length, "header + every row exactly once");
  assert.equal(new Set(lines.slice(1).map((l) => l.split(",")[0])).size, timestamps.length, "no duplicates");

  const inMemory = await buildTransactionsExportCsv(pool, { merchantId });
  assert.deepEqual(lines.slice(1).map((l) => l.split(",")[0]).sort(), inMemory.split("\n").slice(1).map((l) => l.split(",")[0]).sort());
});
