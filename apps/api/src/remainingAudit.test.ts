import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import type { Pool } from "pg";
import { loadConfig } from "./config.js";
import { acquirerCallbackRoutes } from "./routes/acquirerCallbacks.js";
import { errorHandler } from "./plugins/errorHandler.js";
import { verifyAcquirerCallbackSignature } from "./webhooks/inboundVerify.js";
import { applyAcquirerCallback } from "./acquirer/callbacks.js";
import { iterateTransactionsExportCsv, buildTransactionsExportCsv, streamTransactionsExportCsv } from "./transactions/exportCsv.js";
import { payPaymentLink } from "./paymentLinks/pay.js";
import type { AcquirerSimulator } from "./acquirer/types.js";
import { withTransaction } from "./db/withTransaction.js";
import { createFetchTransport } from "./webhooks/transport.js";
import { recordPayoutDisbursementEffect } from "./webhooks/payoutDisbursement.js";

const secret = "test-secret";
const timestamp = Math.floor(Date.now() / 1000);
const sign = (raw: string, t = timestamp) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const callback = { callbackId: "cb-1", type: "fraud_review.completed" as const,
  transactionId: "11111111-1111-4111-8111-111111111111", occurredAt: new Date().toISOString(),
  outcome: "cleared" as const, note: "review complete" };

// A transactional fake verifies lock/read/write order. Real PostgreSQL
// concurrency and cursor semantics still require the integration environment.
function database(query: (sql: string, args?: unknown[]) => Promise<unknown> | unknown) {
  const client = { query, release: (_err?: Error) => {} };
  return { connect: async () => client, query } as unknown as Pool;
}

test("callbacks reject unsigned, stale, future, malformed and tampered signatures", () => {
  assert.equal(verifyAcquirerCallbackSignature({}, undefined, secret).valid, false);
  for (const t of [timestamp - 301, timestamp + 301]) {
    assert.equal(verifyAcquirerCallbackSignature({}, sign("{}", t), secret).reason, "timestamp_out_of_tolerance");
  }
  assert.equal(verifyAcquirerCallbackSignature({}, `t=${timestamp},v1=zz`, secret).valid, false);
  assert.equal(verifyAcquirerCallbackSignature({ changed: true }, sign("{}"), secret).valid, false);
  assert.equal(verifyAcquirerCallbackSignature({}, sign("{}"), secret).valid, true);
});

test("callback route authenticates original bytes and validates outcomes before DB access", async () => {
  const sql: string[] = [];
  const pool = database((q) => {
    sql.push(q);
    if (q.includes("FROM transactions")) return { rows: [{ merchant_id: "merchant" }] };
    return { rows: [] };
  });
  const app = Fastify();
  app.decorate("db", pool);
  app.decorate("config", loadConfig({ DATABASE_URL: "postgres://unused/test", NODE_ENV: "test", ACQUIRER_CALLBACK_SIGNING_SECRET: secret }));
  app.setErrorHandler(errorHandler);
  app.register(acquirerCallbackRoutes);
  await app.ready();
  try {
    const raw = JSON.stringify(callback, null, 2) + "\n";
    const result = await app.inject({ method: "POST", url: "/callbacks", headers: {
      "content-type": "application/json", "acquirer-callback-signature": sign(raw) }, payload: raw });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(sql.filter(q => q.includes("INSERT INTO acquirer_callback_notes")).length, 1);
    sql.length = 0;
    const unsigned = await app.inject({ method: "POST", url: "/callbacks", payload: callback });
    assert.equal(unsigned.statusCode, 401);
    for (const patch of [{ outcome: "anything" }, { occurredAt: "bad" }, { transactionId: "bad" }, { note: 12 }]) {
      const invalid = await app.inject({ method: "POST", url: "/callbacks", payload: { ...callback, ...patch } });
      assert.equal(invalid.statusCode, 400);
    }
    assert.equal(sql.length, 0);
  } finally { await app.close(); }
});

test("callback redelivery checks persistent notes under a transaction lock", async () => {
  const statements: string[] = [];
  let inserted = false;
  const pool = database((q) => {
    statements.push(q);
    if (q.includes("FROM acquirer_callback_notes")) return { rows: inserted ? [{ ok: 1 }] : [] };
    if (q.includes("FROM transactions")) return { rows: [{ merchant_id: "merchant" }] };
    if (q.includes("INSERT INTO acquirer_callback_notes")) inserted = true;
    return { rows: [] };
  });
  await applyAcquirerCallback(pool, callback);
  await applyAcquirerCallback(pool, callback);
  assert.equal(statements.filter(q => q.includes("INSERT INTO acquirer_callback_notes")).length, 1);
  assert.equal(statements.filter(q => q.includes("pg_advisory_xact_lock")).length, 2);
  assert.ok(statements.findIndex(q => q.includes("pg_advisory")) < statements.findIndex(q => q.includes("FROM acquirer_callback_notes")));
});

const row = (id: number, reference = "ref") => ({ id: String(id), status: "captured", amount_fils: 4755,
  captured_fils: 4755, reference, occurred_at: new Date("2026-10-30T00:00:00Z") });

test("CSV cursor exports 1001 rows with identical timestamps without skips", async () => {
  const sql: string[] = [];
  let fetches = 0;
  const pool = database((q, args) => {
    sql.push(q);
    if (q.startsWith("DECLARE")) assert.equal(args?.[0], "owner");
    if (q.startsWith("FETCH")) return { rows: ++fetches === 1 ? Array.from({ length: 1000 }, (_, i) => row(i)) : [row(1000)] };
    return { rows: [] };
  });
  const chunks: string[] = [];
  await streamTransactionsExportCsv(pool, { merchantId: "owner" }, async chunk => { chunks.push(chunk); });
  assert.equal(chunks.length, 1002);
  assert.equal(fetches, 2);
  assert.match(sql.find(q => q.startsWith("DECLARE"))!, /ORDER BY occurred_at ASC, id ASC/);
  assert.equal(sql.at(-1), "ROLLBACK");
});

test("CSV disconnect closes the cursor and releases its connection", async () => {
  const sql: string[] = [];
  let released = false;
  const pool = { connect: async () => ({ query: async (q: string) => { sql.push(q); return { rows: [] }; }, release: () => { released = true; } }) } as unknown as Pool;
  for await (const _ of iterateTransactionsExportCsv(pool, { merchantId: "owner" })) break;
  assert.equal(sql.at(-1), "ROLLBACK");
  assert.equal(released, true);
});

test("CSV neutralizes formulas and quotes carriage returns", async () => {
  const pool = database(() => ({ rows: [row(1, '=HYPERLINK("evil")'), row(2, "hello\rworld")] }));
  const csv = await buildTransactionsExportCsv(pool, { merchantId: "owner" });
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('"hello\rworld"'));
});

test("expired or already reserved links never reach the acquirer, even with backdated submittedAt", async () => {
  for (const state of ["active", "reserved"]) {
    const pool = database((q, args) => {
      if (q.startsWith("UPDATE")) {
        assert.ok(!q.includes("OR (status = 'reserved'"));
        assert.ok((args?.[1] as Date).getTime() > new Date("2020-01-01").getTime());
        return { rows: [] };
      }
      return { rows: [{ status: state, expires_at: new Date("2020-01-01") }] };
    });
    const result = await payPaymentLink(pool, {} as AcquirerSimulator,
      { paymentLinkReservationTimeoutSeconds: 1 }, { token: "link", card: {} as never,
        idempotencyKey: "key", submittedAt: "2019-01-01" });
    assert.equal(result.statusCode, state === "active" ? 410 : 409);
  }
});

test("rollback failure preserves the original exception and discards broken client", async () => {
  const original = new Error("original");
  const rollback = new Error("connection gone");
  let releaseError: Error | undefined;
  const pool = { connect: async () => ({ query: async (q: string) => { if (q === "ROLLBACK") throw rollback; },
    release: (err?: Error) => { releaseError = err; } }) } as unknown as Pool;
  await assert.rejects(withTransaction(pool, async () => { throw original; }), err => err === original);
  assert.equal(releaseError, rollback);
});

test("webhook transport refuses redirects and bounds response memory", async () => {
  const saved = globalThis.fetch;
  let canceled = false;
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
    assert.equal(options.redirect, "manual");
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16384).fill(65)); },
      cancel() { canceled = true; } }), { status: 302 });
  }) as typeof fetch;
  try {
    const response = await createFetchTransport()({ url: "https://example.com", headers: {}, body: "{}", timeoutMs: 1000 });
    assert.equal(response.statusCode, 302);
    assert.equal(response.body.length, 64 * 1024);
    assert.equal(canceled, true);
  } finally { globalThis.fetch = saved; }
});

test("payout instructions lock the batch and insert only if none exists", async () => {
  const statements: string[] = [];
  const pool = database(q => { statements.push(q); return { rows: [] }; });
  await recordPayoutDisbursementEffect(pool, "batch", 100);
  assert.equal(statements[0], "BEGIN");
  assert.match(statements[1]!, /FOR UPDATE/);
  assert.match(statements[2]!, /WHERE NOT EXISTS/);
  assert.equal(statements[3], "COMMIT");
});

test("development fallback encryption key is exactly 32 bytes", () => {
  const config = loadConfig({ DATABASE_URL: "postgres://unused/test", NODE_ENV: "development" });
  assert.equal(Buffer.from(config.webhookSecretEncryptionKey, "base64").length, 32);
  assert.equal(config.acquirerCallbackRequireSignature, true);
});

test("production cannot opt out of callback authentication", async () => {
  const app = Fastify();
  app.decorate("db", database(() => { throw new Error("must not reach database"); }));
  app.decorate("config", { ...loadConfig({ DATABASE_URL: "postgres://unused/test", NODE_ENV: "test" }),
    nodeEnv: "production", acquirerCallbackRequireSignature: false });
  app.setErrorHandler(errorHandler);
  app.register(acquirerCallbackRoutes);
  try {
    const result = await app.inject({ method: "POST", url: "/callbacks", payload: callback });
    assert.equal(result.statusCode, 401);
  } finally { await app.close(); }
});
