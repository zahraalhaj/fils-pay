import nodemailer from "nodemailer";
import type { Config } from "../config.js";

export interface Mailer {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

type MailConfig = Pick<Config, "smtpUrl"> & Partial<Pick<Config,
  "gmailClientId" | "gmailClientSecret" | "gmailRefreshToken">>;
let cached: { url: string; mailer: Mailer } | null = null;

/** HTTPS calls have a bounded deadline and never include provider response
 * bodies in errors: those may contain credentials or message contents. */
async function gmailRequest(url: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gmail API HTTP ${response.status}`);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && /^Gmail API HTTP \d+$/.test(error.message)) throw error;
    throw new Error("Gmail API connection failed or timed out");
  }
}

/** Gmail API takes precedence when configured, so a blocked SMTP URL can
 * remain during rollout. Credentials stay on the backend. */
export function getMailer(config: MailConfig): Mailer | null {
  const { gmailClientId, gmailClientSecret, gmailRefreshToken } = config;
  if (gmailClientId || gmailClientSecret || gmailRefreshToken) {
    if (!gmailClientId || !gmailClientSecret || !gmailRefreshToken) {
      throw new Error("Gmail API requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN");
    }
    // Nodemailer composes RFC-compliant MIME without opening an SMTP socket.
    const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
    return {
      async send(message) {
        const response = await gmailRequest("https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({ client_id: gmailClientId, client_secret: gmailClientSecret,
            refresh_token: gmailRefreshToken, grant_type: "refresh_token" }),
        });
        const token = await response.json() as { access_token?: string };
        if (typeof token.access_token !== "string" || !token.access_token) {
          throw new Error("Gmail API did not return an access token");
        }
        const composed = await composer.sendMail(message);
        if (!Buffer.isBuffer(composed.message)) throw new Error("Gmail MIME composition failed");
        const raw = composed.message.toString("base64url");
        const sent = await gmailRequest("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw }),
        });
        await sent.body?.cancel();
      },
    };
  }
  if (!config.smtpUrl) return null;
  if (cached?.url !== config.smtpUrl) {
    const transport = nodemailer.createTransport(config.smtpUrl, {
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    });
    cached = { url: config.smtpUrl, mailer: { async send(message) { await transport.sendMail(message); } } };
  }
  return cached.mailer;
}
