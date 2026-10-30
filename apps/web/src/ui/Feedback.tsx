import type { ReactNode } from "react";

/** A failure the reader must act on. `role="alert"` so it is announced the
 *  moment it appears, not only when someone tabs to it. */
export function ErrorNotice({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="dash-error" role="alert">
      {title ? <strong className="dash-feedback-title">{title}</strong> : null}
      {children}
    </div>
  );
}

/** A confirmed success, announced politely. */
export function SuccessNotice({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="dash-notice" role="status">
      {title ? <strong className="dash-feedback-title">{title}</strong> : null}
      {children}
    </div>
  );
}

/** Something is in progress or not yet confirmed — never styled as an error. */
export function InfoNotice({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="dash-info" role="status">
      {title ? <strong className="dash-feedback-title">{title}</strong> : null}
      {children}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="dash-loading" role="status" aria-live="polite">
      <span className="dash-spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="dash-empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
