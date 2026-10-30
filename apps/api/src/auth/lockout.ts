import type { Pool } from "pg";
import { TooManyRequestsError } from "../lib/errors.js";

/**
 * Per-account password lockout for merchant and admin logins (#88,
 * migration 0086). Counting is one atomic UPDATE, so parallel guesses
 * cannot slip past the limit; locking resets the counter, so a fresh
 * budget starts when the lock expires.
 */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCKOUT_MINUTES = 15;

type AccountTable = "merchant_users" | "admin_users";

/** Refuses the attempt (before the password is even checked) while locked. */
export async function assertNotLocked(db: Pool, table: AccountTable, userId: string): Promise<void> {
  const result = await db.query<{ locked: boolean }>(
    `SELECT locked_until IS NOT NULL AND locked_until > now() AS locked FROM ${table} WHERE id = $1`,
    [userId],
  );
  if (result.rows[0]?.locked) {
    throw new TooManyRequestsError("account_locked", "too many failed sign-in attempts; try again later");
  }
}

export async function recordLoginFailure(db: Pool, table: AccountTable, userId: string): Promise<void> {
  await db.query(
    `UPDATE ${table}
        SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
            locked_until = CASE WHEN failed_login_count + 1 >= $2
                                THEN now() + make_interval(mins => $3) ELSE locked_until END
      WHERE id = $1`,
    [userId, LOGIN_MAX_FAILURES, LOGIN_LOCKOUT_MINUTES],
  );
}

export async function clearLoginFailures(db: Pool, table: AccountTable, userId: string): Promise<void> {
  await db.query(
    `UPDATE ${table} SET failed_login_count = 0, locked_until = NULL
      WHERE id = $1 AND (failed_login_count <> 0 OR locked_until IS NOT NULL)`,
    [userId],
  );
}
