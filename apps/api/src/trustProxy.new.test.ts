/** Behind ops/nginx, request.ip must be the client (X-Forwarded-For), but
 *  only when TRUST_PROXY_HOPS says a proxy is there; otherwise any caller
 *  could spoof the address recorded in audit rows. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function ipSeen(hops: string | undefined): Promise<string> {
  const config = loadConfig({
    DATABASE_URL: "postgres://unused/unused",
    NODE_ENV: "test",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    ...(hops === undefined ? {} : { TRUST_PROXY_HOPS: hops }),
  });
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  const app = buildApp(config, pool);
  app.get("/__ip", async (request) => ({ ip: request.ip }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/__ip",
      remoteAddress: "10.0.0.5",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    return res.json<{ ip: string }>().ip;
  } finally {
    await app.close();
    await pool.end();
  }
}

test("without TRUST_PROXY_HOPS the forwarded header is ignored", async () => {
  assert.equal(await ipSeen(undefined), "10.0.0.5");
});

test("with TRUST_PROXY_HOPS=1 the client address comes from the proxy", async () => {
  assert.equal(await ipSeen("1"), "203.0.113.7");
});
