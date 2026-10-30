import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listTransactions } from "../../api/transactions.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { BUSINESS_TIME_ZONE_LABEL, bahrainDateTime, dayStartIso } from "../../format.js";
import { truncateMiddle } from "../../utils/helpers.js";
import { EmptyState, ErrorNotice, Loading } from "../../ui/Feedback.js";
import { Money } from "../../ui/Money.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatusBadge, TRANSACTION_STATUS } from "../../ui/StatusBadge.js";
import type { TransactionDto, TransactionStatus } from "../../types.js";

const STATUSES: TransactionStatus[] = [
  "authorized",
  "captured",
  "partially_captured",
  "voided",
  "partially_refunded",
  "refunded",
  "chargeback",
];

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * `GET /v1/transactions`. Every control here is a real server-side
 * query param — nothing fetches an unfiltered page and narrows it in the
 * browser, which would both lie about the result count and break pagination.
 *
 * Dates: `from`/`to` are Asia/Bahrain day starts (see `dayStartIso`), and the
 * endpoint's predicate is `occurred_at < to` — so "To" is labelled as
 * exclusive rather than quietly shifted by a day here. Times in the table are
 * shown in the same Bahrain clock the filters use.
 */
export function TransactionListPage() {
  const [statuses, setStatuses] = useState<TransactionStatus[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce only the text box — the chip/date controls fire immediately,
  // since those are discrete choices, not a stream of keystrokes.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listTransactions({
          status: statuses.length > 0 ? statuses : undefined,
          from: dayStartIso(from),
          to: dayStartIso(to),
          search: search || undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setTransactions((previous) => (cursor ? [...previous, ...result.transactions] : result.transactions));
        setNextCursor(result.nextCursor);
        setLoadedOnce(true);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [statuses, from, to, search],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: TransactionStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  function clearFilters(): void {
    setStatuses([]);
    setFrom("");
    setTo("");
    setSearchInput("");
    setSearch("");
  }

  const filtered = statuses.length > 0 || from !== "" || to !== "" || search !== "";

  return (
    <section>
      <PageHeader title="Transactions" />

      <div className="dash-filters" role="search" aria-label="Filter transactions">
        <label className="dash-filter-field dash-filter-search" htmlFor="tx-search">
          Search
          <input
            id="tx-search"
            type="search"
            placeholder="Reference or transaction ID"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        <label className="dash-filter-field" htmlFor="tx-from">
          From
          <input id="tx-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="dash-filter-field" htmlFor="tx-to">
          Before
          <input id="tx-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <fieldset className="dash-filter-group dash-chips-fieldset">
          <legend className="dash-sr-only">Status</legend>
          <div className="dash-chips">
            {STATUSES.map((status) => (
              <label key={status} className="dash-chip">
                <input type="checkbox" checked={statuses.includes(status)} onChange={() => toggleStatus(status)} />
                {TRANSACTION_STATUS[status].label}
              </label>
            ))}
          </div>
        </fieldset>
        {filtered ? (
          <button type="button" className="dash-button dash-button-quiet" onClick={clearFilters}>
            Clear
          </button>
        ) : null}
      </div>

      {error ? (
        <ErrorNotice title="Transactions could not be loaded">
          {error}{" "}
          <button type="button" className="dash-button" onClick={() => void load(null)}>
            Try again
          </button>
        </ErrorNotice>
      ) : null}

      <div className="dash-table-wrap" role="region" aria-label="Transactions" tabIndex={0}>
        <table className="dash-table dash-rows">
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Time</th>
              <th scope="col">Status</th>
              <th scope="col" className="dash-num">Authorized</th>
              <th scope="col" className="dash-num">Captured</th>
              <th scope="col" className="dash-num">Refunded</th>
              <th scope="col">Bank reference</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((txn) => (
              <tr key={txn.id}>
                <td data-row="title">
                  <Link className="dash-row-link" to={`/dashboard/transactions/${txn.id}`}>
                    {txn.reference ?? "No reference"}
                  </Link>
                </td>
                <td className="dash-nowrap dash-cell-muted" data-row="meta">
                  {bahrainDateTime(txn.occurredAt)}
                </td>
                <td data-row="status">
                  <StatusBadge kind="transaction" status={txn.status} />
                </td>
                <td className="dash-num" data-row="amount">
                  <Money fils={txn.amountFils} />
                </td>
                <td className="dash-num" data-row="hide">
                  <Money fils={txn.capturedFils} />
                </td>
                <td className="dash-num" data-row="extra" data-label="Refunded">
                  {txn.refundedFils > 0 ? <Money fils={txn.refundedFils} /> : <span className="dash-muted">—</span>}
                </td>
                <td className="dash-cell-muted" data-row="hide">
                  <code title={txn.acquirerReference}>{truncateMiddle(txn.acquirerReference, 20)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && transactions.length === 0 ? <Loading label="Loading transactions…" /> : null}
        {!loading && !error && transactions.length === 0 ? (
          filtered ? (
            <EmptyState title="No transactions match these filters">
              <p>
                <button type="button" className="dash-button" onClick={clearFilters}>
                  Clear filters
                </button>
              </p>
            </EmptyState>
          ) : (
            <EmptyState title="No transactions yet">
              <p>Payments from your links appear here.</p>
              <RequireRole allow={["owner", "finance"]}>
                <p>
                  <Link className="dash-button-link dash-button-primary" to="/dashboard/payment-links/new">
                    Create a payment link
                  </Link>
                </p>
              </RequireRole>
            </EmptyState>
          )
        ) : null}
      </div>

      {loadedOnce && transactions.length > 0 ? (
        <div className="dash-toolbar dash-footnote">
          <span aria-live="polite">{nextCursor ? `${transactions.length} shown` : ""}</span>
          <span>Dates and times in {BUSINESS_TIME_ZONE_LABEL}</span>
        </div>
      ) : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
