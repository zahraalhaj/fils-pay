/** #28: the API must boot in development without an explicit webhook key. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

test("loadConfig works in development with the built-in webhook encryption key", () => {
  const config = loadConfig({ DATABASE_URL: "postgres://localhost/x", NODE_ENV: "development" });
  assert.equal(Buffer.from(config.webhookSecretEncryptionKey, "base64").length, 32);
});

test("production still refuses to boot without an explicit webhook key", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/x",
        NODE_ENV: "production",
        SETTLEMENT_INTERNAL_TOKEN: "t",
        ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
        SMTP_URL: "smtp://localhost:2525",
      }),
    /WEBHOOK_SECRET_ENCRYPTION_KEY/,
  );
});

test("OTP_DEV_EXPOSE: off by default in production, honoured when set (original behaviour, #71)", () => {
  const prod = loadConfig({
    DATABASE_URL: "postgres://localhost/x",
    NODE_ENV: "production",
    OTP_DEV_EXPOSE: "true",
    SETTLEMENT_INTERNAL_TOKEN: "t",
    ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Zmlsc3BheS1kZXYtb25seS13ZWJob29rLWtleS0zMmI=",
    SMTP_URL: "smtp://localhost:2525",
  });
  assert.equal(prod.otpDevExpose, true);
  const { OTP_DEV_EXPOSE: _unset, ...prodDefault } = {
    DATABASE_URL: "postgres://localhost/x",
    NODE_ENV: "production",
    OTP_DEV_EXPOSE: "true",
    SETTLEMENT_INTERNAL_TOKEN: "t",
    ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Zmlsc3BheS1kZXYtb25seS13ZWJob29rLWtleS0zMmI=",
  };
  assert.equal(loadConfig(prodDefault).otpDevExpose, false);
  assert.equal(loadConfig({ DATABASE_URL: "postgres://localhost/x", NODE_ENV: "development" }).otpDevExpose, true);
});
