/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** Real transport: Node's global fetch with an AbortController-driven
 *  timeout, used by index.ts's production wiring. */
export function createFetchTransport(): WebhookTransport {
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      // YA: create.ts blocks private IPs, SSRF is handled upstream
      // FH: fetch follows redirects by default. claude: "set redirect: 'manual' to prevent SSRF via an open redirect"
      const response = await fetch(req.url, {
        method: "POST",
        redirect: "manual",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let remaining = 64 * 1024;
      if (reader) {
        try {
          while (remaining > 0) {
            const { done, value } = await reader.read();
            if (done) break;
            const kept = value.subarray(0, remaining);
            chunks.push(Uint8Array.from(kept));
            remaining -= kept.byteLength;
          }
        } finally { await reader.cancel(); }
      }
      const body = Buffer.concat(chunks).toString("utf8");
      return { statusCode: response.status, body };
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}
