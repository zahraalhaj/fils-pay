/**
 * Refund control on the transaction detail page (FP-212). Posts to
 * `POST /v1/merchants/:merchantId/refunds`; leaving the amount blank omits
 * `amountFils` and the API refunds everything still refundable (captured
 * minus already refunded) — its own documented default.
 *
 * Two steps: enter an amount (in BHD, converted to integer fils by the shared
 * parser), then review exactly what will happen before anything is sent.
 * The confirmation shown afterwards is built from the server's response, not
 * from what was typed.
 */
import { useEffect, useRef, useState } from "react";
import { request } from "../../api/client.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { parseBhdInput } from "../../format.js";
import { ErrorNotice, SuccessNotice } from "../../ui/Feedback.js";
import { Money } from "../../ui/Money.js";
import { TRANSACTION_STATUS } from "../../ui/StatusBadge.js";
import type { TransactionDto, TransactionStatus } from "../../types.js";

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

type Step = { kind: "closed" } | { kind: "entering" } | { kind: "reviewing"; amountFils: number; full: boolean };

export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [step, setStep] = useState<Step>({ kind: "closed" });
  const [amountText, setAmountText] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RefundResponse | null>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const merchantId = me?.merchant.id;
  const refundableFils = txn.capturedFils - txn.refundedFils;
  const refundable =
    (txn.status === "captured" || txn.status === "partially_captured" || txn.status === "partially_refunded") &&
    refundableFils > 0;

  useEffect(() => {
    if (step.kind === "entering") amountRef.current?.focus();
    if (step.kind === "reviewing") confirmRef.current?.focus();
  }, [step.kind]);

  function close(): void {
    setStep({ kind: "closed" });
    setAmountText("");
    setAmountError(null);
    requestAnimationFrame(() => openButtonRef.current?.focus());
  }

  function review(event: React.FormEvent): void {
    event.preventDefault();
    setError(null);
    if (amountText.trim() === "") {
      setStep({ kind: "reviewing", amountFils: refundableFils, full: true });
      return;
    }
    const parsed = parseBhdInput(amountText);
    if (!parsed.ok) {
      setAmountError(
        parsed.reason === "not_positive"
          ? "The refund must be more than 0.000 BHD."
          : "Enter the amount in BHD with up to 3 decimal places, for example 2.500.",
      );
      amountRef.current?.focus();
      return;
    }
    if (parsed.fils > refundableFils) {
      setAmountError("That is more than is left to refund. Enter a smaller amount or leave it blank to refund the rest.");
      amountRef.current?.focus();
      return;
    }
    setStep({ kind: "reviewing", amountFils: parsed.fils, full: parsed.fils === refundableFils });
  }

  async function submit(): Promise<void> {
    if (!merchantId || step.kind !== "reviewing" || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // A blank amount is still sent as "no amountFils" so the server applies
      // its own full-refund default rather than a value computed here.
      const typed = amountText.trim();
      const body = typed === "" ? { transactionId: txn.id } : { transactionId: txn.id, amountFils: step.amountFils };
      const result = await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        // A fresh key per confirmed attempt, including a retry after a failure.
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setDone(result);
      setStep({ kind: "closed" });
      setAmountText("");
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const successNotice = done ? (
    <SuccessNotice title="Refund recorded">
      <Money fils={done.amountFils} /> is being returned to the customer&apos;s card. Total refunded on this
      transaction: <Money fils={done.refundedTotalFils} />. Status is now{" "}
      {TRANSACTION_STATUS[done.transactionStatus as TransactionStatus]?.label ?? done.transactionStatus}.
    </SuccessNotice>
  ) : null;

  if (!refundable) return successNotice;

  return (
    <RequireRole allow={["owner", "finance"]}>
      {successNotice}
      <div className="dash-panel">
        <h2>Refund</h2>
        {error ? <ErrorNotice title="The refund was not made">{error}</ErrorNotice> : null}

        {step.kind === "closed" ? (
          <>
            <p className="dash-muted">
              Up to <Money fils={refundableFils} /> can still be returned to the customer&apos;s card.
            </p>
            <button
              type="button"
              ref={openButtonRef}
              className="dash-button"
              onClick={() => {
                setDone(null);
                setStep({ kind: "entering" });
              }}
            >
              Refund…
            </button>
          </>
        ) : null}

        {step.kind === "entering" ? (
          <form className="dash-form" noValidate onSubmit={review}>
            <div className="dash-field">
              <label htmlFor="refund-amount">Refund amount (BHD)</label>
              <span className="dash-field-hint" id="refund-amount-hint">
                Leave blank to refund the full remaining <Money fils={refundableFils} />.
              </span>
              <div className="dash-input-affix">
                <input
                  id="refund-amount"
                  ref={amountRef}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.000"
                  value={amountText}
                  aria-invalid={amountError ? true : undefined}
                  aria-describedby={`refund-amount-hint${amountError ? " refund-amount-error" : ""}`}
                  onChange={(e) => {
                    setAmountText(e.target.value);
                    setAmountError(null);
                  }}
                />
                <span aria-hidden="true">BHD</span>
              </div>
              {amountError ? (
                <span className="dash-field-error" id="refund-amount-error" role="alert">
                  {amountError}
                </span>
              ) : null}
            </div>
            <div className="dash-form-actions">
              <button type="submit" className="dash-button dash-button-primary">
                Review refund
              </button>
              <button type="button" className="dash-button" onClick={close}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {step.kind === "reviewing" ? (
          <div
            className="dash-confirm"
            role="group"
            aria-labelledby="refund-review-title"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !submitting) close();
            }}
          >
            <h3 id="refund-review-title">
              Refund <Money fils={step.amountFils} /> to the customer?
            </h3>
            <dl className="dash-dl">
              <dt>Transaction</dt>
              <dd>{txn.reference ?? <code>{txn.id}</code>}</dd>
              <dt>Captured</dt>
              <dd>
                <Money fils={txn.capturedFils} />
              </dd>
              <dt>Already refunded</dt>
              <dd>
                <Money fils={txn.refundedFils} />
              </dd>
              <dt>This refund</dt>
              <dd>
                <strong>
                  <Money fils={step.amountFils} />
                </strong>
                {step.full ? " (everything remaining)" : null}
              </dd>
              <dt>Left to refund after</dt>
              <dd>
                <Money fils={refundableFils - step.amountFils} />
              </dd>
            </dl>
            <p>The money goes back to the cardholder and can&apos;t be recalled.</p>
            <div className="dash-form-actions">
              <button
                type="button"
                ref={confirmRef}
                className="dash-button dash-button-danger-solid"
                disabled={submitting}
                onClick={() => void submit()}
              >
                {submitting ? "Refunding…" : <>Refund <Money fils={step.amountFils} /></>}
              </button>
              <button
                type="button"
                className="dash-button"
                disabled={submitting}
                onClick={() => setStep({ kind: "entering" })}
              >
                Change amount
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </RequireRole>
  );
}
