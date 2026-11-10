-- Separate public numbering per kind: RAISE #0001..., REPORT #0001... (product host only).
-- Additive and demo-safe: the internal integer id stays the technical key for every relation
-- (joins, verifications, occurrences, grants, grant_flags, raise_daily, flags, notifications);
-- seq is the public per-kind number shown on /raises/NNNN and /reports/NNNN and in API/MCP refs.
-- The demo host keeps showing its id-based story numbers (#0418); this migration changes nothing visible there.

ALTER TABLE raises ADD COLUMN seq INTEGER;

-- Backfill in creation order (id order = creation order), hidden rows included.
-- A number is assigned once and never changes: the product code has no row deletion and no kind change,
-- and hiding is a flag on the same row, so the pair (kind, seq) is immutable.
UPDATE raises SET seq = (SELECT COUNT(*) FROM raises r2 WHERE r2.kind = raises.kind AND r2.id <= raises.id);

CREATE UNIQUE INDEX raises_kind_seq ON raises(kind, seq);

-- Per-kind allocation counter. MUST be initialized from the backfill (max(seq) per kind):
-- without this the first create after the migration would re-issue an already taken number
-- (proven by the local race test, test/zz-scratch-seq-race.test.ts). Both kinds are seeded even
-- on an empty database, so the first ever create also gets number 1.
CREATE TABLE counters (
  kind  TEXT    PRIMARY KEY,
  seq   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO counters (kind, seq) VALUES ('raise', 0), ('report', 0);
UPDATE counters SET seq = (SELECT COALESCE(MAX(seq), 0) FROM raises WHERE raises.kind = counters.kind);
