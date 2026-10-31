import type { Config } from "../config.js";
import { InternalError } from "../lib/errors.js";
import { getMailer, type Mailer } from "../lib/mailer.js";

/**
 * OTP delivery. With SMTP configured (always, in production) the code is
 * emailed and never logged. Without it — development and tests only — the
 * code is written to the log so a developer can sign in.
 */

/** Subset of the Fastify logger, so tests can pass a stub. */
export interface MinimalLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error?: (obj: Record<string, unknown>, msg: string) => void;
}

/** Shared by the merchant and admin notifiers. */
export async function deliverOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "nodeEnv" | "smtpUrl" | "otpFromEmail"> & Partial<Pick<Config, "otpDevExpose" | "gmailClientId" | "gmailClientSecret" | "gmailRefreshToken">>,
  recipient: { email: string; logFields: Record<string, unknown> },
  code: string,
  mailer: Mailer | null = getMailer(config),
): Promise<void> {
  if (mailer) {
    try {
      await mailer.send({
        from: config.otpFromEmail,
        to: recipient.email,
        subject: `Your FilsPay sign-in code: ${code}`,
        text: `Your FilsPay sign-in code is ${code}.\n\nIt expires in a few minutes. If you didn't try to sign in, ignore this email.`,
      });
    } catch (err) {
      logger.error?.({ ...recipient.logFields, err: String(err) }, "otp email delivery failed");
      throw new InternalError("otp_delivery_failed", "the sign-in code could not be emailed; try again");
    }
    logger.info(recipient.logFields, "otp code emailed");
    return;
  }
  if (config.nodeEnv === "production") {
    // Never log the code in production; with OTP_DEV_EXPOSE the login
    // response carries it to the screen instead.
    logger.info(recipient.logFields, "otp code generated");
    return;
  }
  logger.info({ ...recipient.logFields, code }, "otp code generated (dev, no SMTP configured)");
}

export async function sendOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "nodeEnv" | "smtpUrl" | "otpFromEmail"> & Partial<Pick<Config, "otpDevExpose" | "gmailClientId" | "gmailClientSecret" | "gmailRefreshToken">>,
  recipient: { merchantUserId: string; email: string },
  code: string,
  mailer?: Mailer | null,
): Promise<void> {
  await deliverOtpCode(
    logger,
    config,
    { email: recipient.email, logFields: { merchantUserId: recipient.merchantUserId, channel: "otp" } },
    code,
    mailer === undefined ? getMailer(config) : mailer,
  );
}
