import assert from "node:assert/strict";
import test from "node:test";
import { bahrainDateTime, bhd, parseBhdInput } from "./format.js";

/**
 * The BHD amount field on payment-link, capture and refund forms. Every case
 * goes through @filspay/money's parseBhdToFils (1 BHD = 1000 fils, integer
 * storage); these pin the conversions the UI previews to the user.
 */
test("parseBhdInput converts BHD text to integer fils via the shared parser", () => {
  assert.deepEqual(parseBhdInput("18.5"), { ok: true, fils: 18500 });
  assert.deepEqual(parseBhdInput("18.500"), { ok: true, fils: 18500 });
  assert.deepEqual(parseBhdInput("0.250"), { ok: true, fils: 250 });
  assert.deepEqual(parseBhdInput("0.001"), { ok: true, fils: 1 });
  assert.deepEqual(parseBhdInput(" 7 "), { ok: true, fils: 7000 });
  assert.deepEqual(parseBhdInput("1,250.000"), { ok: true, fils: 1250000 });
});

test("parseBhdInput rejects empty, malformed, over-precise and non-positive input", () => {
  assert.deepEqual(parseBhdInput(""), { ok: false, reason: "empty" });
  assert.deepEqual(parseBhdInput("   "), { ok: false, reason: "empty" });
  assert.deepEqual(parseBhdInput("12.3456"), { ok: false, reason: "format" });
  assert.deepEqual(parseBhdInput("abc"), { ok: false, reason: "format" });
  assert.deepEqual(parseBhdInput("1e3"), { ok: false, reason: "format" });
  assert.deepEqual(parseBhdInput("0"), { ok: false, reason: "not_positive" });
  assert.deepEqual(parseBhdInput("0.000"), { ok: false, reason: "not_positive" });
  assert.deepEqual(parseBhdInput("-2.500"), { ok: false, reason: "not_positive" });
});

test("a parsed amount round-trips through the display formatter", () => {
  const parsed = parseBhdInput("18.5");
  assert.ok(parsed.ok);
  assert.equal(bhd(parsed.fils), "18.500 BHD");
});

test("bahrainDateTime renders Asia/Bahrain wall time whatever the host zone", () => {
  // 16:52 UTC is 19:52 in Bahrain (UTC+3, no DST).
  assert.equal(bahrainDateTime("2026-10-30T16:52:00.000Z"), "30 Oct 2026, 19:52");
  // Crossing midnight: 22:30 UTC is already the next Bahrain day.
  assert.equal(bahrainDateTime("2026-10-30T22:30:00.000Z"), "31 Oct 2026, 01:30");
  assert.equal(bahrainDateTime(null), "—");
  assert.equal(bahrainDateTime("not a date"), "—");
});
