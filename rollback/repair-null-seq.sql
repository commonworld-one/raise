-- Repair for the first-rollout window: number any row an old (pre-package) Worker created
-- between `migrations apply` and `wrangler deploy` (such a row has seq = NULL and counters
-- was not bumped). Run ONLY under the same write quiescence gate as rollback (README):
-- outside the gate a draining old isolate can insert another NULL row after this script.
--
-- Safety invariants (verified in test/rollout.test.ts):
--  - never renumbers a row that already has seq (the UPDATE only touches seq IS NULL);
--  - never issues a number at or below any existing seq OR the recorded counter, so numbers
--    of hard-deleted or otherwise missing cards are never reused (base = MAX(max seq, counter));
--  - a kind with no numbered rows and no counter starts from 1;
--  - re-running changes nothing: no NULL rows remain, and the counter never moves down.

UPDATE raises SET seq = (
    SELECT MAX(base) FROM (
      SELECT COALESCE(MAX(n.seq), 0) AS base FROM raises n WHERE n.kind = raises.kind
      UNION ALL
      SELECT COALESCE((SELECT c.seq FROM counters c WHERE c.kind = raises.kind), 0)
    )
  ) + (
    SELECT COUNT(*) FROM raises p WHERE p.kind = raises.kind AND p.seq IS NULL AND p.id < raises.id
  ) + 1
WHERE seq IS NULL;

INSERT INTO counters (kind, seq)
  SELECT kind, MAX(seq) FROM raises WHERE seq IS NOT NULL GROUP BY kind
  ON CONFLICT (kind) DO UPDATE SET seq = MAX(counters.seq, excluded.seq);
