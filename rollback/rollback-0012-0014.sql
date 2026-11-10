-- Rollback for the numbering + cost package: migrations 0012 (per-kind public numbering),
-- 0013 (raise_daily day index) and 0014 (raises kind/hidden/category index).
-- Apply ONLY together with the matching code revert (see rollback/README.md).
--
-- Data preservation: every statement below drops schema objects only. No content table
-- (raises, joins, raise_daily, muses, occurrences, muse_points, ...) is touched, so every
-- record written before OR AFTER the forward migrations survives, including RAISEs/Reports
-- created after 0012 (they keep all columns; only the derived public number `seq` is dropped).
--
-- Verified by test/rollback.test.ts: schema after this script is byte-identical to a pristine
-- 0011 database and all rows are preserved.

DROP INDEX IF EXISTS raises_kind_category;  -- 0014
DROP INDEX IF EXISTS raise_daily_day;       -- 0013
DROP INDEX IF EXISTS raises_kind_seq;       -- 0012 (must go before the column it covers)
DROP TABLE IF EXISTS counters;              -- 0012
ALTER TABLE raises DROP COLUMN seq;         -- 0012 (SQLite >= 3.35; D1 supports it)

-- After running this on a wrangler-managed database, also clear the migration bookkeeping so a
-- later re-deploy can re-apply 0012-0014 (wrangler skips names already recorded):
--   wrangler d1 execute raise-prod --local --command "DELETE FROM d1_migrations WHERE name IN ('0012_kind_seq.sql','0013_raise_daily_day.sql','0014_raises_kind_category.sql')"
