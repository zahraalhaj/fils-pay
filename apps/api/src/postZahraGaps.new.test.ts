import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import type { Pool } from "pg";
import { loadConfig } from "./config.js";
import { acquirerCallbackRoutes } from "./routes/acquirerCallbacks.js";
import { errorHandler } from "./plugins/errorHandler.js";
import { buildTransactionsExportCsv, streamTransactionsExportCsv } from "./transactions/exportCsv.js";
import { payPaymentLink } from "./paymentLinks/pay.js";
import type { AcquirerSimulator } from "./acquirer/types.js";
import { createFetchTransport } from "./webhooks/transport.js";
import { recordPayoutDisbursementEffect } from "./webhooks/payoutDisbursement.js";

function database(query: (sql: string, args?: unknown[]) => unknown) {
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}
const secret = "test-secret";
const callback = { callbackId: "callback", type: "fraud_review.completed",
  transactionId: "11111111-1111-4111-8111-111111111111",
  occurredAt: new Date().toISOString(), outcome: "cleared", note: "checked" };
const sign = (raw: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
};

test("callback route verifies original spaced JSON and rejects invalid fields without DB writes", async () => {
  const statements: string[] = [];
  const pool = database(sql => {
    statements.push(sql);
    return { rows: sql.includes("FROM transactions") ? [{ merchant_id: "merchant" }] : [] };
  });
  const app = Fastify();
  app.decorate("db", pool);
  app.decorate("config", loadConfig({ DATABASE_URL: "postgres://unused/test", NODE_ENV: "test",
    ACQUIRER_CALLBACK_SIGNING_SECRET: secret }));
  app.setErrorHandler(errorHandler);
  app.register(acquirerCallbackRoutes);
  try {
    const raw = JSON.stringify(callback, null, 2) + "\n";
    const result = await app.inject({ method: "POST", url: "/callbacks", payload: raw,
      headers: { "content-type": "application/json", "acquirer-callback-signature": sign(raw) } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(statements.filter(s => s.includes("INSERT INTO acquirer_callback_notes")).length, 1);
    statements.length = 0;
    for (const patch of [{ outcome: "anything" }, { transactionId: "bad" }, { occurredAt: "bad" }, { note: 12 }]) {
      const text = JSON.stringify({ ...callback, ...patch });
      const invalid = await app.inject({ method: "POST", url: "/callbacks", payload: text,
        headers: { "content-type": "application/json", "acquirer-callback-signature": sign(text) } });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    const tampered = await app.inject({ method: "POST", url: "/callbacks", payload: JSON.stringify(callback),
      headers: { "content-type": "application/json", "acquirer-callback-signature": sign(raw) } });
    assert.equal(tampered.statusCode, 401);
    assert.equal(statements.length, 0);
  } finally { await app.close(); }
});

test("production refuses unsigned callbacks even when its signature flag is false", async () => {
  const app = Fastify();
  app.decorate("db", database(() => { throw Error("must not query"); }));
  app.decorate("config", { ...loadConfig({ DATABASE_URL: "postgres://unused/test", NODE_ENV: "test" }),
    nodeEnv: "production", acquirerCallbackSigningSecret: secret,
    acquirerCallbackRequireSignature: false });
  app.setErrorHandler(errorHandler);
  app.register(acquirerCallbackRoutes);
  try {
    assert.equal((await app.inject({ method: "POST", url: "/callbacks", payload: callback })).statusCode, 401);
  } finally { await app.close(); }
});

test("expired or reserved links reject backdated timestamps before contacting the acquirer", async () => {
  for (const status of ["active", "reserved"]) {
    const pool = database((sql, args) => {
      if (sql.startsWith("UPDATE")) {
        assert.match(sql, /AND status = 'active'/);
        assert.doesNotMatch(sql, /OR \(status = 'reserved'/);
        assert.ok((args?.[1] as Date).getTime() > Date.now() - 1000);
        return { rows: [] };
      }
      return { rows: [{ status, expires_at: new Date(Date.now() - 60000) }] };
    });
    const result = await payPaymentLink(pool, {} as AcquirerSimulator,
      { paymentLinkReservationTimeoutSeconds: 1 },
      { token: "link", card: {} as never, idempotencyKey: "key",
        submittedAt: new Date(Date.now() - 120000).toISOString() });
    assert.equal(result.statusCode, status === "active" ? 410 : 409);
  }
});

test("uncertain authorization/capture keeps ownership; explicit declines release only their reservation", async () => {
  for (const phase of ["authorize", "capture"]) for (const responseStatus of [502, 402]) {
    const statements: string[] = [];
    const pool = database((sql, args) => {
      statements.push(sql);
      if (sql.includes("RETURNING id, reservation_id")) return { rows: [{
        id: "link", reservation_id: "owner", merchant_id: "merchant", amount_fils: "1000", reference: null,
      }] };
      if (sql.startsWith("INSERT INTO idempotency_keys")) return { rows: [] };
      if (sql.startsWith("SELECT * FROM idempotency_keys")) {
        const endpoint = String(args?.[1]);
        // Replay a persisted authorize and capture result: no live processor call.
        return { rows: [{ id: endpoint, merchant_id: "merchant", endpoint, key: args?.[2],
          request_hash: hashes.get(endpoint), status: "completed", attempt_count: 1,
          response_status_code: endpoint === "transactions.authorize" && phase === "capture" ? 201 : responseStatus,
          response_body: endpoint === "transactions.authorize" ? { id: "txn" } : { error: "processor_result" } }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const hashes = new Map<string, unknown>();
    const originalConnect = pool.connect.bind(pool);
    // Capture the requested hashes so the replay fixture matches the actual request.
    pool.connect = (async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      client.query = (async (sql: string, args: unknown[]) => {
        if (sql.startsWith("INSERT INTO idempotency_keys")) hashes.set(String(args[1]), args[3]);
        return originalQuery(sql, args);
      }) as typeof client.query;
      return client;
    }) as typeof pool.connect;
    const result = await payPaymentLink(pool, {} as AcquirerSimulator,
      { paymentLinkReservationTimeoutSeconds: 1 },
      { token: "link", card: {} as never, idempotencyKey: "key" });
    assert.equal(result.statusCode, responseStatus);
    const releases = statements.filter(s => s.includes("SET status = 'active'"));
    assert.equal(releases.length, responseStatus === 402 ? 1 : 0);
    if (releases.length) assert.match(releases[0]!, /reservation_id = \$2/);
  }
});

test("both CSV paths neutralize formulas and quote embedded carriage returns", async () => {
  const rows = ["=1+1", "+cmd", "-2+3", "@SUM(1)", "  =1", "hello\rworld"].map((reference, i) => ({
    id: String(i), status: "captured", amount_fils: "1000", captured_fils: "1000",
    reference, occurred_at: new Date(), occurred_at_text: new Date().toISOString(),
  }));
  const pool = database(() => ({ rows }));
  const whole = await buildTransactionsExportCsv(pool, { merchantId: "owner" });
  let streamed = "";
  for await (const part of streamTransactionsExportCsv(pool, { merchantId: "owner" })) streamed += part;
  assert.equal(streamed, whole);
  for (const formula of ["=1+1", "+cmd", "-2+3", "@SUM(1)", "  =1"]) assert.ok(whole.includes("'" + formula));
  assert.ok(whole.includes('"hello\rworld"'));
});

test("webhook fetch blocks redirects, caps receiver output and cancels its reader", async () => {
  const saved = globalThis.fetch;
  let canceled = false;
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
    assert.equal(options.redirect, "manual");
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(16384).fill(65)); },
      cancel() { canceled = true; },
    }), { status: 302 });
  }) as typeof fetch;
  try {
    const response = await createFetchTransport()({ url: "https://example.invalid", headers: {},
      body: "{}", timeoutMs: 1000 });
    assert.equal(response.statusCode, 302);
    assert.equal(response.body.length, 64 * 1024);
    assert.equal(canceled, true);
  } finally { globalThis.fetch = saved; }
});

test("repeated concurrent payout instructions lock before checking and insert only once", async () => {
  let tail = Promise.resolve();
  let written = false;
  let inserts = 0;
  const pool = { connect: async () => {
    let unlock = () => {};
    let locked = false;
    return {
      query: async (sql: string) => {
        if (sql.includes("FOR UPDATE")) {
          const previous = tail;
          tail = new Promise<void>(resolve => { unlock = resolve; });
          await previous;
          locked = true;
        }
        if (sql.includes("INSERT INTO settlement_payout_disbursements")) {
          assert.equal(locked, true);
          assert.match(sql, /WHERE NOT EXISTS/);
          if (!written) { written = true; inserts++; }
        }
        if (sql === "COMMIT" || sql === "ROLLBACK") unlock();
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
  } } as unknown as Pool;
  await Promise.all(Array.from({ length: 5 }, () => recordPayoutDisbursementEffect(pool, "batch", 100)));
  assert.equal(inserts, 1);
});
