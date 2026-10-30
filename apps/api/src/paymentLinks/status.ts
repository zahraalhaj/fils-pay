/** Reserved links remain processing until the attempt is reconciled. */
export type PublicPaymentLinkStatus = "active" | "processing" | "paid" | "expired" | "canceled";

/** Missing reservation metadata never makes a charge safe to retry. */
export interface PaymentLinkStatusInput {
  status: string;
  expiresAt: Date;
  reservedAt: Date | null;
}

export function derivePublicStatus(
  row: PaymentLinkStatusInput,
  _reservationTimeoutSeconds: number,
): PublicPaymentLinkStatus {
  if (row.status === "paid") return "paid";
  if (row.status === "canceled") return "canceled";

  if (row.status === "active") {
    return row.expiresAt.getTime() <= Date.now() ? "expired" : "active";
  }

  return "processing";
}
