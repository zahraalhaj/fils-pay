import nodemailer from "nodemailer";
import type { Config } from "../config.js";

/** The one thing the OTP notifiers need from a mail transport, so tests can
 *  pass a stub instead of a real SMTP connection. */
export interface Mailer {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

let cached: { url: string; mailer: Mailer } | null = null;

/** An SMTP mailer for config.smtpUrl, or null when none is configured. One
 *  transport per URL, reused across requests. */
export function getMailer(config: Pick<Config, "smtpUrl">): Mailer | null {
  if (!config.smtpUrl) return null;
  if (cached?.url !== config.smtpUrl) {
    const transport = nodemailer.createTransport(config.smtpUrl);
    cached = {
      url: config.smtpUrl,
      mailer: {
        async send(message) {
          await transport.sendMail(message);
        },
      },
    };
  }
  return cached.mailer;
}
