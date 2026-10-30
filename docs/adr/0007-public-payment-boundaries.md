# 0007. Public payment expiry and uncertain attempts

- Status: Accepted for this fix
- Date: 2026-10-30
- Supersedes: ARCHITECTURE client-clock expiry and automatic timeout reclaim

A public submittedAt is not authenticated evidence of when a customer paid.
Even a five-minute bound lets someone pay a recently expired link. Public
checkout uses server time.

A timeout or lost processor response cannot prove a charge did not happen.
Only active links are claimable. Reserved links stay processing after timeout
or process failure until an operator reconciles the attempt. Explicit declines
can release the owned reservation. Zahra's reservation ID check and atomic
capture/link update remain defense in depth.

This trades automatic recovery for preventing a second buyer from charging an
uncertain link. Durable automatic recovery would require stored attempt ownership,
processor inquiry/reconciliation and stable processor idempotency across retries.
Those are outside this change.
