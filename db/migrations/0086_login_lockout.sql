-- Per-account login lockout (#88). nginx limits guesses per IP, but a
-- password can still be guessed from many IPs, and with login codes shown
-- on screen (#71) the password is effectively the only factor. After
-- LOGIN_MAX_FAILURES wrong passwords an account is locked for
-- LOGIN_LOCKOUT_MINUTES (apps/api/src/auth/lockout.ts); even the right
-- password is refused while locked.
ALTER TABLE merchant_users
    ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN locked_until TIMESTAMPTZ;
ALTER TABLE admin_users
    ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN locked_until TIMESTAMPTZ;
