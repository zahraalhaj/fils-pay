import type { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";

/** Operational record of a payout-rail instruction for a settlement batch. */
export async function recordPayoutDisbursementEffect(
  pool: Pool,
  settlementBatchId: string,
  amountFils: number,
): Promise<void> {
  if (amountFils <= 0) {
    // Void batches (zero or negative net) carry no payout instruction.
    return;
  }

  await withTransaction(pool, async (client) => {
    await client.query(`SELECT id FROM settlement_batches WHERE id = $1 FOR UPDATE`, [settlementBatchId]);
    await client.query(
      `INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
     SELECT $1, $2, 'disb_' || gen_random_uuid()
     WHERE NOT EXISTS (SELECT 1 FROM settlement_payout_disbursements WHERE settlement_batch_id = $1)`,
      [settlementBatchId, amountFils],
    );
  });
}
