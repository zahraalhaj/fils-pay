import { useEffect, useId, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { describeError } from "../api/client.js";
import { ErrorNotice } from "../ui/Feedback.js";
import "../dashboard.css";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", finance: "Finance", support: "Support" };

/** Nav shell for every merchant dashboard screen: a sidebar on desktop, a top
 *  bar with a Menu disclosure on narrow screens. URLs and role visibility are
 *  unchanged from the original header nav.
 *
 *  No impersonation banner here — nothing in the merchant plane impersonates
 *  anyone; when an admin "views as merchant", they arrive with a
 *  `support`-role session and see exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const navId = useId();

  // Close the mobile menu after navigating, so the new page is what's visible.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="dash-shell">
      <a className="dash-skip-link" href="#dash-main">
        Skip to content
      </a>

      <div className="dash-topbar">
        <Link className="dash-brand" to="/dashboard">
          <span className="dash-brand-mark" aria-hidden="true">F</span>
          FilsPay
        </Link>
        <button
          type="button"
          className="dash-button"
          aria-expanded={menuOpen}
          aria-controls={navId}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? "Close menu" : "Menu"}
        </button>
      </div>

      <aside className="dash-sidebar" id={navId} data-open={menuOpen}>
        <Link className="dash-brand" to="/dashboard">
          <span className="dash-brand-mark" aria-hidden="true">F</span>
          FilsPay
        </Link>

        {me ? (
          <div className="dash-merchant">
            <span className="dash-muted">Merchant</span>
            <span className="dash-merchant-name">{me.merchant.displayName}</span>
          </div>
        ) : null}

        <nav className="dash-nav" aria-label="Dashboard">
          <div className="dash-nav-group">
            <p className="dash-nav-heading">Payments</p>
            <NavLink to="/dashboard/overview">Overview</NavLink>
            <NavLink to="/dashboard/transactions">Transactions</NavLink>
            <NavLink to="/dashboard/payment-links">Payment links</NavLink>
          </div>
          <div className="dash-nav-group">
            <p className="dash-nav-heading">Payouts</p>
            <NavLink to="/dashboard/settlement">Settlement</NavLink>
            {/* Reconciliation is owner/finance-only server-side. */}
            <RequireRole allow={["owner", "finance"]}>
              <NavLink to="/dashboard/reconciliation">Reconciliation</NavLink>
            </RequireRole>
          </div>
          {/* Every webhook route — including the plain list read — is
              owner/finance-only server-side, so the link itself is
              hidden from support rather than offered and then refused. */}
          <RequireRole allow={["owner", "finance"]}>
            <div className="dash-nav-group">
              <p className="dash-nav-heading">Developers</p>
              <NavLink to="/dashboard/webhooks">Webhooks</NavLink>
            </div>
          </RequireRole>
        </nav>

        <div className="dash-account">
          {me ? (
            <>
              <span className="dash-account-email">{me.email}</span>
              <span>
                <span className="dash-status dash-tone-neutral">{ROLE_LABEL[me.role] ?? me.role}</span>
              </span>
            </>
          ) : null}
          <button type="button" className="dash-button" onClick={() => void handleSignOut()}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="dash-content">
        <main className="dash-main" id="dash-main" tabIndex={-1}>
          {error ? <ErrorNotice title="Sign-out failed">{error}</ErrorNotice> : null}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
