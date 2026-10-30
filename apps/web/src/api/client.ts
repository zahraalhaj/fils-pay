import type { ApiErrorBody } from "../types.js";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

/** Mirrors apps/api's own uniform `{ error, message? }` body
 *  (lib/errors.ts / plugins/errorHandler.ts) — one error shape end to
 *  end, not reinvented client-side. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly body: ApiErrorBody;

  constructor(statusCode: number, body: ApiErrorBody) {
    super(body.message ?? body.error);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = body.error;
    this.body = body;
  }
}

/**
 * `credentials: "include"`: the dashboard is cookie-authenticated
 * (`fp_sid`), and apps/web (5173) is not the API origin (3000), so the
 * session cookie only rides along on a request that asks for it. The public
 * checkout flow is unaffected — /pay/:token reads no cookie server-side, so
 * sending one that doesn't exist is a no-op there.
 *
 * `Content-Type: application/json` is sent only when there actually is a
 * body: logout, void and replay take none, and Fastify rejects a request
 * that declares a JSON content type while carrying an empty body
 * (`FST_ERR_CTP_EMPTY_JSON_BODY`). Same fix apps/admin's client.ts already
 * carries, for the same reason.
 */
// The API allows credentialed CORS only from CORS_ALLOWED_ORIGINS (config.ts).
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: hasBody
      ? { "Content-Type": "application/json", ...init?.headers }
      : { ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? { error: "unknown_error" });
  }
  return body as T;
}

/** For the routes that answer `204 No Content` (logout, cancel payment
 *  link, delete webhook endpoint) — makes "there is deliberately no body
 *  here" explicit at the call site. */
/**
 * For 204 responses.
 */
export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  await request<unknown>(path, init);
}

/** Human-readable text for anything thrown by `request` — used by every
 *  dashboard page's error banner so a failure (including a server-side
 *  `403` from a role gate) is always shown, never silently swallowed. */
/** Short wording for codes the API sends without a `message`. Login stays
 *  deliberately generic — the API never says which credential was wrong,
 *  and neither does this. */
const KNOWN_ERRORS: Record<string, string> = {
  invalid_credentials: "Those details didn't match. Check them and try again.",
  invalid_code: "Code didn't match. Try again.",
  otp_expired: "Code expired. Request a new one.",
  no_pending_session: "Sign-in timed out. Start again.",
  too_many_attempts: "Too many tries. Start sign-in again.",
  resend_too_soon: "A code was just sent. Wait a moment before asking again.",
  unauthenticated: "Session ended. Sign in again.",
};

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.statusCode === 403) {
      return `Needs an owner or finance user. (${err.code})`;
    }
    if (err.body.message) return err.body.message;
    const known = KNOWN_ERRORS[err.code];
    if (known) return known;
    if (err.statusCode >= 500) return `Couldn't complete that. Try again. (${err.code})`;
    // No message: readable form of the code, kept verbatim in brackets for support.
    const readable = err.code.replace(/_/g, " ");
    return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}. (${err.code})`;
  }
  // fetch() rejects with a TypeError when no response arrives at all.
  if (err instanceof TypeError) return "Couldn't reach FilsPay. Check your connection and try again.";
  if (err instanceof Error) return err.message;
  return "Something went wrong. Try again.";
}
