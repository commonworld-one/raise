# Rollback: numbering + cost package (migrations 0012-0014)

Reverses migrations 0012 (per-kind public numbering RAISE #NNNN / REPORT #NNNN), 0013
(`raise_daily(day)` index) and 0014 (`raises(kind,hidden,category)` index) while preserving
every record, including RAISEs/Reports/joins written after the forward migrations ran.

## Write quiescence (required, for rollback AND re-apply)

The schema change and the code change are not atomic with respect to each other, and D1 has no
cross-deploy transaction. Every window where one side is new and the other is old breaks writes:

- **new code + rolled-back schema:** create/join write `counters`/`seq` in the same transaction
  as the card -> every create/join fails after `counters`/`seq` are dropped.
- **old code + new schema:** writes succeed (old code never references `seq`/`counters`), but a
  row created in this window has `seq = NULL` and the counter is not bumped -> it would be
  numbered only by a later re-apply's backfill.
- **deploy overlap:** Pages/Workers roll out gradually, so for some minutes BOTH old and new
  isolates serve traffic; without a gate you cannot reason about which schema each write sees.

Therefore the whole operation (rollback and any later re-apply) MUST run under a write
quiescence gate:

1. **Gate writes.** Deploy a maintenance configuration that rejects the write endpoints
   (create/join/grant/hide) with 503 while keeping reads, or hold the operation in a window
   with no writes. There is no built-in maintenance flag today; adding one (or choosing the
   window) is a pre-prod decision, not part of this local package.
2. **Drain, established by evidence - not by a fixed wait.** No verified guarantee exists here
   that in-flight writes finish within any particular number of seconds; do not rely on one.
   Whatever gate mechanism is chosen must demonstrate drain before the SQL runs: gate logging or
   metrics showing write endpoints refusing all attempts, plus a quiet period long enough that a
   write batch admitted just before the gate went live has observably completed (D1 serializes
   writes per database and each write here is one short batch, but the actual bound must come
   from the chosen mechanism's evidence, not from this document).
3. Only then: revert + deploy the old code, apply `rollback/rollback-0012-0014.sql`, verify
   (below), lift the gate.
4. Re-apply later under the same gate: quiesce writes, apply 0012-0014, deploy the new code,
   lift the gate.

## First rollout (initial deploy of this package)

The same window exists on the way FORWARD: `npm run deploy` applies migrations to raise-prod
and raise-demo and only then deploys the Worker, and Workers roll out gradually. A create
served by an OLD isolate between `migrations apply` and full rollout writes `seq = NULL` and
does not bump `counters`; the new code then shows that card under its global id and
`/raises/{id}` / `/reports/{id}` lookups (which search `seq`) 404 or land on a different card
whose valid number equals that id. A code fallback cannot fix that collision safely (the
id-shaped number can belong to a later, valid card), so the contract is operational, not a
maintenance feature:

1. Run the first deploy under the same write quiescence gate as rollback (above): gate writes,
   establish drain by evidence, then `npm run deploy`, then lift the gate.
2. Post-deploy checks before lifting the gate (run on BOTH raise-prod and raise-demo):
   - `SELECT COUNT(*) FROM raises WHERE seq IS NULL` must be 0.
   - counters cover content: for every kind, `counters.seq >= COALESCE((SELECT MAX(seq) FROM raises
     WHERE kind = counters.kind), 0)` (equality when no card was ever hard-deleted; a counter may
     legitimately sit above the data, never below).
3. If the NULL check is >0 (a write slipped past the gate): while still gated, apply
   `rollback/repair-null-seq.sql` (numbers the strays in id order continuing each kind's
   sequence and re-seeds counters), then re-run both checks. Verified in test/rollout.test.ts.
4. Only then lift the gate.

## Atomicity and re-runnability

- D1's transactional unit exposed to clients is a **batch**; `wrangler d1 execute --file`
  applies statements one by one, NOT in one transaction. Each individual statement in the
  script is atomic on its own, and under the quiescence gate a partially applied script is
  safe to detect and resume.
- `DROP INDEX IF EXISTS` / `DROP TABLE IF EXISTS` are idempotent. `ALTER TABLE raises DROP
  COLUMN seq` is not: a second run fails with `no such column: seq`. Treat that exact error as
  "already applied", not as corruption (covered in test/rollback.test.ts).
- Safety therefore comes from the gate + per-statement atomicity + the verification below,
  not from a single schema dump.

## What is preserved and what is a tradeoff

- **Preserved (verified):** all rows in all content tables (`raises`, `joins`, `raise_daily`,
  `muses`, `occurrences`, points, grants, flags, ...). The script only drops the two added
  indexes, the `counters` table and the `raises.seq` column. `test/rollback.test.ts`:
  post-rollback schema is byte-identical to a pristine 0011 database and every row written
  before or after the forward migration survives with identical content.
- **Tradeoff, not lossless:** the public numbers are real user-visible state and they are
  dropped. `/raises/NNNN` and `/reports/NNNN` links shared while the new code was live stop
  resolving with the code revert (old code has no such routes: 404), and API/MCP `ref`/`number`
  fields disappear. Treat rollback as willingly breaking those URLs/refs.
- **Re-apply gives the same numbers ONLY under invariants:** the backfill numbers rows in id
  order, so a re-applied card keeps its old number only if all of these held during the
  rolled-back window: no row changed `kind`, no row was hard-deleted, no rows were imported or
  had ids edited, and ids still reflect creation order. Rows created during the window (old
  code assigns no number) are numbered by the backfill at re-apply. If any invariant was
  violated, some cards get DIFFERENT numbers than before - shared links would then point at
  different cards, which is worse than 404. Verify the invariants against an audit snapshot
  before any re-apply; if they do not hold, do not re-apply without a mapping plan.
- **Number allocation after re-apply is collision-free:** counters re-seed from max(seq) per
  kind, so the next create continues past every re-issued number (verified).

## Verified evidence (local, 2026-11-10)

- `test/rollback.test.ts` (3 tests, isolated D1 bindings): full-table dump before/after
  rollback identical except the dropped `seq` column and `counters` table; schema byte-equal to
  pristine 0011; rollback on an empty database; re-apply restores original numbers in id order
  and the next `createRaise` continues at max+1 with no `(kind, seq)` duplicates; second
  DROP COLUMN run errors as documented.
- **Runtime check, old code on an actually rolled-back database:** a scratch D1 was migrated
  0001-0011, seeded, migrated 0012-0014, given post-migration rows (incl. `seq` and `counters`
  state), then rolled back with this script. The worker at 8285d1c (pre-package code) served
  `GET /` and `GET /raises` (200), created a RAISE through `POST /api/v1/raises` (201, id 3,
  old-style `/r/0003` URL), and answered `POST /api/v1/raises/2/join` (200, idempotent repeat
  join on a post-migration row) against that restored database. Final contents: all three rows
  present, joins and `raise_daily` consistent.

## Procedure (local; the same steps apply to remote with --remote, after the gate)

1. Enable the write quiescence gate (above) and drain.
2. Revert the code. While the package is uncommitted in the working clone:
   `git checkout -- src/ test/ vitest.config.ts && rm -rf migrations/0012_kind_seq.sql migrations/0013_raise_daily_day.sql migrations/0014_raises_kind_category.sql test/numbering.test.ts test/cost-guards.test.ts test/hot-rising-diff.test.ts test/rollback.test.ts`
   Once committed, revert the package commits instead. Deploy the old code under the gate.
3. Apply the SQL: `wrangler d1 execute raise-prod --local --file rollback/rollback-0012-0014.sql`
   (repeat for `raise-demo` only if 0012-0014 were ever applied there; the demo database never
   received this package on remote).
4. Clear migration bookkeeping so a later re-deploy can re-apply (wrangler skips names already
   recorded; confirmed in the test that re-application is skipped otherwise):
   `wrangler d1 execute raise-prod --local --command "DELETE FROM d1_migrations WHERE name IN ('0012_kind_seq.sql','0013_raise_daily_day.sql','0014_raises_kind_category.sql')"`
5. Verify: row counts per table unchanged versus the pre-rollback snapshot
   (`SELECT COUNT(*) FROM raises/joins/raise_daily/...`), spot-check that RAISEs/Reports
   created after the forward migration are still present by id/title, and the old code's smoke
   pages render (/, /raises, /reports, /r/{id}). D1 does not allow PRAGMA integrity_check;
   counts + content spot-checks are the verification.
6. Lift the gate.

## Limitations

- Never run the SQL while new code can still write (see quiescence): every create/join would
  fail, and a failed half-batch is a user-visible error, not silent corruption.
- Never re-apply partially: all three migrations together, then the new code.
- This preparation and its verification are local only; no remote database was touched.
