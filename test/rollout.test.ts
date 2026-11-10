import { describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { createRaise } from '../src/data';

/**
 * First-rollout contract (rollback/README.md "First rollout"): the deploy script applies
 * migrations 0012-0014 BEFORE the new Worker, so a create served by an old isolate in that
 * window writes seq = NULL and does not bump counters. The contract is: deploy gated,
 * then verify (1) no seq IS NULL rows and (2) counters >= per-kind max, with
 * rollback/repair-null-seq.sql as the gated repair. This test verifies the check queries
 * and the repair semantics on isolated databases, including non-contiguous states
 * (hard-deleted cards, a counter ahead of the data, empty kinds, re-runs);
 * it does not authorize any remote run.
 */

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
async function apply(db: D1Database, sql: string) {
  const stmts = sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(stmts.map((s) => db.prepare(s)));
}

const seedMuse = (db: D1Database) =>
  db.prepare("INSERT INTO muses (slug, name, client, tagline, created_at) VALUES ('rollmuse', 'Roll', 'Muse', 't', ?)").bind(NOW).run();

const stray = (db: D1Database, kind: string, title: string, idOffset = 0) =>
  db.prepare(`INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count, hidden, seq)
              VALUES (?, ?, '', 1, ?, ?, 1, 0, NULL)`).bind(kind, title, NOW + 1 + idOffset, NOW + 1 + idOffset).run();

const nullCount = async (db: D1Database) => (await db.prepare('SELECT COUNT(*) AS n FROM raises WHERE seq IS NULL').first<{ n: number }>())!.n;
const seqOf = async (db: D1Database, title: string) => (await db.prepare('SELECT seq FROM raises WHERE title = ?').bind(title).first<{ seq: number | null }>())!.seq;
const counterOf = async (db: D1Database, kind: string) => (await db.prepare('SELECT seq FROM counters WHERE kind = ?').bind(kind).first<{ seq: number }>())?.seq ?? null;

describe('first-rollout repair (repair-null-seq.sql)', () => {
  it('contiguous state: checks detect window strays, repair numbers them in id order, creates continue', async () => {
    const db = env.RB_MIG;
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    await seedMuse(db);

    await createRaise(db, 1, { kind: 'raise', title: 'Rollout raise one', body: '', category: '' }, NOW);
    await createRaise(db, 1, { kind: 'report', title: 'Rollout report one', body: '', category: '' }, NOW);
    await createRaise(db, 1, { kind: 'raise', title: 'Rollout raise two', body: '', category: '' }, NOW);
    await stray(db, 'raise', 'Rollout window stray raise');
    await stray(db, 'report', 'Rollout window stray report');

    expect(await nullCount(db)).toBe(2);

    await apply(db, env.TEST_REPAIR_SQL);

    expect(await nullCount(db)).toBe(0);
    expect(await counterOf(db, 'raise')).toBe(3);
    expect(await counterOf(db, 'report')).toBe(2);
    const rows = (await db.prepare('SELECT kind, seq FROM raises ORDER BY id').all()).results;
    expect(rows).toEqual([
      { kind: 'raise', seq: 1 },
      { kind: 'report', seq: 1 },
      { kind: 'raise', seq: 2 },
      { kind: 'raise', seq: 3 },
      { kind: 'report', seq: 2 },
    ]);
    expect(new Set(rows.map((r: any) => `${r.kind}:${r.seq}`)).size).toBe(rows.length);

    const next = await createRaise(db, 1, { kind: 'raise', title: 'Rollout raise after repair', body: '', category: '' }, NOW + 2);
    expect(next.seq).toBe(4);
  });

  it('hard-deleted cards and an ahead counter are never reused; existing seq rows are never renumbered; re-run is a no-op', async () => {
    const db = env.RB_OLD;
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    await seedMuse(db);

    // raise #1..#2 through the real path, then a directly inserted #3 that is hard-deleted
    // (a row with no joins/daily children, so the delete is FK-clean): max(seq)=2, counter=3.
    await createRaise(db, 1, { kind: 'raise', title: 'Gap raise one', body: '', category: '' }, NOW);
    await createRaise(db, 1, { kind: 'raise', title: 'Gap raise two', body: '', category: '' }, NOW);
    await db.prepare(`INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count, hidden, seq)
                      VALUES ('raise', 'Gap raise three', '', 1, ?, ?, 1, 0, 3)`).bind(NOW, NOW).run();
    await db.prepare("UPDATE counters SET seq = 3 WHERE kind = 'raise'").run();
    await db.prepare("DELETE FROM raises WHERE title = 'Gap raise three'").run();

    await stray(db, 'raise', 'Gap window stray one');
    await apply(db, env.TEST_REPAIR_SQL);
    // The deleted #3 is not reused: the counter (3) is part of the base, so the stray gets 4.
    expect(await seqOf(db, 'Gap window stray one')).toBe(4);
    // Existing rows untouched.
    expect(await seqOf(db, 'Gap raise one')).toBe(1);
    expect(await seqOf(db, 'Gap raise two')).toBe(2);
    expect(await counterOf(db, 'raise')).toBe(4);

    // A counter ahead of the data (9 > max seq 4): the next stray continues past the counter.
    await db.prepare("UPDATE counters SET seq = 9 WHERE kind = 'raise'").run();
    await stray(db, 'raise', 'Gap window stray two', 1);
    await apply(db, env.TEST_REPAIR_SQL);
    expect(await seqOf(db, 'Gap window stray two')).toBe(10);
    expect(await counterOf(db, 'raise')).toBe(10);

    // Re-run: nothing left to number, counter never moves.
    await apply(db, env.TEST_REPAIR_SQL);
    expect(await nullCount(db)).toBe(0);
    expect(await counterOf(db, 'raise')).toBe(10);
    expect(await seqOf(db, 'Gap window stray one')).toBe(4);
  });

  it('a kind with only stray rows (counter at 0) starts from 1 and lifts its counter', async () => {
    const db = env.RB_FRESH;
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    await seedMuse(db);

    // One normally numbered raise; reports exist ONLY as window strays (no counter row).
    const r = await createRaise(db, 1, { kind: 'raise', title: 'Fresh raise one', body: '', category: '' }, NOW);
    await stray(db, 'report', 'Fresh stray report one');
    await stray(db, 'report', 'Fresh stray report two', 1);
    expect(await counterOf(db, 'report')).toBe(0); // 0012 seeds both kinds even when empty

    await apply(db, env.TEST_REPAIR_SQL);

    expect(await nullCount(db)).toBe(0);
    expect(await seqOf(db, 'Fresh stray report one')).toBe(1);
    expect(await seqOf(db, 'Fresh stray report two')).toBe(2);
    expect(await counterOf(db, 'report')).toBe(2);
    expect(await seqOf(db, 'Fresh raise one')).toBe(r.seq); // untouched
    expect(await counterOf(db, 'raise')).toBe(1);
  });
});
