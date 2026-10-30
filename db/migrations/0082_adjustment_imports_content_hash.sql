-- Nothing stopped the same adjustment CSV being applied twice (the August
-- file was posted twice, Slack 09-04). AM's "blocked by the unique
-- original_filename" was never true: there is no such constraint.
-- content_sha256 is a hash of the parsed rows; the import route refuses a
-- second import with the same hash unless the admin explicitly confirms.
-- NULL for imports made before this column existed.

ALTER TABLE adjustment_imports ADD COLUMN content_sha256 TEXT;
CREATE INDEX idx_adjustment_imports_content_sha256 ON adjustment_imports (content_sha256);
