# Upstream pull-request integration — 30 October 2026

Target: zahraalhaj/fils-pay main, starting at 97961ffc4cdb216b7228d6059c6509a53452f1cd.

## Sources

- MJ5-byte/fils-pay #5, FP-300 audit fixes, head 4a68dc9265e6d15964f6852fbe2e97d55f884262.
- #9, deploy hardening, head 150a8f8d07056d2b2f8bb097fc0a8e5bba90430f. Includes #5.
- #11, fork-mined fixes, head 42f7a3771371804fbd151d32ac26dafc548a9c74.
- #13, fork security review, head 6d2354ff053443cfb3d87f53354f54d80598e1f8.
  Its tree already matched the target's starting tree; preserve those fixes.

The source PRs remain open. This integration changes only the destination repository.

## Conflict decisions

Preserve existing integer-fils calculations, Bahrain scheduler helper and tests,
journal accounts and advisory-lock protection in the March reconciliation,
API-key revocation, report ownership, approval identity and raw-body webhook signatures.

Use #11's durable payer-bound payment-link claims, scoped refunds, pending
refund reservations, login limits, active-merchant session checks, webhook
delivery claims and SSRF protection. Retain #9's deployment files, CORS,
load shedding, bigint totals and other non-overlapping changes.

Keep the source evidence and bug documentation. Restore the unified CLAUDE.md
conventions so AGENTS.md does not reference a deleted file.

## Integration corrections

- Remove duplicate imports, refund event dispatch cases and webhook eligibility entries.
- Resolve reporting refund rollup parameters and the refund drawer's stale retry reference.
- Set transactions.refunded_fils alongside status after a successful reserved refund.
  Pending refunds remain excluded from the settled total but consume refund capacity.
- Keep the fee reversal aggregate read under the journal lock; remove an obsolete
  reference to a fee aggregate column that is no longer selected.
- Make overlapping refund-rollup column additions and payout-event unique-index
  creation repeat-safe across the independently authored migration files.
- Keep both Bahrain date helper APIs and the split allocation helper's sort import.
- Adapt the injected webhook regression fixture to the new claim query and
  one-delivery-at-a-time loop. Keep the independent raw-body HMAC assertion.
- Use the same serialization convention for payload signing and verification.

## Validation

- Workspace TypeScript checks passed.
- Merchant dashboard production build passed.
- 27 focused tests passed: existing fork security regressions, refund state,
  webhook signatures, load shedding and refundable drawer amounts.
- The npm test entrypoint cannot create tsx's IPC socket in this environment.
  Running tests directly with node --import tsx bypasses that restriction.
- The broader direct test attempt exposed missing DATABASE_URL/PostgreSQL
  prerequisites; it is not a passing integration run.
- PostgreSQL migration execution and database-backed tests remain unverified.
- Go is not installed here; Go build/tests remain unverified.

This is a source integration, not a deployment or a claim of production readiness.

## Concurrent destination update

Before publication main advanced to 9719398ab1537eecfe2d052899773772b5b3722a.
Reconciled its callback validation/authentication, cursor-based CSV export,
payout-instruction idempotency, rollback handling, configuration and documentation.
Retained PR11's DNS-pinned webhook transport (which already refuses redirects and
bounds response memory) and durable payer-bound payment-link recovery. Different
payers cannot reclaim a reservation after timeout. Updated injected regressions
for those replacement implementations. The concurrency safeguard prevented
overwriting the incoming commit.

Both dashboard production builds and 191 database-independent tests passed before
this reconciliation; validation was rerun afterward as recorded in the commit.

Final reconciliation validation: workspace TypeScript checks passed; 203
database-independent tests passed, including all 12 incoming audit regressions.
The dashboard sources are unchanged from the successful production builds.
PostgreSQL integration/migration execution and Go checks remain unavailable.
