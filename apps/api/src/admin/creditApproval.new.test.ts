/** #25: self-approval is decided by admin user id, not display name. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDistinctApprover } from "./creditApproval.js";

test("the same admin can't approve their own credit, even after a rename", () => {
  assert.throws(
    () =>
      assertDistinctApprover(
        { adminUserId: "a-1", displayName: "Fay Finance" },
        { adminUserId: "a-1", displayName: "Fay F. (renamed)" },
      ),
    /self_approval_forbidden/,
  );
});

test("two different admins who share a display name can approve each other's credits", () => {
  assert.doesNotThrow(() =>
    assertDistinctApprover({ adminUserId: "a-1", displayName: "Sam" }, { adminUserId: "a-2", displayName: "Sam" }),
  );
});
