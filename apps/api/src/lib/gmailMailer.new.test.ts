import assert from "node:assert/strict";
import { test } from "node:test";
import { getMailer } from "./mailer.js";
import { loadConfig } from "../config.js";

const credentials = { smtpUrl: "smtp://blocked.invalid", gmailClientId: "client", gmailClientSecret: "secret",
  gmailRefreshToken: "refresh" };
const message = { from: "FilsPay <sender@gmail.com>", to: "owner@example.com", subject: "Your code", text: "Code: 123456" };

test("Gmail sends MIME over HTTPS and refreshes its token without using SMTP", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(calls.length === 1 ? { access_token: "access" } : { id: "sent" }));
  });
  await getMailer(credentials)!.send(message);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://oauth2.googleapis.com/token");
  const form = calls[0]!.init.body as URLSearchParams;
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "refresh");
  assert.equal(calls[1]!.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal((calls[1]!.init.headers as Record<string, string>).Authorization, "Bearer access");
  const raw = JSON.parse(calls[1]!.init.body as string).raw;
  const mime = Buffer.from(raw, "base64url").toString();
  assert.match(mime, /To: owner@example.com/);
  assert.match(mime, /Code: 123456/);
  assert.ok(calls.every((c) => c.init.signal instanceof AbortSignal && c.init.redirect === "error"));
});

test("provider errors are redacted and do not fall back to SMTP", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("secret refresh 123456", { status: 400 }));
  await assert.rejects(getMailer(credentials)!.send(message), { message: "Gmail API HTTP 400" });
});

test("network failures are redacted", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret token"); });
  await assert.rejects(getMailer(credentials)!.send(message), { message: "Gmail API connection failed or timed out" });
});

test("incomplete Gmail credentials fail closed; absent mail remains optional", () => {
  assert.throws(() => getMailer({ smtpUrl: null, gmailClientId: "client" }), /requires/);
  assert.equal(getMailer({ smtpUrl: null }), null);
  const config = loadConfig({ DATABASE_URL: "postgres://localhost/test", GMAIL_CLIENT_ID: "client",
    GMAIL_CLIENT_SECRET: "secret", GMAIL_REFRESH_TOKEN: "refresh" });
  assert.equal(config.gmailRefreshToken, "refresh");
  assert.ok(getMailer(config));
});
