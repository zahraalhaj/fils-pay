# Missing fixes rebuilt after Zahra's push

## Base and scope

Reviewed c956f58a61db689e60f5611630c21b338173d27d, including Zahra's
a5ebd2490097118bf37441317e605959b7c51af6 ("fixed more bugs").
Compared it with the reverted 97961ff and 9719398 audit fixes.

This change rebuilds the remaining gaps on that base. It does not merge the
upstream PRs or reapply the old audit commits wholesale.

## Existing work retained

| Area | Decision |
|---|---|
| Child-report ownership | Zahra already enforces the parent-child relationship |
| Credit approval | Her stable-user-ID comparison already fixes the defect |
| Key rotation | Preserve her 24-hour overlap and revoke_after verification |
| Outbound webhook signatures | Preserve her serialize-once signature/body API |
| CSV pagination | Preserve async generator, backpressure and microsecond-safe keyset |
| Rollback handling and development key | Her fixes already cover the saved work |
| Callback deduplication and freshness | Preserve her database constraint and five-minute check |
| Payment capture | Keep reservation ownership checks and atomic capture/link update |

## Changes and rationale

1. Callbacks: retain original JSON bytes in the route's encapsulated parser,
   pass them to the verifier, validate types/outcome/UUID/date before database
   access, and require authentication in production regardless of the flag.
   Preserve the verifier's existing fifth timestamp argument and failure codes.
2. Payment expiry: always use server time, including requests within the old
   five-minute client grace window. See ADR-0007 for the security decision.
3. Payment uncertainty: claim only active links. Do not release ownership on a
   timeout, error, in-progress conflict or unknown result. Explicit authorization
   or capture declines can release only the current reservation. Public reads
   keep reserved links processing. A process crash requires operator
   reconciliation; automatic recovery is outside this change.
4. CSV: neutralize formula-prefixed reference text and quote carriage returns
   through the shared row formatter, so streaming and buffered exports agree.
5. Payout instructions: lock the settlement batch and conditionally insert in
   one transaction. Repeated callers serialize and existing instructions remain.
   This guards this helper, not arbitrary direct SQL writers; historical
   duplicates are not deleted.
6. Webhook transport: refuse automatic redirects, retain at most 64 KiB of the
   response and cancel the reader while preserving the request timeout.
   This does not claim to fix every SSRF vector: DNS/private-address validation
   remains a separate open concern in the tracker.

## Regression coverage

postZahraGaps.new.test.ts covers raw callback bytes, tampering, malformed fields,
production signature enforcement, expired/reserved payment rejection, uncertain
versus declined captures, both CSV paths, bounded webhook reads, redirect refusal,
and repeated/concurrent payout helper calls using injected dependencies.

Updated the existing recent-client-timestamp and expired-reservation expectations
because they encoded the behavior this change intentionally replaces. The
database double-charge test now expects buyer B blocked and buyer A paid once,
instead of allowing buyer B to take over a slow attempt.

No live acquirer calls, production database operations or external webhook sends.

## Validation

Validation results are appended below after checks complete. PostgreSQL and Go
are unavailable in this environment; injected SQL fixtures cannot establish real
database locking, transaction isolation or migration correctness.

- Workspace TypeScript checks: passed (including the database integration test sources).
- Database-independent group: 196 tests passed across 33 files, including
  the seven new regression tests and existing payment/status/signature tests.
- Broader direct Node test attempt: 206 passed; 53 test files failed to load
  because they require DATABASE_URL and a migrated real PostgreSQL database.
  This is not a passing integration run.
- Added a real PostgreSQL concurrent/repeated payout regression to
  payoutDisbursement.test.ts; it remains unrun here.
- Go tests were not run (Go unavailable); no Go code was changed.
- Diff whitespace/conflict checks passed. No migrations added or edited.

Commands used: npm run typecheck; node --import tsx --test
--test-concurrency=1 with the database-independent files; and a broader direct
Node run over API, money/events, reporting, web and script tests. Direct Node
loading avoids the environment's tsx CLI IPC socket restriction.
