# FilsPay second audit — 30 October 2026

Base: `97961ffc4cdb216b7228d6059c6509a53452f1cd` in `zahraalhaj/fils-pay`.
This pass fixes 13 issue groups: five previously tracked issues and eight new findings.
No live payment requests, migrations, seeds or operational money scripts were run.

| Issue | Trigger and impact | Change |
|---|---|---|
| #9 Payment-link reclaim | A slow capture outlasted the reservation timer; another buyer could claim the same link and pay again. | Only active links can be claimed. Reserved links remain processing regardless of age. An ambiguous capture response does not release the link; a definitive decline does. |
| #48 Expiry bypass | An unauthenticated buyer supplied an old submittedAt and paid an expired link. | Use server time, documented in ADR-0007. The previous offline-terminal behavior is not supported on this public endpoint. |
| #11 Duplicate callback notes | Two arrivals with the same callback ID both inserted notes. | Transaction-scoped advisory lock on callback ID, followed by a durable note lookup and insertion on the same connection. No historical notes are deleted. |
| #34 Callback authentication | Unsigned requests were accepted by default, old signatures replayed forever, JSON reserialization changed the signed bytes, and Buffer.compare was not constant time. | Require signatures by default and always in production, retain original JSON bytes, enforce a five-minute timestamp window and compare digests with timingSafeEqual. |
| #60 Callback validation | Truthy arbitrary outcomes, malformed transaction IDs and invalid dates reached persistence. | Validate allowed outcomes, field types, UUIDs and parseable timestamps before querying the DB. |
| #33 Export memory | The live route buffered every transaction plus the entire CSV string. | Return a Readable from an async generator using a server-side cursor and 1,000-row fetches. Consumer backpressure controls production. |
| #61 Missing CSV rows | Timestamp-only pagination skipped transactions at a page boundary, and JS Date cannot preserve PostgreSQL microseconds. | Use one snapshot cursor ordered by timestamp and ID. Close the transaction on completion, error or early consumer return. |
| #62 CSV text safety | Spreadsheet applications could evaluate merchant references beginning with formula characters. Bare carriage returns could split a record. | Prefix formula-like references with an apostrophe and quote carriage returns. Both CSV builders share the serializer. |
| #63 Repeated payout instructions | Initial deliveries to multiple endpoints and delivery replays each ran the payout instruction side effect. | Lock the settlement batch and insert only if no instruction exists, inside one transaction. Historical duplicate instructions remain for investigation. |
| #64 Webhook redirects | fetch followed an endpoint's redirect to an unchecked URL. | Disable automatic redirects; 3xx responses follow the normal failed-delivery policy. This is not a complete SSRF fix. |
| #65 Webhook response memory | A fast receiver could return an unlimited body within the request timeout and exhaust memory. | Retain at most 64 KiB and cancel the rest. |
| #66 Transaction error handling | Failed rollback hid the original exception and released a broken connection as healthy. | Preserve the original exception; pass rollback failure to pg release so the connection is discarded. |
| #67 Development startup | The fallback webhook encryption key decoded to 34 bytes and was rejected by the 32-byte validator. | Correct the development fallback length. Explicit environment keys and the production key requirement stay in effect. |

## Validation

- **187 tests passed, zero failures:** database-independent API tests and shared-package tests, invoked with `node --import tsx --test`. This includes Fastify injection checks for raw-body authentication, missing signatures, invalid payloads and the production enforcement rule; cursor pagination/cleanup, CSV safety, transport limits, payment-link refusal and transaction/payout query-order checks.
- Workspace `npm run typecheck` passed, including DB and scripts TypeScript compilation.
- `git diff --check` passed.
- Full `npm test` was attempted but its tsx CLI cannot create its Unix IPC socket here (`EPERM`). The direct Node invocation above avoids that runner restriction.
- No PostgreSQL server or Go toolchain is installed here. Real PostgreSQL cursor, lock, race and rollback integration tests and the Go suite were **not run**. The new parallel callback integration test and updated payment-link/callback integration expectations are committed for the project's database test environment.
- Injected query tests establish application decisions and statement order. They are not proof of real database concurrency semantics or a live acquirer end-to-end run.

## Changed expectations and operations

Tests that accepted unsigned callbacks, fixed historical signature timestamps,
client-clock expiry or automatic reservation recovery were corrected. Fresh
callback retries must carry fresh signatures while retaining their callback ID.
The timestamp window allows five minutes in either direction; sender/server
clocks need to agree within that limit. Unsigned sandbox mode must be explicitly
enabled outside production; production ignores that opt-out.

There is no database schema migration in this pass. The callback advisory lock
and batch lock serialize writes through these application paths; direct SQL or
another writer that bypasses this protocol is not protected by a new unique
constraint. Review existing duplicate callback notes/payout instructions rather
than deleting financial evidence automatically.

A crashed or uncertain payment-link attempt now stays processing. Resolve the
acquirer outcome and stored transaction before manually repairing the link.
This prevents a second buyer from being charged while the first outcome is
unknown. A durable attempt/recovery workflow remains future work.

The streaming export retains one DB connection and read transaction for the
response lifetime. Slow-client limits and export concurrency limits remain
operational considerations. Formula protection intentionally prefixes an
apostrophe on affected reference text in CSV files.

## Confirmed risks still open

- Refund reservations can remain consumed after an acquirer exception, process crash or journal failure. A durable refund attempt and reconciliation protocol is needed; blindly releasing an uncertain refund can pay twice.
- Refund-only negative batches do not carry their deficit into later payouts.
- Repeated paid-batch MDR recalculation can post the same correction again; refund-aware recomputation also needs correction. These Go money paths were inspected but not changed without executable settlement validation.
- Payout notification production still has a race (#52). The instruction side effect is now idempotent, but duplicate outbox notifications remain possible.
- Webhook delivery workers still lack a distributed claim protocol. At-least-once delivery is expected; overlapping attempts and retry bookkeeping need separate repair.
- Initial webhook destinations can still target private addresses; redirect prevention does not solve initial-URL or DNS-rebinding SSRF.
- Outbox commit ordering, poison-event recovery and remaining reporting issues need further work.
- A DB-level payment-link capture constraint (#10) is still absent. This pass removes the unsafe timeout re-claim path, not every possible out-of-band writer.

These are source-level findings, not claims of incidents reproduced against a live system in this pass.
