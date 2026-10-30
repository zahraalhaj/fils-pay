/** #59: unknown fields in a profile PATCH are a 400, not a database error. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { updateBusinessProfile } from "./businessProfile.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("businessProfile.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(async () => {
  await pool.end();
});

test("an unknown field is rejected as a bad request", async () => {
  await assert.rejects(
    updateBusinessProfile(pool, "00000000-0000-0000-0000-000000000000", { notAColumn: "x" } as never),
    (err: Error & { statusCode?: number }) => err.statusCode === 400 && /notAColumn/.test(err.message),
  );
});
