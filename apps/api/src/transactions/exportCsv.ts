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
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
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


/**
 * Streaming export for `GET /v1/transactions/export`: yields the header, then
 * one chunk per page of rows, so memory stays flat however large the range.
 * Same rows and order as buildTransactionsExportCsv.
 *
 * Keyset pagination on (occurred_at, id). The cursor's timestamp is carried
 * as Postgres's own text rendering, never a JS Date, which would drop the
 * microseconds and re-read or skip rows at a page boundary; `id` breaks ties
 * between rows with the same timestamp.
 */
export async function* streamTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
  pageSize = 1000,
): AsyncGenerator<string> {
  yield "id,status,amount_bhd,captured_bhd,reference,occurred_at";

  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let cursor: { occurredAt: string; id: string } | null = null;

  while (true) {
    const result: { rows: Array<TransactionRow & { occurred_at_text: string }> } = await pool.query(
      `SELECT *, occurred_at::text AS occurred_at_text FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5::timestamptz, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [
        filters.merchantId,
        filters.from ?? null,
        filters.to ?? null,
        statusArray,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        pageSize,
      ],
    );

    if (result.rows.length > 0) {
      yield result.rows.map((row) => "\n" + toCsvRow(row)).join("");
    }
    if (result.rows.length < pageSize) return;
    const last = result.rows[result.rows.length - 1]!;
    cursor = { occurredAt: last.occurred_at_text, id: last.id };
  }
}
