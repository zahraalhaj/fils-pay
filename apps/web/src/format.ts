import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app. Never `/1000`, never `toFixed`.
 */
// Signed: refund events in the timeline and reconciliation gaps are negative,
// and a throw here takes down the whole page.
export function bhd(amountFils: number): string {
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** Browser-local rendering, not Asia/Bahrain. */
export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** The merchant's business timezone — the same zone `dayStartIso` and
 *  settlement use. Display-only here; it never changes a filter value. */
export const BUSINESS_TIME_ZONE = "Asia/Bahrain";
export const BUSINESS_TIME_ZONE_LABEL = "Bahrain time";

const BAHRAIN_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * An instant rendered in Asia/Bahrain wall time, e.g. `30 Oct 2026, 19:52`.
 * Callers label the zone once (a column header or a "Bahrain time" suffix)
 * so the reader knows which clock this is, whatever their browser's zone.
 */
export function bahrainDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : BAHRAIN_DATE_TIME.format(date);
}

/**
 * Parses what a person typed into a BHD amount field ("18.5", "18.500",
 * "0.250") into integer fils via the shared `parseBhdToFils` — the one
 * validated string-to-fils parser — and never via `parseFloat`.
 */
export type BhdInputResult =
  | { ok: true; fils: number }
  | { ok: false; reason: "empty" | "format" | "not_positive" };

export function parseBhdInput(text: string): BhdInputResult {
  const trimmed = text.trim().replace(/,/g, "");
  if (trimmed === "") return { ok: false, reason: "empty" };
  let fils: number;
  try {
    fils = parseBhdToFils(trimmed);
  } catch {
    return { ok: false, reason: "format" };
  }
  if (fils <= 0) return { ok: false, reason: "not_positive" };
  return { ok: true, fils };
}

/**
 * Start of an Asia/Bahrain calendar day (UTC+3, no DST) as a UTC ISO
 * instant — what the `from`/`to` transaction filters take. A day here is the
 * merchant's business day, the same day settlement uses, not a UTC day.
 */
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? new Date(`${dateValue}T00:00:00+03:00`).toISOString() : undefined;
}

/**
 * A `<input type="datetime-local">` value (local wall time, no zone) as an
 * ISO 8601 instant. `new Date(local)` interprets it in the browser's own
 * timezone, which is what the user meant when they typed it.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
