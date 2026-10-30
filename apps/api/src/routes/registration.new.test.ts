import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("registration tests require DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const config = loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "test", SMTP_URL: "smtp://unused", OTP_DEV_EXPOSE: "true" });
const messages: Array<{ to: string; text: string }> = [];
let failMail = false;
const app = buildApp(config, pool, { registration: { mailer: { async send(message) {
  if (failMail) throw new Error("SMTP unavailable");
  messages.push(message);
} } } });
test.after(async () => { await app.close(); await pool.end(); });
const post = (url: string, payload: object, cookie?: string, ip = "192.0.2.1") =>
  app.inject({ method: "POST", url: "/v1/auth" + url, payload, headers: cookie ? { cookie } : {}, remoteAddress: ip });
let sequence = 0;
async function signup() {
  const email = `registration-${randomUUID()}@example.test`;
  const result = await post("/register", { displayName: "New Shop", email: ` ${email.toUpperCase()} `, password: "a long test password" }, undefined, `192.0.2.${++sequence}`);
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.json().devOtpCode, undefined);
  const cookie = result.cookies.find((c) => c.name === "fp_registration")!;
  assert.equal(cookie.httpOnly, true);
  return { email, cookie: `${cookie.name}=${cookie.value}`, token: cookie.value,
    code: messages.at(-1)!.text.match(/code is (\d{6})/)![1]! };
}

test("verification creates one owner and session; payment approval stays pending", async () => {
  const item = await signup();
  assert.equal((await pool.query("SELECT 1 FROM merchant_users WHERE email=$1", [item.email])).rowCount, 0);
  assert.equal((await app.inject({ url: "/v1/auth/me", headers: { cookie: item.cookie } })).statusCode, 401);
  const result = await post("/register/verify", { code: item.code }, item.cookie);
  assert.equal(result.statusCode, 200, result.body);
  const session = result.cookies.find((c) => c.name === "fp_sid")!;
  const cookie = `${session.name}=${session.value}`;
  const me = await app.inject({ url: "/v1/auth/me", headers: { cookie } });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().email, item.email);
  assert.equal(me.json().merchant.onboardingStatus, "submitted");
  assert.equal(me.json().role, "owner");
  assert.equal((await pool.query("SELECT kyc_passed FROM merchants WHERE id=$1", [result.json().merchantId])).rows[0].kyc_passed, false);
  assert.equal((await post("/register/verify", { code: item.code }, item.cookie)).statusCode, 410);
  assert.equal((await pool.query("SELECT 1 FROM merchant_users WHERE email=$1", [item.email])).rowCount, 1);
  const duplicate = await post("/register", { displayName: "Another", email: item.email, password: "another long password" }, undefined, "198.51.100.1");
  assert.equal(duplicate.statusCode, 409);
  const key = await app.inject({ method: "POST", url: `/v1/merchants/${result.json().merchantId}/api-keys`, headers: { cookie }, payload: {} });
  assert.equal(key.statusCode, 201, key.body);
  const payment = await app.inject({ method: "POST", url: "/v1/transactions",
    headers: { authorization: `Bearer ${key.json().rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 1000, card: { pan: "4111111111111111", expiryMonth: 12, expiryYear: 2030, cvv: "123" } } });
  assert.equal(payment.statusCode, 403, payment.body);
  assert.equal(payment.json().error, "merchant_not_approved");
});

test("wrong codes consume attempts and resend does not reset them", async () => {
  const item = await signup();
  assert.equal((await post("/register/resend", {}, item.cookie)).statusCode, 429);
  const wrong = item.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await post("/register/verify", { code: wrong }, item.cookie)).statusCode, 401);
  assert.equal((await post("/register/verify", { code: item.code }, item.cookie)).statusCode, 429);
  assert.equal((await pool.query("SELECT 1 FROM merchant_users WHERE email=$1", [item.email])).rowCount, 0);
});

test("resend invalidates the old code and preserves the attempt budget", async () => {
  const item = await signup();
  await pool.query("UPDATE merchant_registrations SET sent_at=now()-interval '31 seconds', attempt_count=2 WHERE token_hash=$1", [sha256Hex(item.token)]);
  assert.equal((await post("/register/resend", {}, item.cookie)).statusCode, 200);
  const stored = (await pool.query("SELECT attempt_count FROM merchant_registrations WHERE token_hash=$1", [sha256Hex(item.token)])).rows[0];
  assert.equal(stored.attempt_count, 2);
  const fresh = messages.at(-1)!.text.match(/code is (\d{6})/)![1]!;
  if (fresh !== item.code) assert.equal((await post("/register/verify", { code: item.code }, item.cookie)).statusCode, 401);
  assert.equal((await post("/register/verify", { code: fresh }, item.cookie)).statusCode, 200);
});

test("expiry, missing cookie, weak password and missing SMTP fail safely", async () => {
  assert.equal((await post("/register/verify", { code: "123456" })).statusCode, 401);
  assert.equal((await post("/register", { displayName: "Shop", email: "bad", password: "short" })).statusCode, 400);
  const item = await signup();
  await pool.query("UPDATE merchant_registrations SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [sha256Hex(item.token)]);
  assert.equal((await post("/register/verify", { code: item.code }, item.cookie)).statusCode, 410);
  const noSmtp = buildApp({ ...config, smtpUrl: null }, pool);
  const response = await noSmtp.inject({ method: "POST", url: "/v1/auth/register", payload: { displayName: "Shop", email: "some@example.test", password: "a long test password" } });
  assert.equal(response.statusCode, 400);
  await noSmtp.close();
});

test("SMTP failure creates no merchant and exposes no code", async () => {
  failMail = true;
  try {
    const email = `mail-failure-${randomUUID()}@example.test`;
    const response = await post("/register", { displayName: "Shop", email, password: "a long test password" }, undefined, "198.51.100.2");
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().devOtpCode, undefined);
    assert.equal((await pool.query("SELECT 1 FROM merchant_users WHERE email=$1", [email])).rowCount, 0);
  } finally { failMail = false; }
});

test("registration limits persist in the database", async () => {
  const email = `limit-${randomUUID()}@example.test`;
  for (let i=0;i<5;i++) assert.equal((await post("/register", { displayName: "Shop", email, password: "a long test password" }, undefined, "203.0.113.1")).statusCode, 201);
  assert.equal((await post("/register", { displayName: "Shop", email, password: "a long test password" }, undefined, "203.0.113.1")).statusCode, 429);
});

test("login binds the OTP session to the password-verified merchant when emails match", async () => {
  const email = `shared-${randomUUID()}@example.test`;
  const { hashPassword } = await import("../auth/passwords.js");
  const hash = await hashPassword("a long test password", config);
  const users: Array<{ id: string; merchantId: string }> = [];
  for (let i=0;i<2;i++) {
    const m = await pool.query("INSERT INTO merchants(display_name) VALUES ('Tenant') RETURNING id");
    const merchantId = m.rows[0].id;
    const u = await pool.query("INSERT INTO merchant_users(merchant_id,email,role,password_hash) VALUES($1,$2,'owner',$3) RETURNING id", [merchantId,email,hash]);
    users.push({ id:u.rows[0].id,merchantId });
  }
  const loginApp = buildApp({ ...config, smtpUrl:null }, pool);
  try {
    const response = await loginApp.inject({ method:"POST",url:"/v1/auth/login",payload:{merchantId:users[1]!.merchantId,email,password:"a long test password"} });
    assert.equal(response.statusCode,200,response.body);
    const sid = response.cookies.find(c=>c.name==='fp_sid')!;
    const session = await pool.query("SELECT merchant_user_id FROM sessions WHERE token_hash=$1",[sha256Hex(sid.value)]);
    assert.equal(session.rows[0].merchant_user_id,users[1]!.id);
  } finally { await loginApp.close(); }
});
