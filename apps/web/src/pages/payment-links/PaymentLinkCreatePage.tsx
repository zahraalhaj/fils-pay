import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPaymentLink } from "../../api/paymentLinks.js";
import { ApiError, describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import {
  BUSINESS_TIME_ZONE_LABEL,
  bahrainDateTime,
  bhd,
  localDateTimeToIso,
  parseBhdInput,
} from "../../format.js";
import { ErrorNotice } from "../../ui/Feedback.js";
import { Money } from "../../ui/Money.js";
import { PageHeader } from "../../ui/PageHeader.js";

/**
 * `POST /v1/merchants/:merchantId/payment-links`, `owner`/`finance`
 * server-side.
 *
 * The amount is typed in BHD (what a merchant thinks in) and converted to
 * integer fils by the shared `parseBhdToFils` (via `parseBhdInput`) — no
 * second parser, no float. The request body is unchanged: `amountFils` is
 * still the integer the API has always received, and a live preview shows
 * both the formatted amount and the fils value before anything is sent.
 *
 * The client-side checks mirror the server's two real checks so an
 * obviously-bad value doesn't need a round trip. They are not the
 * validation: `400 invalid_amount` / `400 invalid_expiry` remain the real
 * answer and are shown against the matching field.
 */

type ExpiryPreset = "1" | "3" | "7" | "30" | "custom";
const PRESETS: Array<{ value: ExpiryPreset; label: string }> = [
  { value: "1", label: "In 24 hours" },
  { value: "3", label: "In 3 days" },
  { value: "7", label: "In 7 days" },
  { value: "30", label: "In 30 days" },
  { value: "custom", label: "On a date I choose" },
];

type Field = "amount" | "expiry";
type FieldErrors = Partial<Record<Field, string>>;

const AMOUNT_MESSAGES = {
  empty: "Enter the amount the customer should pay.",
  format: "Enter the amount in BHD with up to 3 decimal places, for example 18.500.",
  not_positive: "The amount must be more than 0.000 BHD.",
} as const;

function expiryIsoFor(preset: ExpiryPreset, custom: string): string | null {
  if (preset === "custom") return localDateTimeToIso(custom);
  return new Date(Date.now() + Number(preset) * 86_400_000).toISOString();
}

export function PaymentLinkCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  const [amountText, setAmountText] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [preset, setPreset] = useState<ExpiryPreset>("7");
  const [customExpiry, setCustomExpiry] = useState("");
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [serverFieldErrors, setServerFieldErrors] = useState<FieldErrors>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const amount = parseBhdInput(amountText);
  const expiryIso = expiryIsoFor(preset, customExpiry);

  const clientErrors: FieldErrors = useMemo(() => {
    const errors: FieldErrors = {};
    if (!amount.ok) errors.amount = AMOUNT_MESSAGES[amount.reason];
    if (!expiryIso) errors.expiry = "Choose the date and time the link should expire.";
    else if (new Date(expiryIso).getTime() <= Date.now()) errors.expiry = "The expiry must be in the future.";
    return errors;
  }, [amount, expiryIso]);

  // Errors appear once a field has been left (or on submit) and clear as soon
  // as the value is fixed.
  const visibleError = (field: Field): string | undefined =>
    serverFieldErrors[field] ?? (touched[field] || submitAttempted ? clientErrors[field] : undefined);
  const fieldInputId: Record<Field, string> = {
    amount: "pl-amount",
    expiry: preset === "custom" ? "pl-expiry-custom" : "pl-expiry",
  };
  const errorList = (["amount", "expiry"] as Field[])
    .map((field) => ({ field, message: visibleError(field) }))
    .filter((entry): entry is { field: Field; message: string } => Boolean(entry.message));

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me || submitting) return;
    setError(null);
    setServerFieldErrors({});
    setSubmitAttempted(true);

    if (!amount.ok || !expiryIso || Object.keys(clientErrors).length > 0) {
      // Move focus to the summary so keyboard and screen-reader users land on it.
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    setSubmitting(true);
    try {
      const link = await createPaymentLink(me.merchant.id, {
        amountFils: amount.fils,
        reference: reference.trim() || undefined,
        description: description.trim() || undefined,
        expiresAt: expiryIso,
      });
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true, state: { created: true } });
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_amount") {
        setServerFieldErrors({ amount: err.body.message ?? "This amount was not accepted." });
        requestAnimationFrame(() => summaryRef.current?.focus());
      } else if (err instanceof ApiError && err.code === "invalid_expiry") {
        setServerFieldErrors({ expiry: err.body.message ?? "This expiry was not accepted." });
        requestAnimationFrame(() => summaryRef.current?.focus());
      } else {
        setError(describeError(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const amountError = visibleError("amount");
  const expiryError = visibleError("expiry");
  const showSummary = errorList.length > 0 && (submitAttempted || Object.keys(serverFieldErrors).length > 0);

  return (
    <section>
      <PageHeader
        back={{ to: "/dashboard/payment-links", label: "Payment links" }}
        title="New payment link"
        description="Create a link your customer opens to pay by card. Payments here use the simulated test acquirer — no real card is charged."
      />

      <div className="dash-split">
        <div className="dash-panel">
          {showSummary ? (
            <div className="dash-error-summary" role="alert" tabIndex={-1} ref={summaryRef}>
              <h2>{errorList.length === 1 ? "Fix 1 field to continue" : `Fix ${errorList.length} fields to continue`}</h2>
              <ul>
                {errorList.map(({ field, message }) => (
                  <li key={field}>
                    <a
                      href={`#${fieldInputId[field]}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(fieldInputId[field])?.focus();
                      }}
                    >
                      {message}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {error ? <ErrorNotice title="The link was not created">{error}</ErrorNotice> : null}

          <form className="dash-form" noValidate onSubmit={(e) => void handleSubmit(e)}>
            <div className="dash-field">
              <label htmlFor="pl-amount">Amount (BHD)</label>
              <span className="dash-field-hint" id="pl-amount-hint">
                Up to 3 decimal places, for example 18.500. 1 BHD = 1,000 fils.
              </span>
              <div className="dash-input-affix">
                <input
                  id="pl-amount"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.000"
                  value={amountText}
                  aria-invalid={amountError ? true : undefined}
                  aria-describedby={`pl-amount-hint pl-amount-preview${amountError ? " pl-amount-error" : ""}`}
                  onChange={(e) => {
                    setAmountText(e.target.value);
                    setServerFieldErrors((prev) => ({ ...prev, amount: undefined }));
                  }}
                  onBlur={() => setTouched((t) => ({ ...t, amount: true }))}
                />
                <span aria-hidden="true">BHD</span>
              </div>
              {amountError ? (
                <span className="dash-field-error" id="pl-amount-error">
                  {amountError}
                </span>
              ) : null}
              <span className="dash-field-hint" id="pl-amount-preview" aria-live="polite">
                {amount.ok ? (
                  <>
                    Customer pays <strong>{bhd(amount.fils)}</strong> ({amount.fils.toLocaleString("en-GB")} fils)
                  </>
                ) : null}
              </span>
            </div>

            <div className="dash-field">
              <label htmlFor="pl-reference">Reference (optional)</label>
              <span className="dash-field-hint" id="pl-reference-hint">
                Your invoice or order number. Shown to the customer and on the transaction.
              </span>
              <input
                id="pl-reference"
                type="text"
                autoComplete="off"
                value={reference}
                aria-describedby="pl-reference-hint"
                onChange={(e) => setReference(e.target.value)}
              />
            </div>

            <div className="dash-field">
              <label htmlFor="pl-description">Description (optional)</label>
              <span className="dash-field-hint" id="pl-description-hint">
                What the customer is paying for. Shown on the checkout page.
              </span>
              <input
                id="pl-description"
                type="text"
                autoComplete="off"
                value={description}
                aria-describedby="pl-description-hint"
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="dash-field">
              <label htmlFor="pl-expiry">Link expires</label>
              <select
                id="pl-expiry"
                value={preset}
                aria-describedby="pl-expiry-summary"
                aria-invalid={expiryError && preset !== "custom" ? true : undefined}
                onChange={(e) => {
                  setPreset(e.target.value as ExpiryPreset);
                  setServerFieldErrors((prev) => ({ ...prev, expiry: undefined }));
                }}
              >
                {PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {preset === "custom" ? (
              <div className="dash-field">
                <label htmlFor="pl-expiry-custom">Expiry date and time</label>
                <span className="dash-field-hint" id="pl-expiry-custom-hint">
                  Entered in your device&apos;s time zone.
                </span>
                <input
                  id="pl-expiry-custom"
                  type="datetime-local"
                  value={customExpiry}
                  aria-invalid={expiryError ? true : undefined}
                  aria-describedby="pl-expiry-custom-hint pl-expiry-summary"
                  onChange={(e) => {
                    setCustomExpiry(e.target.value);
                    setServerFieldErrors((prev) => ({ ...prev, expiry: undefined }));
                  }}
                  onBlur={() => setTouched((t) => ({ ...t, expiry: true }))}
                />
              </div>
            ) : null}

            <span
              id="pl-expiry-summary"
              className={expiryError ? "dash-field-error dash-hint" : "dash-field-hint dash-hint"}
            >
              {expiryError
                ? expiryError
                : expiryIso
                  ? `Expires ${bahrainDateTime(expiryIso)} (${BUSINESS_TIME_ZONE_LABEL}).`
                  : null}
            </span>

            <div className="dash-form-actions">
              <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                {submitting ? "Creating link…" : "Create payment link"}
              </button>
              <Link className="dash-button-link" to="/dashboard/payment-links">
                Cancel
              </Link>
            </div>
          </form>
        </div>

        <aside className="dash-panel" aria-labelledby="pl-preview-heading">
          <h2 id="pl-preview-heading">Checkout preview</h2>
          <p className="dash-muted">{me?.merchant.displayName ?? "Your business"}</p>
          {amount.ok ? (
            <p>
              <Money fils={amount.fils} size="lg" />
            </p>
          ) : (
            <p className="dash-muted">Enter an amount to see it here.</p>
          )}
          {description.trim() ? <p>{description.trim()}</p> : null}
          {reference.trim() ? <p className="dash-muted">Reference {reference.trim()}</p> : null}
          <p className="dash-muted">Once the link is created you can copy it and send it to your customer.</p>
        </aside>
      </div>
    </section>
  );
}
