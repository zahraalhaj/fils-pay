# Merchant registration

`/dashboard/register` collects a business display name, email and a 12–128 character password. It sends a six-digit email code. Verification creates an owner and merchant, authenticates a session, and saves the merchant ID for later sign-ins. The dashboard displays the merchant ID and pending approval notice.

New merchants have `onboarding_status=submitted` and `kyc_passed=false`. Existing admin KYC review is the approval path. Existing authorization checks reject payment acceptance before approval; email verification alone does not approve a merchant. Business profile/document collection remains the existing API/support workflow, not a new KYC form.

## API

- `POST /v1/auth/register`: `{displayName,email,password}`. Returns expiry and sets an HTTP-only registration cookie. Requires SMTP; never returns the OTP, even with demo OTP exposure enabled.
- `POST /v1/auth/register/verify`: `{code}` plus registration cookie. Creates the merchant/user/session transactionally only after successful verification.
- `POST /v1/auth/register/resend`: registration cookie. Resends no more frequently than every 30 seconds, without resetting expiry or attempt count.

Codes expire after ten minutes and allow five guesses. Tokens, passwords and codes are hashed in storage. Verification locks the pending row; email advisory locks serialize duplicate account creation through this flow. Emails are trimmed and lowercased. Registration refuses an email already present in merchant_users; existing per-merchant login remains supported. The legacy business-profile signup API is unchanged.

Five registrations per email or source IP per hour are permitted across API instances. Configure trusted proxy hops correctly so clients are not all counted as the edge address. Expired pending data older than one hour is removed on later registration attempts. Abandoned rows can also be purged periodically by operations.

## Deploy

1. Apply migration `0087_merchant_registration.sql` using the existing migration runner. Do not seed or reset the deployed database.
2. Pass `SMTP_URL` and `OTP_FROM_EMAIL` into the running API container and recreate/restart the API with the new source/image. Dilmune's static site variables do not automatically establish container environment configuration.
3. Set `OTP_DEV_EXPOSE=false` for login codes as well.
4. Build web and admin workspaces. Both clients now default to same-origin API calls; explicit VITE_API_BASE_URL/VITE_ADMIN_API_BASE_URL overrides remain available. Vite development proxies continue to route /v1 to localhost:3000.
5. Register with a real inbox, confirm no account exists before verification, verify the code, and confirm dashboard access with payment acceptance pending approval. Admin approval uses the existing admin KYC review route.

The login OTP recipient is now the exact merchant user whose password was verified, rather than an email-only lookup across tenants.

## Validation

New route tests cover verification, session boundaries, payment approval enforcement, duplicate email, wrong codes, expiry, resend cooldown and attempt preservation, unavailable SMTP, delivery failure, persistent rate limiting and the same-email tenant login boundary. Tests inject a mail transport and do not send real emails.
