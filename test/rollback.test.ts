import { describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { createRaise, joinRaise } from '../src/data';

/**
 * Rollback verification for the numbering + cost package (migrations 0012-0014).
 * Proves on isolated databases (RB_* bindings, untouched by the shared setup):
 *  1. schema after rollback/rollback-0012-0014.sql is identical to a pristine 0011 database
 *     (same sqlite_master entries, so the old code at 8285d1c, which never references
 *     seq/counters/the new indexes, runs unchanged);
 *  2. every row survives the rollback with identical content, including RAISEs, Reports,
 *     joins and daily counters written AFTER the forward migrations (through the real
 *     createRaise/joinRaise write path) - only the derived seq column is dropped;
 *  3. rollback works on an empty database too (fresh deploy that never had data);
 *  4. rolling forward again afterwards keeps numbering continuous and collision-free (under
 *     the invariants listed in rollback/README.md: kind immutable, id order = creation order,
 *     no hard deletes, no imports during the rolled-back window);
 *  5. the script's statements are individually atomic and re-runnable as documented
 *     (DROP COLUMN fails with "no such column" on a second run = already applied).
 *
 * Production use requires the write-quiescence gate in rollback/README.md; this test verifies
 * the SQL and data semantics, not deploy ordering.
 */

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const upTo0011 = () => env.TEST_MIGRATIONS.filter((m) => m.name < '0012');
const pkg = () => env.TEST_MIGRATIONS.filter((m) => m.name >= '0012' && m.name < '0015');

async function apply(db: D1Database, sql: string) {
  const stmts = sql
    .replace(/--.*$/gm, '') // strip full-line AND inline comments first
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(stmts.map((s) => db.prepare(s)));
}

async function seedPreMigration(db: D1Database) {
  await db
    .prepare("INSERT INTO muses (slug, name, client, tagline, avatar_url, created_at) VALUES ('rbm', 'Rbm', 'Muse', 'RB', '/avatars/bob.png', ?)")
    .bind(NOW - 40 * DAY)
    .run();
  const muse = await db.prepare("SELECT id FROM muses WHERE slug = 'rbm'").first<{ id: number }>();
  // Two pre-migration cards (one RAISE, one Report), a join and daily counters - all without seq.
  await db.batch([
    db.prepare("INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count, hidden) VALUES ('raise', 'Old raise', 'Capability', ?, ?, ?, 1, 0)").bind(muse!.id, NOW - 30 * DAY, NOW - 2 * DAY),
    db.prepare("INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count, hidden) VALUES ('report', 'Old report', 'Billing', ?, ?, ?, 1, 0)").bind(muse!.id, NOW - 29 * DAY, NOW - 3 * DAY),
    db.prepare('INSERT INTO raise_daily (raise_id, day, joins) VALUES (1, ?, 2), (2, ?, 3)').bind(day(NOW - 2 * DAY), day(NOW - 3 * DAY)),
    db.prepare('INSERT INTO muse_points (muse_id, season, points) VALUES (?, ?, 5)').bind(muse!.id, day(NOW - 30 * DAY).slice(0, 7)),
  ]);
  return muse!.id;
}

/** Full content dump of every user table, ordered, with the derived seq column removed. */
async function dump(db: D1Database) {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) != '_cf_' AND name != 'd1_migrations' ORDER BY name")
    .all<{ name: string }>();
  const out: Record<string, any[]> = {};
  for (const { name } of tables.results) {
    const rows = (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
    if (name === 'raises') for (const r of rows) delete (r as any).seq;
    out[name] = rows;
  }
  return out;
}

async function schema(db: D1Database) {
  const rows = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY name")
    .all();
  // SQLite normalizes nothing in stored SQL text; identical definitions must match verbatim.
  return rows.results;
}

describe('rollback of migrations 0012-0014 (local verification)', () => {
  it('preserves all pre- and post-migration records; schema returns to pristine 0011', async () => {
    // Reference: pristine 0011 database with the same pre-migration rows.
    await applyD1Migrations(env.RB_OLD, upTo0011());
    await seedPreMigration(env.RB_OLD);

    // Target: same pre-migration rows, then the package, then real post-migration writes.
    await applyD1Migrations(env.RB_MIG, upTo0011());
    const museId = await seedPreMigration(env.RB_MIG);
    await applyD1Migrations(env.RB_MIG, pkg());

    // Writes through the real numbered code path AFTER the migrations: new RAISE, new Report,
    // a second Muse's join on the pre-migration RAISE, and a me-too on the new Report.
    const r = await createRaise(env.RB_MIG, museId, { kind: 'raise', title: 'Post-migration raise', body: '', category: 'Capability' }, NOW);
    expect(r.seq).toBe(2); // continues after the pre-migration RAISE
    const rep = await createRaise(env.RB_MIG, museId, { kind: 'report', title: 'Post-migration report', body: '', category: 'Login' }, NOW + 1);
    expect(rep.seq).toBe(2);
    const muse2 = await env.RB_MIG.prepare("INSERT INTO muses (slug, name, client, tagline, created_at) VALUES ('rbm2', 'Rbm2', 'Muse Code', 'RB2', ?) RETURNING id")
      .bind(NOW + 2)
      .first<{ id: number }>();
    const j1 = await joinRaise(env.RB_MIG, muse2!.id, 1, 'me too', NOW + 3);
    expect(j1.ok && j1.joined).toBe(true);
    const j2 = await joinRaise(env.RB_MIG, muse2!.id, rep.id, 'me too', NOW + 4);
    expect(j2.ok && j2.joined).toBe(true);

    const before = await dump(env.RB_MIG);
    delete before.counters; // dropped by design: derived allocation state, not user content

    await apply(env.RB_MIG, env.TEST_ROLLBACK_SQL);

    // 1. Schema identical to the pristine 0011 reference (old code compatibility by construction).
    expect(await schema(env.RB_MIG)).toEqual(await schema(env.RB_OLD));

    // 2. Every row identical to the pre-rollback dump (except the dropped derived seq column),
    //    including all four post-migration writes and their side effects (joins, raise_daily,
    //    occurrences, muse points).
    expect(await dump(env.RB_MIG)).toEqual(before);

    // The post-migration rows really are there, not silently lost.
    const kept = await env.RB_MIG.prepare("SELECT title FROM raises WHERE title LIKE 'Post-migration%' ORDER BY id").all<{ title: string }>();
    expect(kept.results.map((x) => x.title)).toEqual(['Post-migration raise', 'Post-migration report']);
    const joins = await env.RB_MIG.prepare('SELECT COUNT(*) AS n FROM joins').first<{ n: number }>();
    expect(joins!.n).toBeGreaterThanOrEqual(4); // author joins + two explicit joins
  });

  it('rolls back cleanly on an empty database (fresh deploy that never had data)', async () => {
    await applyD1Migrations(env.RB_FRESH, [...upTo0011(), ...pkg()]);
    await apply(env.RB_FRESH, env.TEST_ROLLBACK_SQL);
    expect(await schema(env.RB_FRESH)).toEqual(await schema(env.RB_OLD));
    // Re-runnability: the IF EXISTS statements are no-ops; the second DROP COLUMN fails with
    // the documented "no such column" marker (= already applied), and the schema stays pristine.
    let err = '';
    try {
      await apply(env.RB_FRESH, env.TEST_ROLLBACK_SQL);
    } catch (e: any) {
      err = String(e?.message ?? e);
    }
    expect(err).toContain('no such column');
    expect(await schema(env.RB_FRESH)).toEqual(await schema(env.RB_OLD));
  });

  it('rolling forward again after rollback re-numbers in creation order without collisions', async () => {
    // env.RB_MIG is currently rolled back. Re-apply the package and create once more.
    // Raw SQL, not applyD1Migrations: the bookkeeping table still lists 0012-0014 as applied
    // from the first pass (this is exactly why the README has the d1_migrations cleanup step).
    for (const m of pkg()) await apply(env.RB_MIG, m.queries.join(';\n'));
    const backfilled = await env.RB_MIG.prepare("SELECT id, kind, seq FROM raises WHERE title LIKE 'Post-migration%' ORDER BY id").all<{ id: number; kind: string; seq: number }>();
    // Rows written before the rollback got their original numbers back (id order = creation order).
    expect(backfilled.results.map((x) => [x.kind, x.seq])).toEqual([
      ['raise', 2],
      ['report', 2],
    ]);
    const muse = await env.RB_MIG.prepare("SELECT id FROM muses WHERE slug = 'rbm'").first<{ id: number }>();
    const again = await createRaise(env.RB_MIG, muse!.id, { kind: 'raise', title: 'After rollback', body: '', category: '' }, NOW + 5);
    expect(again.seq).toBe(3); // continues from max, no collision with the re-issued numbers
    const dup = await env.RB_MIG.prepare("SELECT kind, seq, COUNT(*) AS n FROM raises GROUP BY kind, seq HAVING n > 1").all();
    expect(dup.results).toEqual([]);
  });
});
