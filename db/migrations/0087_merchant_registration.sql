-- Pending registrations grant no merchant authority. Passwords and OTPs are hashed.
CREATE TABLE merchant_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    code_salt TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address TEXT NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE INDEX merchant_registrations_ip_created ON merchant_registrations (ip_address, created_at);
CREATE INDEX merchant_registrations_email_created ON merchant_registrations (email, created_at);
