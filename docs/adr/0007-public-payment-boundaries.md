# 0007. Public checkout and callback authentication

- Status: Accepted
- Date: 2026-10-30
- Supersedes: ARCHITECTURE's client-clock expiry and timeout self-recovery descriptions

The public payment-link endpoint has no trusted offline-terminal identity or
clock attestation. An arbitrary submittedAt cannot prove an expired payment
was initiated on time. A reservation timeout cannot prove that a slow acquirer
has not charged a card.

Use server time for public expiry. Only active links may be claimed. Keep a
reservation after a crash or uncertain capture result; do not automatically
make it payable again. A definitive capture decline may release it. An operator
must reconcile any uncertain attempt with the acquirer and stored transaction
before repairing its status. Automatic crash recovery needs a durable attempt
record and an acquirer inquiry protocol and is outside this patch.

Acquirer callbacks require signatures by default and always in production.
The HMAC covers timestamp plus the original HTTP JSON bytes; signatures must
be within five minutes of server time, including future skew. Compare digests
with timingSafeEqual. The sender must sign each retry with a fresh timestamp,
while keeping its callback ID stable. Transactional callback-ID deduplication
prevents a repeated delivery from creating a second note. Explicit unsigned
sandbox mode is available only outside production.

This deliberately replaces tests that encoded acceptance of backdated checkout
requests and unsigned/stale callbacks. Those expectations were security defects.

## Integrated durable payer claims

The upstream PR integration adds persisted hashed payer/request ownership and
reuses persistent authorize/capture idempotency records. After the lease expires,
only that exact payer request may resume; another payer cannot reclaim the link.
Legacy reservations without ownership remain blocked for reconciliation. This
supersedes the restriction on same-request recovery above while preserving the
prohibition on releasing uncertain charges for a different payment attempt.
