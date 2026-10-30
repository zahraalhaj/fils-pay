import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { cancelPaymentLink, listPaymentLinks } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { BUSINESS_TIME_ZONE_LABEL, bahrainDateTime, dash } from "../../format.js";
import { EmptyState, ErrorNotice, InfoNotice, Loading, SuccessNotice } from "../../ui/Feedback.js";
import { Money } from "../../ui/Money.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatusBadge, statusHelp } from "../../ui/StatusBadge.js";
import type { PaymentLinkDto } from "../../types.js";

/** The list endpoint's own maximum page size. */
const LOOKUP_LIMIT = 100;

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; link: PaymentLinkDto };

type CopyState = "idle" | "copied" | "failed";

/**
 * There is no merchant-authenticated `GET .../payment-links/:id` — the API
 * has the merchant-scoped *list* and the *public* single-token read, and nothing
 * in between. So this page reads the first page of the unfiltered list
 * (newest-first, capped at the endpoint's own 100-row maximum) and finds the
 * row by id.
 *
 * That is correct for a merchant with a normal number of links and genuinely
 * degrades for one whose direct-linked link has aged past row 100 — it will
 * render "not found" for a link that exists. The real fix is a one-row
 * backend route (`SELECT * ... WHERE id = $1 AND merchant_id = $2`, 404 on no
 * match).
 */
export function PaymentLinkDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const justCreated = Boolean((location.state as { created?: boolean } | null)?.created);
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [copy, setCopy] = useState<CopyState>("idle");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [canceledNotice, setCanceledNotice] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!merchantId || !id) return;
    try {
      const result = await listPaymentLinks(merchantId, { limit: LOOKUP_LIMIT });
      const found = result.paymentLinks.find((link) => link.id === id);
      setState(found ? { kind: "loaded", link: found } : { kind: "not_found" });
    } catch (err) {
      setState({ kind: "error", message: describeError(err) });
    }
  }, [merchantId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (confirmingCancel) keepButtonRef.current?.focus();
  }, [confirmingCancel]);

  function closeConfirm(): void {
    setConfirmingCancel(false);
    requestAnimationFrame(() => cancelTriggerRef.current?.focus());
  }

  async function handleCancel(): Promise<void> {
    if (!merchantId || !id || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await cancelPaymentLink(merchantId, id);
      setConfirmingCancel(false);
      setCanceledNotice(true);
      await load();
    } catch (err) {
      // Includes `409 not_cancelable` for a link that is paid, already
      // canceled, or `reserved` mid-payment-attempt.
      setActionError(describeError(err));
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("copied");
    } catch {
      // No clipboard permission (or no secure context): select the URL so a
      // manual copy is one keystroke away, and say so.
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
      setCopy("failed");
    }
  }

  const back = { to: "/dashboard/payment-links", label: "Payment links" };

  if (state.kind === "loading") {
    return (
      <section>
        <PageHeader back={back} title="Payment link" />
        <Loading label="Loading payment link…" />
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <PageHeader back={back} title="Payment link" />
        <ErrorNotice title="This payment link could not be loaded">
          {state.message}{" "}
          <button type="button" className="dash-button" onClick={() => { setState({ kind: "loading" }); void load(); }}>
            Try again
          </button>
        </ErrorNotice>
      </section>
    );
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <PageHeader back={back} title="Payment link not found" />
        <div className="dash-panel">
          <EmptyState title="We couldn't find this link">
            <p>
              It isn&apos;t among your {LOOKUP_LIMIT} most recent payment links.{" "}
              <Link to="/dashboard/payment-links">Back to payment links</Link>
            </p>
          </EmptyState>
        </div>
      </section>
    );
  }

  const { link } = state;
  const title = link.reference ? `Payment link ${link.reference}` : "Payment link";
  const expired = link.status === "active" && new Date(link.expiresAt).getTime() <= Date.now();

  return (
    <section>
      <PageHeader
        back={back}
        title={title}
        meta={
          <>
            <StatusBadge kind="link" status={link.status} />{" "}
            {expired ? <span className="dash-status dash-tone-neutral">Expired</span> : null}{" "}
            <span>{expired ? "The expiry time has passed, so customers can no longer pay this link." : statusHelp("link", link.status)}</span>
          </>
        }
        actions={
          link.transactionId ? (
            <Link className="dash-button-link dash-button-primary" to={`/dashboard/transactions/${link.transactionId}`}>
              View transaction
            </Link>
          ) : null
        }
      />

      {justCreated && link.status === "active" ? (
        <SuccessNotice title="Payment link created">Copy the link below and send it to your customer.</SuccessNotice>
      ) : null}
      {canceledNotice && link.status === "canceled" ? (
        <SuccessNotice title="Payment link canceled">Customers who open it will see that it is no longer available.</SuccessNotice>
      ) : null}
      {link.status === "reserved" ? (
        <InfoNotice title="A payment attempt is still being confirmed">
          Don&apos;t ask the customer to pay again yet. Check back shortly — once the attempt is resolved the link
          will show as paid or open again.
        </InfoNotice>
      ) : null}
      {actionError ? <ErrorNotice title="The link was not canceled">{actionError}</ErrorNotice> : null}

      <div className="dash-figures">
        <div className="dash-figure dash-figure-emphasis">
          <span className="dash-figure-label">Amount</span>
          <span className="dash-figure-value">
            <Money fils={link.amountFils} size="lg" />
          </span>
        </div>
        <div className="dash-figure">
          <span className="dash-figure-label">{link.paidAt ? "Paid" : "Expires"}</span>
          <span className="dash-figure-value">{bahrainDateTime(link.paidAt ?? link.expiresAt)}</span>
          <span className="dash-subtle">{BUSINESS_TIME_ZONE_LABEL}</span>
        </div>
      </div>

      <div className="dash-split">
        <div>
          {link.status === "active" && !expired ? (
            <div className="dash-panel">
              <h2>Share with your customer</h2>
              <p className="dash-muted">Anyone with this link can pay it until it expires or is canceled.</p>
              <div className="dash-copy">
                <label htmlFor="pl-url" className="dash-sr-only">
                  Checkout link
                </label>
                <input id="pl-url" ref={urlInputRef} readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="dash-button dash-button-primary" onClick={() => void handleCopy(link.url)}>
                  {copy === "copied" ? "Copied" : "Copy link"}
                </button>
                {/* Linked to, never duplicated — /pay/:token is the one checkout implementation. */}
                <a className="dash-button-link" href={link.url} target="_blank" rel="noreferrer">
                  Open checkout<span className="dash-sr-only"> (opens in a new tab)</span>
                </a>
              </div>
              <p className="dash-field-hint" role="status" aria-live="polite">
                {copy === "copied" ? "Link copied to your clipboard." : null}
                {copy === "failed" ? "Copying isn't available in this browser — the link is selected, so press Ctrl+C or ⌘C." : null}
              </p>
            </div>
          ) : null}

          <div className="dash-panel">
            <h2>Details</h2>
            <dl className="dash-dl">
              <dt>Reference</dt>
              <dd>{dash(link.reference)}</dd>
              <dt>Description</dt>
              <dd>{dash(link.description)}</dd>
              <dt>Created</dt>
              <dd>{bahrainDateTime(link.createdAt)}</dd>
              <dt>Expires</dt>
              <dd>{bahrainDateTime(link.expiresAt)}</dd>
              <dt>Paid</dt>
              <dd>{bahrainDateTime(link.paidAt)}</dd>
              <dt>Canceled</dt>
              <dd>{bahrainDateTime(link.canceledAt)}</dd>
              <dt>Transaction</dt>
              <dd>
                {link.transactionId ? (
                  <Link to={`/dashboard/transactions/${link.transactionId}`}>
                    <code>{link.transactionId}</code>
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
              <dt>Link ID</dt>
              <dd>
                <code>{link.id}</code>
              </dd>
            </dl>
            <p className="dash-field-hint">Times are shown in {BUSINESS_TIME_ZONE_LABEL}.</p>
          </div>
        </div>

        {link.status === "active" ? (
          <RequireRole allow={["owner", "finance"]}>
            <div className="dash-panel">
              <h2>Cancel link</h2>
              {confirmingCancel ? (
                <div
                  className="dash-confirm"
                  role="group"
                  aria-labelledby="pl-cancel-title"
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && !submitting) closeConfirm();
                  }}
                >
                  <h3 id="pl-cancel-title">Cancel this payment link?</h3>
                  <p>
                    Customers who open it will no longer be able to pay <Money fils={link.amountFils} />. This can&apos;t be
                    undone — you would need to create a new link.
                  </p>
                  <div className="dash-form-actions">
                    <button
                      type="button"
                      className="dash-button dash-button-danger-solid"
                      disabled={submitting}
                      onClick={() => void handleCancel()}
                    >
                      {submitting ? "Canceling…" : "Cancel link"}
                    </button>
                    <button type="button" ref={keepButtonRef} className="dash-button" disabled={submitting} onClick={closeConfirm}>
                      Keep link
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="dash-muted">Stop this link from being paid, for example if the order changed.</p>
                  <button
                    type="button"
                    ref={cancelTriggerRef}
                    className="dash-button dash-button-danger"
                    onClick={() => setConfirmingCancel(true)}
                  >
                    Cancel link…
                  </button>
                </>
              )}
            </div>
          </RequireRole>
        ) : null}
      </div>
    </section>
  );
}
