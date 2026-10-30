/**
 * Login codes are emailed, never shown or logged, whenever SMTP is
 * configured. SMTP is optional again (original OTP behaviour, #71/#72):
 * without it production starts and never logs the code.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import type { Mailer } from "../lib/mailer.js";
import { sendOtpCode } from "./notifier.js";
import { sendAdminOtpCode } from "../adminAuth/notifier.js";

function capturingLogger() {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return { lines, info: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }) };
}

const smtpConfig = { nodeEnv: "production" as const, smtpUrl: "smtp://x", otpFromEmail: "FilsPay <no-reply@x>" };

test("with SMTP configured the code is emailed to the user and never logged", async () => {
  const sent: Array<{ to: string; text: string }> = [];
  const mailer: Mailer = { send: async (m) => void sent.push(m) };
  const logger = capturingLogger();

  await sendOtpCode(logger, smtpConfig, { merchantUserId: "u-1", email: "owner@shop.test" }, "482913", mailer);
  await sendAdminOtpCode(logger, smtpConfig, { adminUserId: "a-1", email: "ops@filspay.test" }, "771204", mailer);

  assert.deepEqual(sent.map((m) => m.to), ["owner@shop.test", "ops@filspay.test"]);
  assert.match(sent[0]!.text, /482913/);
  assert.ok(!JSON.stringify(logger.lines).includes("482913"), "the code must not be logged");
  assert.ok(!JSON.stringify(logger.lines).includes("771204"));
});

test("a failed email surfaces as an error instead of silently losing the code", async () => {
  const mailer: Mailer = { send: async () => Promise.reject(new Error("smtp down")) };
  await assert.rejects(
    sendOtpCode(capturingLogger(), smtpConfig, { merchantUserId: "u", email: "e@x" }, "1", mailer),
    /could not be emailed/,
  );
});

test("production starts without SMTP_URL and never logs the code", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://localhost/x",
    NODE_ENV: "production",
    SETTLEMENT_INTERNAL_TOKEN: "t",
    ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Zmlsc3BheS1kZXYtb25seS13ZWJob29rLWtleS0zMmI=",
  });
  assert.equal(config.smtpUrl, null);
  const logger = capturingLogger();
  await sendOtpCode(logger, config, { merchantUserId: "u", email: "e@x" }, "424242", null);
  assert.ok(!JSON.stringify(logger.lines).includes("424242"));
});
