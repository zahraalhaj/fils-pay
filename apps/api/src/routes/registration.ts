import { randomBytes, randomInt } from "node:crypto";
import { getMailer, type Mailer } from "../lib/mailer.js";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../auth/passwords.js";
import { hashOtpCode, verifyOtpCode } from "../auth/otp.js";
import { sendOtpCode } from "../auth/notifier.js";
import { createPendingSession, promoteSession } from "../auth/sessions.js";
import { issueChallenge } from "../auth/otp.js";
import { sha256Hex } from "../lib/crypto.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, ConflictError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

const COOKIE = "fp_registration";
const TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const code = () => randomInt(0, 1_000_000).toString().padStart(6, "0");

export async function registrationRoutes(app: FastifyInstance, options: { mailer?: Mailer }): Promise<void> {
  app.post<{ Body: { displayName?: string; email?: string; password?: string } }>("/register", {
    bodyLimit: 4096,
  }, async (request, reply) => {
    const body = request.body ?? {};
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = body.password;
    if (displayName.length < 2 || displayName.length > 120 || email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== "string" ||
        password.length < 12 || password.length > 128) {
      throw new BadRequestError("invalid_registration", "Enter a business name, valid email and a password of 12–128 characters.");
    }
    // Codes are never exposed by registration, including demo deployments.
    if (!getMailer(app.config)) throw new BadRequestError("email_unavailable", "Email delivery is not configured yet. Please try again later.");
    const rawToken = randomBytes(32).toString("hex");
    const otp = code();
    const salt = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + TTL_MS);
    
    const id = await withTransaction(app.db, async (client) => {
      // Shared DB limits survive restarts and work across API instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["registration-ip:" + request.ip]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["registration-email:" + email]);
      // Keep the one-hour abuse window, then remove expired personal data.
      await client.query("DELETE FROM merchant_registrations WHERE expires_at < now() AND created_at < now() - interval '1 hour'");
      const recent = await client.query<{ count: string }>(
        `SELECT count(*) FROM merchant_registrations
          WHERE (ip_address = $1 OR email = $2) AND created_at > now() - interval '1 hour'`,
        [request.ip, email]);
      if (Number(recent.rows[0]!.count) >= 5) throw new TooManyRequestsError("registration_rate_limited", "Too many registration requests. Try again in an hour.");
      const exists = await client.query("SELECT 1 FROM merchant_users WHERE lower(email) = $1 LIMIT 1", [email]);
      if (exists.rowCount) throw new ConflictError("account_exists", "An account already uses this email. Sign in with your merchant ID.");
      const passwordHash = await hashPassword(password, app.config);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO merchant_registrations
          (token_hash, display_name, email, password_hash, code_salt, code_hash, expires_at, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [sha256Hex(rawToken), displayName, email, passwordHash, salt, hashOtpCode(otp, salt), expiresAt, request.ip]);
      return inserted.rows[0]!.id;
    });
    await sendOtpCode(request.log, app.config, { merchantUserId: id, email }, otp, options.mailer);
    reply.setCookie(COOKIE, rawToken, { httpOnly: true, secure: app.config.cookieSecure,
      sameSite: "lax", path: "/v1/auth", maxAge: TTL_MS / 1000 });
    return reply.code(201).send({ otpRequired: true, otpExpiresAt: expiresAt.toISOString() });
  });

  app.post<{ Body: { code?: string } }>("/register/verify", { bodyLimit: 1024 }, async (request, reply) => {
    const otp = request.body?.code;
    if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) throw new BadRequestError("invalid_code", "Enter the six-digit code.");
    const token = request.cookies[COOKIE];
    if (!token) throw new UnauthorizedError("registration_expired", "Start registration again.");
    const result = await withTransaction(app.db, async (client) => {
      const rows = await client.query<{
        id: string; display_name: string; email: string; password_hash: string;
        code_salt: string; code_hash: string; attempt_count: number; expires_at: Date; consumed_at: Date | null;
      }>("SELECT * FROM merchant_registrations WHERE token_hash = $1 FOR UPDATE", [sha256Hex(token)]);
      const row = rows.rows[0];
      if (!row || row.consumed_at || row.expires_at.getTime() <= Date.now()) return { error: "expired" } as const;
      if (row.attempt_count >= MAX_ATTEMPTS) return { error: "attempts" } as const;
      await client.query("UPDATE merchant_registrations SET attempt_count = attempt_count + 1 WHERE id = $1", [row.id]);
      if (!verifyOtpCode(otp, row.code_salt, row.code_hash)) return { error: "invalid" } as const;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["registration-email:" + row.email]);
      const existing = await client.query("SELECT 1 FROM merchant_users WHERE lower(email) = $1 LIMIT 1", [row.email]);
      if (existing.rowCount) return { error: "exists" } as const;
      const merchant = await client.query<{ id: string }>(
        "INSERT INTO merchants (display_name, onboarding_status, kyc_passed) VALUES ($1, 'submitted', false) RETURNING id", [row.display_name]);
      const merchantId = merchant.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        "INSERT INTO merchant_users (merchant_id,email,role,password_hash) VALUES ($1,$2,'owner',$3) RETURNING id",
        [merchantId, row.email, row.password_hash]);
      const merchantUserId = user.rows[0]!.id;
      // Reuse existing authenticated session machinery after registration OTP.
      const challenge = await issueChallenge(client, { merchantUserId, ttlMinutes: 1, codeLength: 6, maxAttempts: 1 });
      await client.query("UPDATE otp_challenges SET consumed_at = now() WHERE id = $1", [challenge.id]);
      const session = await createPendingSession(client, { merchantUserId, otpChallengeId: challenge.id,
        ttlMinutes: 10, ipAddress: request.ip });
      await promoteSession(client, session.id, app.config.sessionTtlHours);
      await client.query("UPDATE merchant_registrations SET consumed_at = now(), password_hash = '', code_hash = '' WHERE id = $1", [row.id]);
      return { merchantId, rawToken: session.rawToken };
    });
    if ("error" in result) {
      if (result.error === "attempts") throw new TooManyRequestsError("too_many_attempts", "Start registration again.");
      if (result.error === "invalid") throw new UnauthorizedError("invalid_code");
      if (result.error === "exists") throw new ConflictError("account_exists", "Your account already exists. Please sign in.");
      throw new GoneError("registration_expired", "Code expired. Start registration again.");
    }
    reply.clearCookie(COOKIE, { path: "/v1/auth" });
    reply.setCookie(app.config.cookieName, result.rawToken, { httpOnly: true, secure: app.config.cookieSecure,
      sameSite: "lax", path: "/", maxAge: app.config.sessionTtlHours * 3600 });
    return { authenticated: true, merchantId: result.merchantId, role: "owner" };
  });

  app.post("/register/resend", async (request) => {
    const token = request.cookies[COOKIE];
    if (!token) throw new UnauthorizedError("registration_expired", "Start registration again.");
    const otp = code();
    const salt = randomBytes(16).toString("hex");
    const row = await withTransaction(app.db, async (client) => {
      const updated = await client.query<{ id: string; email: string; expires_at: Date }>(
        `UPDATE merchant_registrations SET code_salt = $2, code_hash = $3, sent_at = now()
          WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
            AND attempt_count < $4 AND sent_at <= now() - interval '30 seconds'
          RETURNING id, email, expires_at`, [sha256Hex(token), salt, hashOtpCode(otp, salt), MAX_ATTEMPTS]);
      return updated.rows[0];
    });
    if (!row) throw new TooManyRequestsError("resend_unavailable", "Wait 30 seconds before resending. If your code expired, start registration again.");
    await sendOtpCode(request.log, app.config, { merchantUserId: row.id, email: row.email }, otp, options.mailer);
    return { otpRequired: true, otpExpiresAt: row.expires_at.toISOString() };
  });
}
