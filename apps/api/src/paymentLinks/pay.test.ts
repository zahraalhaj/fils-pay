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

test("expiryReferenceTime: a recent submittedAt (within the grace window) round-trips exactly", () => {
  const now = new Date("2026-03-14T09:32:00.000Z");
  const iso = "2026-03-14T09:30:00.000Z";
  assert.equal(expiryReferenceTime(iso, now).toISOString(), iso);
});

test("expiryReferenceTime: an old or future submittedAt is not trusted (FP-187)", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");
  assert.equal(expiryReferenceTime("2026-03-14T09:30:00.000Z", now).toISOString(), now.toISOString());
  assert.equal(expiryReferenceTime("2026-10-30T12:10:00.000Z", now).toISOString(), now.toISOString());
});

test("expiryReferenceTime: an unparseable value -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("not-a-timestamp");
  assert.ok(!Number.isNaN(resolved.getTime()));
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});
