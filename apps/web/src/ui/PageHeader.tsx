import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Every dashboard page starts with the same block: an optional way back,
 * the page title (the page's single <h1>), one line saying what the page is
 * for, and the page's primary action on the right.
 */
export function PageHeader({
  title,
  description,
  back,
  actions,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  back?: { to: string; label: string };
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="dash-page-header">
      <div className="dash-page-header-text">
        {back ? (
          <Link className="dash-back" to={back.to}>
            <span aria-hidden="true">‹</span> {back.label}
          </Link>
        ) : null}
        <h1>{title}</h1>
        {meta ? <div className="dash-page-description">{meta}</div> : null}
        {description ? <p className="dash-page-description">{description}</p> : null}
      </div>
      {actions ? <div className="dash-page-actions">{actions}</div> : null}
    </div>
  );
}
