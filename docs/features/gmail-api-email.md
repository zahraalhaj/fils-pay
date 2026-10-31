# Gmail API email delivery

When outbound SMTP is blocked, the API can send registration, merchant login,
and admin login codes through Gmail's HTTPS API. Existing OTP verification,
expiry, attempts, sessions, and payment approval rules are unchanged.

Set all three backend-only values in ops/.env.docker:
GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.
OTP_FROM_EMAIL must use the Gmail mailbox that granted the gmail.send scope
(or an authorized sender alias). Gmail takes precedence over SMTP_URL when
configured. Partial Gmail credentials fail closed, without SMTP fallback.

After pulling main, run `python3 scripts/configure_gmail.py` from a terminal.
It prompts privately and preserves unrelated environment settings. Never put
credentials in git, frontend VITE variables, screenshots, or command arguments.
Then build and recreate only api with the existing compose + override files.
No migration or reseeding is required for this transport change.

Authorize the sender using your own OAuth client (OAuth Playground redirect:
https://developers.google.com/oauthplayground), offline access, and only
https://www.googleapis.com/auth/gmail.send. Save the refresh token, not the
short-lived access token. Recipients do not need to authorize Google OAuth.
External OAuth projects in Testing issue refresh tokens lasting seven days;
reauthorize for demos or complete Google's production setup for ongoing use.
Using Playground's default client also causes its 24-hour token revocation.

Each HTTPS request has a ten-second deadline (refresh plus send: up to twenty
seconds for network requests). API errors report only HTTP status, not response
bodies or credentials. SMTP also has bounded connection/greeting/socket timeouts.
No automatic send retries: delivery can be uncertain after a network failure.

References:
- https://developers.google.com/workspace/gmail/api/guides/sending
- https://developers.google.com/identity/protocols/oauth2
