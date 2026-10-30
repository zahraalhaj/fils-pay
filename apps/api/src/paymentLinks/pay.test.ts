import assert from "node:assert/strict";
import { test } from "node:test";
import { expiryReferenceTime } from "./pay.js";

// Tolerance for comparing a freshly-minted Date against the test's own
// `Date.now()` — generous enough not to flake on a loaded CI box.
const TOLERANCE_MS = 5_000;

test("expiryReferenceTime: no value -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime();
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

test("expiryReferenceTime: empty string -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("");
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

// Unauthenticated timestamps cannot extend a link's lifetime.
test("expiryReferenceTime: a backdated client timestamp cannot override server time", () => {
  const iso = "2026-03-14T09:30:00.000Z";
  assert.ok(Math.abs(expiryReferenceTime(iso).getTime() - Date.now()) < TOLERANCE_MS);
});

test("expiryReferenceTime: an unparseable value -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("not-a-timestamp");
  assert.ok(!Number.isNaN(resolved.getTime()));
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});
