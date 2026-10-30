/** OTP_SHOW_ON_SCREEN: explicit opt-in to show login codes in production
 *  without SMTP (hosted demo). Off by default; OTP_DEV_EXPOSE stays ignored. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { deliverOtpCode } from "./auth/notifier.js";

const prodEnv = {
  DATABASE_URL: "postgres://localhost/x",
  NODE_ENV: "production",
  SETTLEMENT_INTERNAL_TOKEN: "t",
  ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Zmlsc3BheS1kZXYtb25seS13ZWJob29rLWtleS0zMmI=",
};

test("production without SMTP still refuses to boot unless OTP_SHOW_ON_SCREEN is set", () => {
  assert.throws(() => loadConfig(prodEnv), /SMTP_URL is required/);
  assert.throws(() => loadConfig({ ...prodEnv, OTP_SHOW_ON_SCREEN: "false" }), /SMTP_URL is required/);
});

test("OTP_SHOW_ON_SCREEN=true boots production without SMTP and exposes the code", () => {
  const config = loadConfig({ ...prodEnv, OTP_SHOW_ON_SCREEN: "true" });
  assert.equal(config.smtpUrl, null);
  assert.equal(config.otpDevExpose, true);
});

test("OTP_DEV_EXPOSE alone still never exposes codes in production", () => {
  const config = loadConfig({ ...prodEnv, SMTP_URL: "smtp://localhost:2525", OTP_DEV_EXPOSE: "true" });
  assert.equal(config.otpDevExpose, false);
});

test("production delivery with the opt-in and no mailer succeeds without logging the code", async () => {
  const logged: unknown[] = [];
  const logger = { info: (obj: unknown) => logged.push(obj), error: (obj: unknown) => logged.push(obj) };
  await deliverOtpCode(
    logger,
    { nodeEnv: "production", smtpUrl: null, otpFromEmail: "x@example.com", otpDevExpose: true },
    { email: "m@example.com", logFields: { merchantUserId: "u1" } },
    "123456",
    null,
  );
  assert.ok(!JSON.stringify(logged).includes("123456"), "code must not reach the logs");
});

test("production delivery without the opt-in and no mailer still fails", async () => {
  await assert.rejects(
    deliverOtpCode(
      { info: () => {} },
      { nodeEnv: "production", smtpUrl: null, otpFromEmail: "x@example.com" },
      { email: "m@example.com", logFields: {} },
      "123456",
      null,
    ),
  );
});
