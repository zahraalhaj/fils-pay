import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listPaymentLinks } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { Pagination } from "../../components/Pagination.js";
import { BUSINESS_TIME_ZONE_LABEL, bahrainDateTime, dash } from "../../format.js";
import { EmptyState, ErrorNotice, Loading } from "../../ui/Feedback.js";
import { Money } from "../../ui/Money.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PAYMENT_LINK_STATUS, StatusBadge } from "../../ui/StatusBadge.js";
import type { PaymentLinkDto, PaymentLinkStatus } from "../../types.js";

/** The four *stored* statuses, including `reserved` — the merchant-facing
 *  list deliberately exposes it distinctly rather than collapsing it into the
 *  public enum's `processing`, because a merchant needs to see that a link is
 *  mid-payment-attempt. */
const STATUSES: PaymentLinkStatus[] = ["active", "reserved", "paid", "canceled"];

const PAGE_SIZE = 25;

/** Keyset paginated, newest first. Every filter is a server-side param. */
export function PaymentLinkListPage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [statuses, setStatuses] = useState<PaymentLinkStatus[]>([]);
  const [links, setLinks] = useState<PaymentLinkDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      if (!merchantId) return;
      setLoading(true);
      setError(null);
      try {
        const result = await listPaymentLinks(merchantId, {
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setLinks((previous) => (cursor ? [...previous, ...result.paymentLinks] : result.paymentLinks));
        setNextCursor(result.nextCursor);
        setLoadedOnce(true);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [merchantId, statuses],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: PaymentLinkStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  const createAction = (
    <RequireRole allow={["owner", "finance"]}>
      <Link className="dash-button-link dash-button-primary" to="/dashboard/payment-links/new">
        New payment link
      </Link>
    </RequireRole>
  );
  const filtered = statuses.length > 0;

  return (
    <section>
      <PageHeader
        title="Payment links"
        description="Links you send to customers so they can pay by card. Open a link to copy it, check its status or cancel it."
        actions={createAction}
      />

      <fieldset className="dash-filters">
        <legend>Filter by status</legend>
        <div className="dash-chips">
          {STATUSES.map((status) => (
            <label key={status} className="dash-chip">
              <input type="checkbox" checked={statuses.includes(status)} onChange={() => toggleStatus(status)} />
              {PAYMENT_LINK_STATUS[status].label}
            </label>
          ))}
        </div>
        {filtered ? (
          <button type="button" className="dash-button" onClick={() => setStatuses([])}>
            Clear filters
          </button>
        ) : null}
      </fieldset>

      {error ? (
        <ErrorNotice title="Payment links could not be loaded">
          {error}{" "}
          <button type="button" className="dash-button" onClick={() => void load(null)}>
            Try again
          </button>
        </ErrorNotice>
      ) : null}

      <div className="dash-toolbar">
        <span aria-live="polite">
          {loadedOnce ? `Showing ${links.length} link${links.length === 1 ? "" : "s"}${nextCursor ? " (more available)" : ""}` : ""}
        </span>
        <span>Times in {BUSINESS_TIME_ZONE_LABEL}</span>
      </div>

      <div className="dash-table-wrap" role="region" aria-label="Payment links" tabIndex={0}>
        <table className="dash-table">
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Description</th>
              <th scope="col" className="dash-num">Amount</th>
              <th scope="col">Status</th>
              <th scope="col">Expires</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <tr key={link.id}>
                <td>
                  <Link className="dash-row-link" to={`/dashboard/payment-links/${link.id}`}>
                    {link.reference ?? "No reference"}
                  </Link>
                </td>
                <td>{dash(link.description)}</td>
                <td className="dash-num">
                  <Money fils={link.amountFils} />
                </td>
                <td>
                  <StatusBadge kind="link" status={link.status} />
                </td>
                <td className="dash-nowrap">{bahrainDateTime(link.expiresAt)}</td>
                <td className="dash-nowrap">{bahrainDateTime(link.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && links.length === 0 ? <Loading label="Loading payment links…" /> : null}
        {!loading && !error && links.length === 0 ? (
          filtered ? (
            <EmptyState title="No links with these statuses">
              <p>
                <button type="button" className="dash-button" onClick={() => setStatuses([])}>
                  Clear filters
                </button>
              </p>
            </EmptyState>
          ) : (
            <EmptyState title="No payment links yet">
              <p>Create a link, send it to a customer, and their payment will appear here and under Transactions.</p>
              <p>{createAction}</p>
            </EmptyState>
          )
        ) : null}
      </div>

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
