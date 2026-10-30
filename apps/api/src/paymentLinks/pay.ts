import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  submittedAt?: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** Returned by the claim UPDATE; merchant_id comes from the link row, never from the request. */
interface ClaimedLinkRow {
  id: string;
  reservation_id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
}

/** Public checkout cannot attest a client timestamp. Always use server time. */
export function expiryReferenceTime(_submittedAt?: string, now: Date = new Date()): Date {
  return now;
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction`
 * then `captureTransaction` directly, in sequence, never issuing an HTTP
 * request back into the API's own /v1/transactions routes.
 *
 * Concurrency: retain Zahra's reservation ownership and atomic capture/link
 * update. Reserved links cannot be reclaimed by elapsed time: an unknown
 * processor result or process crash requires reconciliation before release.
 * A lost ownership check still voids the authorization without capturing.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const expiryCheckTime = expiryReferenceTime(input.submittedAt);

  // Step 1 — claim. A single UPDATE is already atomic; no explicit
  // transaction needed.
  // YA: one conditional UPDATE = atomic claim, no explicit txn needed. correct
  const claimResult = await pool.query<ClaimedLinkRow>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now(), reservation_id = gen_random_uuid()
      WHERE token = $1
        AND status = 'active'
        AND expires_at > $2
      RETURNING id, reservation_id, merchant_id, amount_fils, reference`,
    [input.token, expiryCheckTime],
  );

  const claimedRow = claimResult.rows[0];
  if (!claimedRow) {
    return classifyClaimFailure(pool, input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime);
  }

  const link = {
    id: claimedRow.id,
    reservationId: claimedRow.reservation_id,
    merchantId: claimedRow.merchant_id,
    amountFils: toFils(Number(claimedRow.amount_fils)),
    reference: claimedRow.reference,
  };

  // Step 2 — authorize.
  // am: keys include link.id so two links can never collide on idempotency. good
  const authorizeKey = `paylink:${link.id}:${input.idempotencyKey}:authorize`;
  const authResult = await authorizeTransaction(pool, acquirer, {
    merchantId: link.merchantId,
    amountFils: link.amountFils,
    card: input.card,
    reference: link.reference ?? undefined,
    idempotencyKey: authorizeKey,
    // No merchant session/API key initiated this — a customer did, via
    // the public link.
    actor: { type: "system" },
  });

  if (authResult.statusCode !== 201) {
    // Unknown authorization results keep ownership for reconciliation.
    if (authResult.statusCode === 402) await releaseReservation(pool, link.id, link.reservationId);
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // Step 3 — capture (full amount, immediately). amountFils omitted =>
  // capture the full remaining amount — always correct here, since this
  // transaction was just authorized for exactly link.amountFils and
  // nothing else could have touched it yet.
  const captureKey = `paylink:${link.id}:${input.idempotencyKey}:capture`;
  const captureResult = await captureTransaction(pool, acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: captureKey,
    actor: { type: "system", id: link.id },
    paymentLink: { linkId: link.id, reservationId: link.reservationId },
  });

  if (captureResult.statusCode === 409 && (captureResult.body as { error?: string }).error === "payment_link_reservation_lost") {
    // Another attempt took over the link (or already paid it). Nothing was
    // captured; release the hold this attempt placed on the card.
    await voidTransaction(pool, {
      transactionId: txnId,
      merchantId: link.merchantId,
      actor: { type: "system", id: link.id },
    });
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }

  if (captureResult.statusCode !== 200) {
    // A timeout/error cannot prove that no charge occurred.
    if (captureResult.statusCode === 402) await releaseReservation(pool, link.id, link.reservationId);
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // Capture marked the link paid in its own transaction. A replayed capture
  // (retry of an attempt that crashed before the link was marked paid, under
  // the old two-step flow) returns its cached 200 without re-running, so
  // finalize here too — a no-op when capture already did it.
  await pool.query(
    `UPDATE payment_links
        SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL, reservation_id = NULL
      WHERE id = $1 AND status = 'reserved' AND reservation_id = $3`,
    [link.id, txnId, link.reservationId],
  );
  const paid = await pool.query<{ paid_at: Date }>(`SELECT paid_at FROM payment_links WHERE id = $1`, [link.id]);
  return {
    statusCode: 200,
    body: {
      status: "paid",
      transactionId: txnId,
      amountFils: link.amountFils,
      paidAt: (paid.rows[0]?.paid_at ?? new Date()).toISOString(),
    },
  };
}

/**
 * Used by both decline branches above. Guarded by `status =
 * 'reserved'` for the same reason as the finalize UPDATE: this request
 * only ever releases the reservation it itself holds.
 */
async function releaseReservation(pool: Pool, linkId: string, reservationId: string): Promise<void> {
  await pool.query(
    `UPDATE payment_links SET status = 'active', reserved_at = NULL, reservation_id = NULL
      WHERE id = $1 AND status = 'reserved' AND reservation_id = $2`,
    [linkId, reservationId],
  );
}

/**
 * The claim UPDATE matched 0 rows. This second read carries no race risk —
 * nothing further is decided from it, it only explains a decision already
 * made by the failed UPDATE.
 */
// FH: "This second read carries no race risk" — Claude disagrees, says we should SELECT
// ... FOR UPDATE here. TODO
// am: its only for the error message. ignore
async function classifyClaimFailure(
  pool: Pool,
  token: string,
  _reservationTimeoutSeconds: number,
  expiryCheckTime: Date,
): Promise<PayPaymentLinkResult> {
  const result = await pool.query<LinkStatusRow>(`SELECT status, expires_at FROM payment_links WHERE token = $1`, [
    token,
  ]);
  const row = result.rows[0];

  if (!row) {
    return { statusCode: 404, body: { error: "payment_link_not_found" } };
  }
  if (row.status === "paid") {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row.status === "canceled") {
    return { statusCode: 409, body: { error: "payment_link_canceled" } };
  }
  if (row.status === "active" && row.expires_at.getTime() <= expiryCheckTime.getTime()) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (row.status === "reserved") {
    // Elapsed time cannot establish that a processor call had no effect.
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  // Defensive fallback, should be unreachable given the claim UPDATE's
  // WHERE clause exactly mirrors these cases.
  return { statusCode: 409, body: { error: "payment_link_not_payable", status: row.status } };
}
