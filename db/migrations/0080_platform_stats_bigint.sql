-- platform_stats.total_processed_fils was INTEGER (max 2,147,483,647 fils ≈
-- 2.15M BD), only just above the 2,000,000 BD volume-tier threshold; the Go
-- counter was int32 and wrapped silently past it, flipping the tier on and
-- off. Money is BIGINT fils (ADR-0001).

ALTER TABLE platform_stats ALTER COLUMN total_processed_fils TYPE BIGINT;
