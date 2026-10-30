/**
 * OTP guess budget (#53).
 * - Verify read attempt_count, compared, then incremented, so N parallel
 *   wrong guesses all passed the check: far more than max_attempts guesses.
 * - Resend issued a fresh challenge with attempt_count 0, so waiting 30 s
 *   bought a new budget, despite the docstring promising it is inherited.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("otpAttempts.new.test.ts requires DATABASE_URL");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function loginPending(): Promise<{ cookie: string; code: string }> {
  const email = `otp-${randomUUID()}@example.test`;
  const password = "correct horse battery staple 1!";
  const signup = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `OTP Co ${randomUUID().slice(0, 8)}`,
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
  const { merchantId } = signup.json() as { merchantId: string };

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const setCookie = login.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return { cookie: header.split(";")[0]!, code: (login.json() as { devOtpCode: string }).devOtpCode };
}

function wrongCode(code: string): string {
  return code.replace(/\d$/, (d) => String((Number(d) + 1) % 10));
}

test("parallel wrong guesses can't exceed max_attempts", async () => {
  const { cookie, code } = await loginPending();
  const guesses = 20;
  const results = await Promise.all(
    Array.from({ length: guesses }, () =>
      app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: wrongCode(code) } }),
    ),
  );
  const checked = results.filter((r) => r.statusCode === 401 && r.json().error === "invalid_code").length;
  assert.ok(checked <= config.otpMaxAttempts, `${checked} guesses were checked, max is ${config.otpMaxAttempts}`);
});

test("resend keeps the attempts already used", async () => {
  const { cookie, code } = await loginPending();
  for (let i = 0; i < config.otpMaxAttempts - 1; i++) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: wrongCode(code) } });
    assert.equal(r.statusCode, 401, r.body);
  }
  // Skip the 30 s resend throttle.
  await pool.query(
    `UPDATE otp_challenges SET created_at = now() - interval '1 minute'
      WHERE id = (SELECT otp_challenge_id FROM sessions WHERE token_hash = encode(sha256($1::bytea), 'hex'))`,
    [cookie.split("=")[1]],
  );
  const resend = await app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie } });
  assert.equal(resend.statusCode, 200, resend.body);
  const newCode = (resend.json() as { devOtpCode: string }).devOtpCode;

  // One attempt left: a wrong guess uses it, then even the right code is refused.
  const last = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: wrongCode(newCode) } });
  assert.equal(last.statusCode, 401, last.body);
  const after = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: newCode } });
  assert.notEqual(after.statusCode, 200, "budget exhausted: the resend must not have reset it");
});
