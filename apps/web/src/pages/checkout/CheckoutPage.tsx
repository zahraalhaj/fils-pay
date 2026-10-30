import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import { BUSINESS_TIME_ZONE_LABEL, bahrainDateTime } from "../../format.js";
import { Money } from "../../ui/Money.js";
import type { PaymentLinkPublicDto, PayPaymentLinkResponse, SimulatedCardInput } from "../../types.js";
import "./CheckoutPage.css";

/*
 * Public checkout: /pay/:token. Makes no dashboard auth calls — only the
 * public link read and the pay call, exactly as before.
 *
 * Outcome model (mirrors apps/api/src/paymentLinks/pay.ts):
 *   - 200                 → paid.
 *   - 402                 → a definite decline; the server released the link,
 *                           so trying again (or another card) is safe.
 *   - 409 already_paid / canceled, 410 expired → terminal.
 *   - 409 processing, any 5xx (e.g. 502 acquirer_unavailable), or a network
 *     failure with no response → NOT CONFIRMED. The server keeps the link
 *     reserved because "a timeout/error cannot prove that no charge
 *     occurred", so this is shown as an uncertain state with a status check,
 *     never as a failure with a retry form.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "load_error" }
  | { kind: "loaded"; link: PaymentLinkPublicDto };

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: PayPaymentLinkResponse }
  | { kind: "declined"; title: string; message: string }
  | { kind: "terminal"; title: string; message: string }
  | { kind: "uncertain"; reason: "no_answer" | "in_progress" };

const DECLINE_REASON: Record<string, string> = {
  do_not_honor: "Your bank declined this payment.",
  insufficient_funds: "Your card doesn't have enough available funds.",
};

const thisYear = new Date().getFullYear();
const EMPTY_CARD: SimulatedCardInput = { pan: "", expiryMonth: 1, expiryYear: thisYear + 1, cvv: "" };
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const YEARS = Array.from({ length: 12 }, (_, i) => thisYear + i);

type CardErrors = Partial<Record<"pan" | "cvv", string>>;

function validateCard(card: SimulatedCardInput): CardErrors {
  const errors: CardErrors = {};
  const pan = card.pan.replace(/[\s-]/g, "");
  if (pan === "") errors.pan = "Enter your card number.";
  else if (!/^\d+$/.test(pan)) errors.pan = "Card number can only contain digits.";
  if (card.cvv.trim() === "") errors.cvv = "Enter the 3 or 4 digit security code.";
  else if (!/^\d{3,4}$/.test(card.cvv.trim())) errors.cvv = "The security code is 3 or 4 digits.";
  return errors;
}

function classifyPayError(err: unknown): PayState {
  if (!(err instanceof ApiError)) {
    // No HTTP answer at all (connection dropped, timeout): the request may
    // have reached the server, so the outcome is unknown.
    return { kind: "uncertain", reason: "no_answer" };
  }
  const { statusCode, body } = err;
  if (statusCode === 402) {
    const reason = typeof body.declineReason === "string" ? DECLINE_REASON[body.declineReason] : undefined;
    return {
      kind: "declined",
      title: body.stage === "capture" ? "Payment not completed" : "Card declined",
      message: `${reason ?? (body.stage === "capture" ? "Your payment could not be completed." : "Your card was declined.")} Try again or use a different card.`,
    };
  }
  if (statusCode === 409 && body.error === "payment_link_already_paid") {
    return { kind: "terminal", title: "Already paid", message: "This payment has already been made. You don't need to pay again." };
  }
  if (statusCode === 409 && body.error === "payment_link_canceled") {
    return { kind: "terminal", title: "Link no longer available", message: "The merchant canceled this payment link. Contact them if you still need to pay." };
  }
  if (statusCode === 410) {
    return { kind: "terminal", title: "Link expired", message: "This payment link has expired. Ask the merchant to send you a new one." };
  }
  if (statusCode === 409) {
    // payment_link_processing (or another state conflict): an attempt holds the link.
    return { kind: "uncertain", reason: "in_progress" };
  }
  if (statusCode === 403) {
    return { kind: "terminal", title: "Payment not available", message: "This merchant can't accept payments right now. Contact them to arrange payment." };
  }
  if (statusCode >= 500) {
    return { kind: "uncertain", reason: "no_answer" };
  }
  // Other 4xx: the request was rejected before any charge was attempted.
  return { kind: "declined", title: "Check your details", message: "We couldn't process those card details. Check them and try again." };
}

/** Page frame shared by every checkout state. Defined at module level so it
 *  keeps its identity across renders (inputs inside never remount). */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="checkout-shell">
      <p className="checkout-test-banner">
        <strong>Test mode.</strong> Payments use a simulated acquirer — no real card is charged.
      </p>
      <main className="checkout-page">{children}</main>
      <p className="checkout-footer">Payment page provided by FilsPay</p>
    </div>
  );
}

export function CheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [card, setCard] = useState<SimulatedCardInput>(EMPTY_CARD);
  const [cardErrors, setCardErrors] = useState<CardErrors>({});
  const [brandHint, setBrandHint] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const fetchLink = useCallback(async (): Promise<LoadState> => {
    if (!token) return { kind: "not_found" };
    try {
      return { kind: "loaded", link: await getPaymentLink(token) };
    } catch (err) {
      // Never distinguishes "malformed token" from "doesn't exist" — matches
      // the API's own non-disclosure choice. A server or network failure is
      // not "not found", though: it gets a retry.
      if (err instanceof ApiError && err.statusCode < 500) return { kind: "not_found" };
      return { kind: "load_error" };
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void fetchLink().then((state) => {
      if (!cancelled) setLoadState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchLink]);

  // Move focus to the new heading whenever the outcome screen changes, so
  // screen-reader and keyboard users hear the result.
  useEffect(() => {
    if (payState.kind === "success" || payState.kind === "terminal" || payState.kind === "uncertain") {
      headingRef.current?.focus();
    }
    if (payState.kind === "declined") alertRef.current?.focus();
  }, [payState.kind]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token || payState.kind === "submitting") return;
    const errors = validateCard(card);
    setCardErrors(errors);
    if (Object.keys(errors).length > 0) {
      document.getElementById(errors.pan ? "co-pan" : "co-cvv")?.focus();
      return;
    }

    // A fresh Idempotency-Key per explicit user action — every click,
    // including a "try again" after a decline, is a new attempt.
    const idempotencyKey = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    setPayState({ kind: "submitting" });

    try {
      const result = await payPaymentLink(token, { card, submittedAt }, idempotencyKey);
      setPayState({ kind: "success", result });
    } catch (err) {
      const next = classifyPayError(err);
      if (next.kind === "declined") setCard((c) => ({ ...c, cvv: "" }));
      setPayState(next);
    }
  }

  /** Re-reads the public link to learn how an unconfirmed attempt resolved. */
  async function checkStatus(): Promise<void> {
    setChecking(true);
    const state = await fetchLink();
    setChecking(false);
    setLastChecked(new Date());
    if (state.kind !== "loaded") return; // keep showing the uncertain state
    setLoadState(state);
    const status = state.link.status;
    if (status === "processing") return;
    if (status === "active") {
      setCard({ ...EMPTY_CARD });
      setPayState({ kind: "idle" });
      return;
    }
    // paid / expired / canceled are rendered from the link status below.
    setPayState({ kind: "idle" });
  }

  if (loadState.kind === "loading") {
    return (
      <Shell>
        <div className="checkout-card" aria-busy="true">
          <p className="checkout-loading" role="status">
            <span className="checkout-spinner" aria-hidden="true" /> Loading payment details…
          </p>
        </div>
      </Shell>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <Shell>
        <div className="checkout-card checkout-outcome">
          <h1>Payment link not found</h1>
          <p>Check that you opened the full link the merchant sent you, or ask them for a new one.</p>
        </div>
      </Shell>
    );
  }

  if (loadState.kind === "load_error") {
    return (
      <Shell>
        <div className="checkout-card checkout-outcome">
          <h1>We couldn&apos;t load this payment</h1>
          <p>Check your internet connection and try again. You have not been charged.</p>
          <button
            type="button"
            className="checkout-button"
            onClick={() => {
              setLoadState({ kind: "loading" });
              void fetchLink().then(setLoadState);
            }}
          >
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  const { link } = loadState;
  const summary = (
    <header className="checkout-summary">
      <p className="checkout-merchant">{link.merchantDisplayName}</p>
      <p className="checkout-amount">
        <span className="checkout-sr">Amount due: </span>
        <Money fils={link.amountFils} size="lg" />
      </p>
      {link.description ? <p className="checkout-description">{link.description}</p> : null}
      {link.reference ? <p className="checkout-reference">Reference {link.reference}</p> : null}
    </header>
  );

  if (payState.kind === "success") {
    return (
      <Shell>
        <div className="checkout-card checkout-outcome checkout-outcome-success">
          <span className="checkout-icon" aria-hidden="true">✓</span>
          <h1 tabIndex={-1} ref={headingRef}>
            Payment successful
          </h1>
          <p>
            You paid <Money fils={payState.result.amountFils} /> to {link.merchantDisplayName}. This was a test payment
            — no real money moved.
          </p>
          <dl className="checkout-receipt">
            {link.reference ? (
              <>
                <dt>Reference</dt>
                <dd>{link.reference}</dd>
              </>
            ) : null}
            <dt>Paid</dt>
            <dd>
              {bahrainDateTime(payState.result.paidAt)} ({BUSINESS_TIME_ZONE_LABEL})
            </dd>
            <dt>Transaction ID</dt>
            <dd>
              <code>{payState.result.transactionId}</code>
            </dd>
          </dl>
          <p className="checkout-muted">Keep the transaction ID if you need to contact the merchant. You can close this page.</p>
        </div>
      </Shell>
    );
  }

  if (payState.kind === "terminal") {
    return (
      <Shell>
        <div className="checkout-card checkout-outcome">
          {summary}
          <h1 tabIndex={-1} ref={headingRef}>
            {payState.title}
          </h1>
          <p>{payState.message}</p>
        </div>
      </Shell>
    );
  }

  const uncertain = payState.kind === "uncertain" || link.status === "processing";
  if (uncertain) {
    const noAnswer = payState.kind === "uncertain" && payState.reason === "no_answer";
    return (
      <Shell>
        <div className="checkout-card checkout-outcome checkout-outcome-pending">
          {summary}
          <span className="checkout-icon" aria-hidden="true">…</span>
          <h1 tabIndex={-1} ref={headingRef}>
            {noAnswer ? "We couldn't confirm your payment" : "Payment being confirmed"}
          </h1>
          <p>
            {noAnswer
              ? "The payment provider didn't give us a final answer, so we can't tell yet whether your card was charged."
              : "A payment for this link has started and its result isn't confirmed yet."}
          </p>
          <p>
            <strong>Please don&apos;t pay again.</strong> Check the status in a moment — the merchant can also see this
            attempt{link.reference ? ` under reference ${link.reference}` : ""}.
          </p>
          <button type="button" className="checkout-button" disabled={checking} onClick={() => void checkStatus()}>
            {checking ? "Checking…" : "Check payment status"}
          </button>
          <p className="checkout-muted" role="status" aria-live="polite">
            {lastChecked && !checking ? `Still not confirmed as of ${lastChecked.toLocaleTimeString()}.` : null}
          </p>
        </div>
      </Shell>
    );
  }

  if (link.status === "paid") {
    return (
      <Shell>
        <div className="checkout-card checkout-outcome checkout-outcome-success">
          {summary}
          <h1 tabIndex={-1} ref={headingRef}>
            Already paid
          </h1>
          <p>This payment has already been made. You don&apos;t need to pay again.</p>
        </div>
      </Shell>
    );
  }
  if (link.status === "expired") {
    return (
      <Shell>
        <div className="checkout-card checkout-outcome">
          {summary}
          <h1>Link expired</h1>
          <p>This payment link has expired. Ask the merchant to send you a new one.</p>
        </div>
      </Shell>
    );
  }
  if (link.status === "canceled") {
    return (
      <Shell>
        <div className="checkout-card checkout-outcome">
          {summary}
          <h1>Link no longer available</h1>
          <p>The merchant canceled this payment link. Contact them if you still need to pay.</p>
        </div>
      </Shell>
    );
  }

  // link.status === 'active'
  const submitting = payState.kind === "submitting";

  return (
    <Shell>
      <div className="checkout-card">
        {summary}

        <h1 className="checkout-form-title">Pay by card</h1>

        {payState.kind === "declined" ? (
          <div className="checkout-alert" role="alert" tabIndex={-1} ref={alertRef}>
            <strong>{payState.title}.</strong> {payState.message}
          </div>
        ) : null}

        <form onSubmit={(e) => void handleSubmit(e)} className="checkout-form" noValidate aria-busy={submitting}>
          <fieldset disabled={submitting} className="checkout-fieldset">
            <legend className="checkout-sr">Card details</legend>
            <div className="checkout-field">
              <label htmlFor="co-pan">Card number</label>
              <div className="checkout-pan">
                <input
                  id="co-pan"
                  type="text"
                  inputMode="numeric"
                  autoComplete="cc-number"
                  placeholder="1234 5678 9012 3456"
                  value={card.pan}
                  aria-invalid={cardErrors.pan ? true : undefined}
                  aria-describedby={cardErrors.pan ? "co-pan-error" : undefined}
                  onChange={(e) => {
                    const pan = e.target.value;
                    setCard({ ...card, pan });
                    if (cardErrors.pan) setCardErrors((c) => ({ ...c, pan: undefined }));
                    const digits = pan.replace(/\D/g, "");
                    if (digits.length >= 4) {
                      void import("../../utils/helpers.js").then((m) => {
                        setBrandHint(m.formatCardBrandHint(digits));
                      });
                    } else {
                      setBrandHint(null);
                    }
                  }}
                />
                {brandHint && brandHint !== "unknown" ? (
                  <span className="checkout-brand-hint" aria-label={`Card type: ${brandHint}`}>
                    {brandHint}
                  </span>
                ) : null}
              </div>
              {cardErrors.pan ? (
                <span className="checkout-field-error" id="co-pan-error">
                  {cardErrors.pan}
                </span>
              ) : null}
            </div>

            <div className="checkout-form-row">
              <div className="checkout-field">
                <label htmlFor="co-month">Expiry month</label>
                <select
                  id="co-month"
                  autoComplete="cc-exp-month"
                  value={card.expiryMonth}
                  onChange={(e) => setCard({ ...card, expiryMonth: Number(e.target.value) })}
                >
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>
                      {String(m).padStart(2, "0")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="checkout-field">
                <label htmlFor="co-year">Expiry year</label>
                <select
                  id="co-year"
                  autoComplete="cc-exp-year"
                  value={card.expiryYear}
                  onChange={(e) => setCard({ ...card, expiryYear: Number(e.target.value) })}
                >
                  {YEARS.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
              <div className="checkout-field">
                <label htmlFor="co-cvv">Security code</label>
                <input
                  id="co-cvv"
                  type="text"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  maxLength={4}
                  placeholder="CVV"
                  value={card.cvv}
                  aria-invalid={cardErrors.cvv ? true : undefined}
                  aria-describedby={cardErrors.cvv ? "co-cvv-error" : undefined}
                  onChange={(e) => {
                    setCard({ ...card, cvv: e.target.value });
                    if (cardErrors.cvv) setCardErrors((c) => ({ ...c, cvv: undefined }));
                  }}
                />
              </div>
            </div>
            {cardErrors.cvv ? (
              <span className="checkout-field-error" id="co-cvv-error">
                {cardErrors.cvv}
              </span>
            ) : null}
          </fieldset>

          <button type="submit" className="checkout-button checkout-pay" disabled={submitting}>
            {submitting ? (
              <>
                <span className="checkout-spinner" aria-hidden="true" /> Processing payment…
              </>
            ) : (
              <>
                Pay&nbsp;<Money fils={link.amountFils} />
              </>
            )}
          </button>
          <p className="checkout-muted checkout-center" role="status" aria-live="polite">
            {submitting ? "Don't close or refresh this page." : null}
          </p>
        </form>

        <details className="checkout-help">
          <summary>Test card numbers</summary>
          <p>Use any expiry date and any 3-digit security code. The card number&apos;s last four digits decide the result:</p>
          <ul>
            <li>
              Ending <code>0002</code> — declined (do not honor)
            </li>
            <li>
              Ending <code>0119</code> — declined (insufficient funds)
            </li>
            <li>
              Ending <code>0069</code> — provider error; the result can&apos;t be confirmed
            </li>
            <li>Any other number — approved</li>
          </ul>
        </details>
      </div>
    </Shell>
  );
}
