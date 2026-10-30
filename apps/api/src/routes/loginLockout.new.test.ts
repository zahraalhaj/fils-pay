/**
 * Per-account password lockout (#88): after LOGIN_MAX_FAILURES wrong
 * passwords the account is locked, even the right password is refused
 * while it lasts, and parallel guesses cannot exceed the budget.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { LOGIN_MAX_FAILURES } from "../auth/lockout.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("loginLockout.new.test.ts requires DATABASE_URL");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const password = "correct horse battery staple 1!";

async function newMerchant(): Promise<{ merchantId: string; email: string }> {
  const email = `lockout-${randomUUID()}@example.test`;
  const signup = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `Lockout Co ${randomUUID().slice(0, 8)}`,
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: email,
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password },
    },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  return { merchantId: (signup.json() as { merchantId: string }).merchantId, email };
}

const attempt = (merchantId: string, email: string, pw: string) =>
  app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: pw } });

test("wrong passwords lock the account; the right one is then refused too", async () => {
  const { merchantId, email } = await newMerchant();
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    assert.equal((await attempt(merchantId, email, "wrong")).statusCode, 401);
  }
  const locked = await attempt(merchantId, email, password);
  assert.equal(locked.statusCode, 429);
  assert.match(locked.body, /account_locked/);

  // Once the lock expires the right password works and resets the count.
  await pool.query(`UPDATE merchant_users SET locked_until = now() - interval '1 second' WHERE email = $1`, [email]);
  assert.equal((await attempt(merchantId, email, password)).statusCode, 200);
  const row = await pool.query(`SELECT failed_login_count, locked_until FROM merchant_users WHERE email = $1`, [email]);
  assert.deepEqual(row.rows[0], { failed_login_count: 0, locked_until: null });
});

test("a success before the limit resets the failure count", async () => {
  const { merchantId, email } = await newMerchant();
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await attempt(merchantId, email, "wrong");
  assert.equal((await attempt(merchantId, email, password)).statusCode, 200);
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await attempt(merchantId, email, "wrong");
  assert.equal((await attempt(merchantId, email, password)).statusCode, 200, "not locked: the budget was reset");
});

test("parallel guesses still lock the account at the limit", async () => {
  const { merchantId, email } = await newMerchant();
  await Promise.all(Array.from({ length: LOGIN_MAX_FAILURES * 2 }, () => attempt(merchantId, email, "wrong")));
  assert.equal((await attempt(merchantId, email, password)).statusCode, 429);
});

test("an unknown account is never reported as locked", async () => {
  const { merchantId } = await newMerchant();
  for (let i = 0; i < LOGIN_MAX_FAILURES + 1; i++) {
    assert.equal((await attempt(merchantId, `nobody-${randomUUID()}@example.test`, "wrong")).statusCode, 401);
  }
});
