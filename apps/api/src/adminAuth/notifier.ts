import type { Config } from "../config.js";
import { deliverOtpCode, type MinimalLogger } from "../auth/notifier.js";
import { getMailer, type Mailer } from "../lib/mailer.js";

/** Admin OTP delivery — same rules as auth/notifier.ts: emailed when SMTP is
 *  configured (always in production), logged only in development. */
export async function sendAdminOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "nodeEnv" | "smtpUrl" | "otpFromEmail">,
  recipient: { adminUserId: string; email: string },
  code: string,
  mailer?: Mailer | null,
): Promise<void> {
  await deliverOtpCode(
    logger,
    config,
    { email: recipient.email, logFields: { adminUserId: recipient.adminUserId, channel: "admin_otp" } },
    code,
    mailer === undefined ? getMailer(config) : mailer,
  );
}
