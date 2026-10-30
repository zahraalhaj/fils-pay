import type { PaymentLinkStatus, TransactionStatus } from "../types.js";

type Tone = "success" | "warning" | "pending" | "danger" | "neutral";

interface StatusInfo {
  label: string;
  tone: Tone;
  /** One line for a detail page explaining what the status means. */
  help: string;
}

/** Plain-language labels for the stored transaction statuses. The raw enum
 *  stays in the `title` attribute so support can still match it to logs. */
export const TRANSACTION_STATUS: Record<TransactionStatus, StatusInfo> = {
  authorized: { label: "Authorized", tone: "warning", help: "Funds are held on the card but not yet captured." },
  captured: { label: "Captured", tone: "success", help: "The payment has been collected." },
  partially_captured: { label: "Partly captured", tone: "warning", help: "Part of the authorized amount has been collected." },
  voided: { label: "Voided", tone: "neutral", help: "The authorization was released; nothing was collected." },
  partially_refunded: { label: "Partly refunded", tone: "warning", help: "Some of the captured amount has been returned to the customer." },
  refunded: { label: "Refunded", tone: "neutral", help: "The full captured amount has been returned to the customer." },
  chargeback: { label: "Chargeback", tone: "danger", help: "The cardholder disputed this payment." },
};

export const PAYMENT_LINK_STATUS: Record<PaymentLinkStatus, StatusInfo> = {
  active: { label: "Awaiting payment", tone: "success", help: "Customers can pay this link." },
  reserved: {
    label: "Payment in progress",
    tone: "pending",
    help: "A payment attempt has started and its result is not confirmed yet. The link cannot be paid or canceled until it is resolved.",
  },
  paid: { label: "Paid", tone: "success", help: "This link has been paid." },
  canceled: { label: "Canceled", tone: "neutral", help: "This link was canceled and can no longer be paid." },
};

const FALLBACK: StatusInfo = { label: "", tone: "neutral", help: "" };

export function StatusBadge({ kind, status }: { kind: "transaction" | "link"; status: string }) {
  const table: Record<string, StatusInfo> = kind === "transaction" ? TRANSACTION_STATUS : PAYMENT_LINK_STATUS;
  const info = table[status] ?? { ...FALLBACK, label: status.replace(/_/g, " ") };
  return (
    <span className={`dash-status dash-tone-${info.tone}`} title={status}>
      {info.label}
    </span>
  );
}

export function statusHelp(kind: "transaction" | "link", status: string): string {
  const table: Record<string, StatusInfo> = kind === "transaction" ? TRANSACTION_STATUS : PAYMENT_LINK_STATUS;
  return table[status]?.help ?? "";
}
