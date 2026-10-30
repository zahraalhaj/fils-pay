import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/**
 * Report predicate. `merchantId` is always overwritten by the route with the
 * authenticated merchant before this reaches runTransactionsReport, so a
 * value supplied in the saved filter body is ignored.
 */
export interface TransactionReportFilter {
  merchantId: string;
  status?: string;
  from?: string;
  to?: string;
}

/** Money is pre-formatted as BD strings with 3 decimals (formatBhd), unlike the rest of the API which returns fils. */
export interface TransactionReportRow {
  id: string;
  merchantId: string;
  status: string;
  amountBhd: string;
  capturedBhd: string;
  reference: string | null;
  occurredAt: string;
}

interface TransactionReportQueryRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  reference: string | null;
  occurred_at: Date;
}

/** A plain `YYYY-MM-DD` is a Bahrain business date, so it starts at Bahrain
 *  midnight (Postgres would otherwise read it as UTC midnight, 03:00 local).
 *  Anything else (a full ISO timestamp) is passed through unchanged. */
function reportBoundary(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+03:00` : value;
}

export async function runTransactionsReport(
  pool: Pool,
  filter: TransactionReportFilter,
): Promise<TransactionReportRow[]> {
  const params: unknown[] = [filter.merchantId];
  const conditions: string[] = ["merchant_id = $1"];
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filter.from) {
    params.push(reportBoundary(filter.from));
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (filter.to) {
    params.push(reportBoundary(filter.to));
    conditions.push(`occurred_at < $${params.length}`);
  }

  const result = await pool.query<TransactionReportQueryRow>(
    `SELECT id, merchant_id, status, amount_fils, captured_fils, reference, occurred_at
       FROM transactions
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC
      LIMIT 500`,
    params,
  );
  return result.rows.map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    status: row.status,
    amountBhd: formatBhd(toFils(Number(row.amount_fils))),
    capturedBhd: formatBhd(toFils(Number(row.captured_fils))),
    reference: row.reference,
    occurredAt: row.occurred_at.toISOString(),
  }));
}
