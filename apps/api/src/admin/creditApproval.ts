import { ConflictError } from "../lib/errors.js";

export interface CreditActor {
  adminUserId: string;
  displayName: string;
}

/**
 * Second-approver rule: the approver must be a different admin user. Compared
 * by admin user id (HANDOVER) — display names aren't unique and can be edited,
 * so comparing them let an admin approve their own credit after a rename, and
 * blocked two different admins who happened to share a name.
 */
export function assertDistinctApprover(requester: CreditActor, approver: CreditActor): void {
  if (approver.adminUserId === requester.adminUserId) {
    throw new ConflictError("self_approval_forbidden");
  }
}
