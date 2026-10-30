import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

function csvEscape(value: string): string {
  // References are merchant-controlled text, never spreadsheet formulas.
  if (/^[\s]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value)) value = "'" + value;
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

/** Builds the CSV body for `GET /v1/transactions/export`. */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const result = await pool.query<TransactionRow>(
    `SELECT * FROM transactions
      WHERE merchant_id = $1
        AND ($2::timestamptz IS NULL OR occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR occurred_at <  $3)
        AND ($4::text[] IS NULL OR status = ANY($4))
      ORDER BY occurred_at ASC`,
    [filters.merchantId, filters.from ?? null, filters.to ?? null, statusArray],
  );

  const header = "id,status,amount_bhd,captured_bhd,reference,occurred_at";
  const lines = result.rows.map(toCsvRow);
  return [header, ...lines].join("\n");
}


/** Snapshot cursor: bounded memory, no loss at equal/microsecond timestamps. */
export async function* iterateTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): AsyncGenerator<string> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(
      `DECLARE filspay_export NO SCROLL CURSOR FOR
       SELECT * FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at < $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
        ORDER BY occurred_at ASC, id ASC`,
      [filters.merchantId, filters.from ?? null, filters.to ?? null,
       filters.status?.length ? filters.status : null],
    );
    yield "id,status,amount_bhd,captured_bhd,reference,occurred_at\n";
    while (true) {
      const result = await client.query<TransactionRow>("FETCH FORWARD 1000 FROM filspay_export");
      for (const row of result.rows) yield toCsvRow(row) + "\n";
      if (result.rows.length < 1000) break;
    }
  } finally {
    // Also closes the cursor if the HTTP consumer disconnects early.
    try { await client.query("ROLLBACK"); }
    catch (err) { broken = err instanceof Error ? err : new Error(String(err)); }
    client.release(broken);
  }
}

/** Await each writer so a slow receiver applies backpressure. */
export async function streamTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
  write: (chunk: string) => void | Promise<void>,
): Promise<void> {
  for await (const chunk of iterateTransactionsExportCsv(pool, filters)) await write(chunk);
}
