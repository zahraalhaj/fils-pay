/**
 * The API had no CORS handler at all (#38), so the dashboard (5173) and
 * console (5174) couldn't call it cross-origin; MK's "CORS is locked to the
 * two origins in config" was false. Allowed origins get credentialed CORS,
 * everything else gets no CORS headers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://unused";
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

test("preflight from the dashboard origin is answered with credentialed CORS", async () => {
  const res = await app.inject({
    method: "OPTIONS",
    url: "/v1/auth/login",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
  assert.match(String(res.headers["access-control-allow-methods"]), /POST/);
});

test("an unknown origin gets no CORS headers", async () => {
  const res = await app.inject({
    method: "OPTIONS",
    url: "/v1/auth/login",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("production allows no origin unless CORS_ALLOWED_ORIGINS is set", () => {
  const base = {
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    SETTLEMENT_INTERNAL_TOKEN: "x",
    ACQUIRER_CALLBACK_SIGNING_SECRET: "x",
    SMTP_URL: "smtp://localhost:1025",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    INTERNAL_API_TOKEN: "x",
  };
  assert.deepEqual(loadConfig(base).corsAllowedOrigins, []);
  assert.deepEqual(
    loadConfig({ ...base, CORS_ALLOWED_ORIGINS: "https://dash.filspay.example, https://admin.filspay.example" })
      .corsAllowedOrigins,
    ["https://dash.filspay.example", "https://admin.filspay.example"],
  );
});
