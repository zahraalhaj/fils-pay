import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  captureTransaction,
  getTransaction,
  getTransactionEvents,
  voidTransaction,
} from "../../api/transactions.js";
import { ApiError, describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { RefundDrawer } from "./RefundDrawer.js";
import { BUSINESS_TIME_ZONE_LABEL, bahrainDateTime, bhd, dash, parseBhdInput } from "../../format.js";
import { EmptyState, ErrorNotice, Loading, SuccessNotice } from "../../ui/Feedback.js";
import { Money } from "../../ui/Money.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatusBadge, statusHelp } from "../../ui/StatusBadge.js";
import type { TransactionDto, TransactionEventDto } from "../../types.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; txn: TransactionDto };

const EVENT_LABEL: Record<string, string> = {
  authorized: "Payment authorized",
  captured: "Payment captured",
  voided: "Authorization voided",
  refunded: "Refund issued",
  refund: "Refund issued",
  chargeback: "Chargeback received",
};

const ACTOR_LABEL: Record<string, string> = {
  system: "FilsPay",
  merchant_session: "Dashboard user",
  merchant_api_key: "API key",
  admin: "FilsPay staff",
};

/**
 * `GET /v1/transactions/:id` plus its event timeline on the same page.
 *
 * A `404` renders a plain "not found" state and never tries to distinguish
 * "doesn't exist" from "not yours": the API deliberately answers the same way
 * for both (a `403` would confirm a foreign transaction's existence), and
 * this page does not undo that by guessing.
 */
export function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [events, setEvents] = useState<TransactionEventDto[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [panel, setPanel] = useState<"none" | "capture" | "void">("none");
  const [captureAmount, setCaptureAmount] = useState("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const firstControlRef = useRef<HTMLInputElement & HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    try {
      // Two independent reads — the events route does its own merchant-scoped
      // existence check, so neither depends on the other's result.
      const [txn, timeline] = await Promise.all([getTransaction(id), getTransactionEvents(id)]);
      setState({ kind: "loaded", txn });
      setEvents(timeline);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        setState({ kind: "not_found" });
      } else {
        setState({ kind: "error", message: describeError(err) });
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (panel !== "none") firstControlRef.current?.focus();
  }, [panel]);

  async function handleCapture(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id || submitting) return;
    const trimmed = captureAmount.trim();
    let input: { amountFils?: number } = {};
    // Left blank, `amountFils` is omitted entirely and capture.ts captures
    // everything still outstanding — its own documented default.
    if (trimmed !== "") {
      const parsed = parseBhdInput(trimmed);
      if (!parsed.ok) {
        setCaptureError("Enter the amount in BHD with up to 3 decimal places, or leave it blank to capture everything.");
        return;
      }
      input = { amountFils: parsed.fils };
    }
    setSubmitting(true);
    setActionError(null);
    setNotice(null);
    try {
      // A fresh Idempotency-Key per click — same discipline as checkout.
      const result = await captureTransaction(id, input, crypto.randomUUID());
      setPanel("none");
      setCaptureAmount("");
      setNotice(`Capture recorded. Captured so far: ${bhd(result.capturedFils)}.`);
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Only offered while status is authorized. */
  async function handleVoid(): Promise<void> {
    if (!id || submitting) return;
    setSubmitting(true);
    setActionError(null);
    setNotice(null);
    try {
      // An already-voided transaction also answers `200` — both mean "now voided".
      await voidTransaction(id);
      setPanel("none");
      setNotice("Authorization voided. The held funds are released to the customer.");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const back = { to: "/dashboard/transactions", label: "Transactions" };

  if (state.kind === "loading") {
    return (
      <section>
        <PageHeader back={back} title="Transaction" />
        <Loading label="Loading transaction…" />
      </section>
    );
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <PageHeader back={back} title="Transaction not found" />
        <div className="dash-panel">
          <EmptyState title="No transaction with this ID exists on your account">
            <p>
              <Link to="/dashboard/transactions">Back to transactions</Link>
            </p>
          </EmptyState>
        </div>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <PageHeader back={back} title="Transaction" />
        <ErrorNotice title="This transaction could not be loaded">
          {state.message}{" "}
          <button type="button" className="dash-button" onClick={() => { setState({ kind: "loading" }); void load(); }}>
            Try again
          </button>
        </ErrorNotice>
      </section>
    );
  }

  const { txn } = state;
  const capturable = txn.status === "authorized" || txn.status === "partially_captured";
  const voidable = txn.status === "authorized";
  const refundableFils = txn.capturedFils - txn.refundedFils;

  return (
    <section>
      <PageHeader
        back={back}
        title={txn.reference ? `Transaction ${txn.reference}` : "Transaction"}
        meta={
          <>
            <StatusBadge kind="transaction" status={txn.status} /> <span>{statusHelp("transaction", txn.status)}</span>
          </>
        }
      />

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      {actionError ? <ErrorNotice title="That action didn't go through">{actionError}</ErrorNotice> : null}

      <div className="dash-figures">
        <div className="dash-figure">
          <span className="dash-figure-label">Authorized</span>
          <span className="dash-figure-value">
            <Money fils={txn.amountFils} />
          </span>
        </div>
        <div className="dash-figure dash-figure-emphasis">
          <span className="dash-figure-label">Captured</span>
          <span className="dash-figure-value">
            <Money fils={txn.capturedFils} />
          </span>
        </div>
        <div className="dash-figure">
          <span className="dash-figure-label">Refunded</span>
          <span className="dash-figure-value">
            <Money fils={txn.refundedFils} />
          </span>
        </div>
        {txn.capturedFils > 0 ? (
          <div className="dash-figure">
            <span className="dash-figure-label">Left to refund</span>
            <span className="dash-figure-value">
              <Money fils={refundableFils} />
            </span>
          </div>
        ) : null}
      </div>

      <div className="dash-split dash-split-actions-first">
        <div>
          <div className="dash-panel">
            <div className="dash-panel-header">
              <h2>Timeline</h2>
              <span className="dash-muted">{BUSINESS_TIME_ZONE_LABEL}</span>
            </div>
            {/* Already ordered oldest-first by the endpoint — never re-sorted
                here, so the page can't disagree with the API about history. */}
            {events.length === 0 ? (
              <EmptyState title="No events recorded" />
            ) : (
              <ol className="dash-timeline">
                {events.map((event) => (
                  <li key={event.id}>
                    <span className="dash-timeline-title">{EVENT_LABEL[event.eventType] ?? event.eventType.replace(/_/g, " ")}</span>
                    <span className="ui-money">{event.amountFils === null ? "" : <Money fils={event.amountFils} />}</span>
                    <span className="dash-timeline-meta">
                      {bahrainDateTime(event.occurredAt)} · {ACTOR_LABEL[event.actorType] ?? event.actorType}
                      {event.actorId ? (
                        <>
                          {" "}
                          <code>{event.actorId}</code>
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="dash-panel">
            <h2>Details</h2>
            <dl className="dash-dl">
              <dt>Reference</dt>
              <dd>{dash(txn.reference)}</dd>
              <dt>Time</dt>
              <dd>
                {bahrainDateTime(txn.occurredAt)} ({BUSINESS_TIME_ZONE_LABEL})
              </dd>
              <dt>Currency</dt>
              <dd>{txn.currency}</dd>
              <dt>Bank reference</dt>
              <dd>
                <code>{txn.acquirerReference}</code>
              </dd>
              <dt>Transaction ID</dt>
              <dd>
                <code>{txn.id}</code>
              </dd>
              <dt>Recorded</dt>
              <dd>{bahrainDateTime(txn.createdAt)}</dd>
            </dl>
          </div>
        </div>

        <div>
          {/* Capture and void are hidden from `support` as a UX choice — a
              support agent looks things up, they don't move money. Unlike the
              reconciliation page, this hide is NOT backed by a matching
              server-side role check: the API gates capture/void at "any
              authenticated merchant actor". Do not mistake a hidden button
              here for a security boundary. */}
          <RequireRole allow={["owner", "finance"]}>
            {capturable || voidable ? (
              <div className="dash-panel">
                <h2>Authorization</h2>
                {panel === "none" ? (
                  <>
                    <p className="dash-muted">
                      <Money fils={txn.amountFils - txn.capturedFils} /> is held on the customer&apos;s card and not
                      yet collected.
                    </p>
                    <div className="dash-form-actions">
                      {capturable ? (
                        <button type="button" className="dash-button dash-button-primary" onClick={() => setPanel("capture")}>
                          Capture…
                        </button>
                      ) : null}
                      {voidable ? (
                        <button type="button" className="dash-button dash-button-danger" onClick={() => setPanel("void")}>
                          Void…
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}

                {panel === "capture" ? (
                  <form className="dash-form" noValidate onSubmit={(e) => void handleCapture(e)}>
                    <div className="dash-field">
                      <label htmlFor="capture-amount">Capture amount (BHD)</label>
                      <span className="dash-field-hint" id="capture-amount-hint">
                        Leave blank to capture everything still held.
                      </span>
                      <div className="dash-input-affix">
                        <input
                          id="capture-amount"
                          ref={firstControlRef}
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0.000"
                          value={captureAmount}
                          aria-invalid={captureError ? true : undefined}
                          aria-describedby={`capture-amount-hint${captureError ? " capture-amount-error" : ""}`}
                          onChange={(e) => {
                            setCaptureAmount(e.target.value);
                            setCaptureError(null);
                          }}
                        />
                        <span aria-hidden="true">BHD</span>
                      </div>
                      {captureError ? (
                        <span className="dash-field-error" id="capture-amount-error" role="alert">
                          {captureError}
                        </span>
                      ) : null}
                    </div>
                    <div className="dash-form-actions">
                      <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                        {submitting ? "Capturing…" : "Capture payment"}
                      </button>
                      <button type="button" className="dash-button" disabled={submitting} onClick={() => setPanel("none")}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                {panel === "void" ? (
                  <div
                    className="dash-confirm"
                    role="group"
                    aria-labelledby="void-title"
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && !submitting) setPanel("none");
                    }}
                  >
                    <h3 id="void-title">Void {txn.reference ? `authorization ${txn.reference}` : "this authorization"}?</h3>
                    <p>
                      The held <Money fils={txn.amountFils} /> is released to the customer and can&apos;t be captured
                      afterwards.
                    </p>
                    <div className="dash-form-actions">
                      <button
                        type="button"
                        className="dash-button dash-button-danger-solid"
                        disabled={submitting}
                        onClick={() => void handleVoid()}
                      >
                        {submitting ? "Voiding…" : "Void authorization"}
                      </button>
                      <button
                        type="button"
                        ref={firstControlRef}
                        className="dash-button"
                        disabled={submitting}
                        onClick={() => setPanel("none")}
                      >
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </RequireRole>

          <RefundDrawer txn={txn} onRefunded={load} />
        </div>
      </div>
    </section>
  );
}
