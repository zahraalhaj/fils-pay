/** Public status mirrors the server's non-expiring payment reservation. */
export type PublicPaymentLinkStatus = "active" | "processing" | "paid" | "expired" | "canceled";

/** A missing reservation timestamp does not make an in-flight charge safe to retry. */
export interface PaymentLinkStatusInput {
  status: string;
  expiresAt: Date;
  reservedAt: Date | null;
}

// FH: uses Date.now() not the client time — should this use expiryReferenceTime too?
// MK: no. public status is server time. (and yes that means read/pay can disagree, known)
export function derivePublicStatus(
  row: PaymentLinkStatusInput,
  _reservationTimeoutSeconds: number,
): PublicPaymentLinkStatus {
  if (row.status === "paid") return "paid";
  if (row.status === "canceled") return "canceled";

  if (row.status === "active") {
    return row.expiresAt.getTime() <= Date.now() ? "expired" : "active";
  }

  // A reserved charge needs reconciliation, regardless of elapsed time.
  return "processing";
}
