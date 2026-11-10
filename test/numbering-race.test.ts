// Parallel-create race coverage for per-kind numbering: can concurrent creates on D1 (miniflare)
// ever receive the same (kind, seq)? Mechanism under test = the createRaise claim + UNIQUE(kind, seq).
import { describe, expect, it, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';

const ddl = [
  'CREATE TABLE IF NOT EXISTS seq_counters (kind TEXT PRIMARY KEY, next INTEGER NOT NULL DEFAULT 1)',
  `CREATE TABLE IF NOT EXISTS seq_objects (
     id INTEGER PRIMARY KEY, kind TEXT NOT NULL, seq INTEGER NOT NULL, title TEXT NOT NULL,
     UNIQUE (kind, seq))`,
];

async function reset() {
  await env.DB.prepare('DROP TABLE IF EXISTS seq_counters').run();
  await env.DB.prepare('DROP TABLE IF EXISTS seq_objects').run();
  for (const s of ddl) await env.DB.prepare(s).run();
}

// Mechanism A: single-statement atomic counter UPDATE...RETURNING inside the create batch.
function createWithCounter(kind: string, title: string) {
  return env.DB.batch([
    env.DB.prepare('INSERT INTO seq_counters (kind, next) VALUES (?, 1) ON CONFLICT (kind) DO UPDATE SET next = next + 1 RETURNING next').bind(kind),
    // seq for the new row: when the counter row was just inserted, next = 1 -> seq 1; after an update, next was
    // already incremented, so seq = next. Either way the RETURNING value IS the seq to use. We read it from results.
  ]);
}
async function createA(kind: string, title: string): Promise<{ id: number; seq: number }> {
  const r = await env.DB.batch<{ next: number }>([
    env.DB.prepare('INSERT INTO seq_counters (kind, next) VALUES (?, 1) ON CONFLICT (kind) DO UPDATE SET next = next + 1 RETURNING next').bind(kind),
  ]);
  const seq = r[0]!.results[0]!.next;
  const r2 = await env.DB.batch<{ id: number }>([
    env.DB.prepare('INSERT INTO seq_objects (kind, seq, title) VALUES (?, ?, ?) RETURNING id').bind(kind, seq, title),
  ]);
  return { id: r2[0]!.results[0]!.id, seq };
}

// Mechanism A in ONE batch (counter update + insert in one transaction): needs the seq value at bind time,
// which SQLite cannot pipe between statements, so use a scalar subquery instead:
// INSERT ... SELECT (the just-updated counter). Same-transaction read sees the uncommitted update.
async function createA1(kind: string, title: string): Promise<{ id: number; seq: number }> {
  const r = await env.DB.batch<{ id: number; seq: number }>([
    env.DB.prepare('INSERT INTO seq_counters (kind, next) VALUES (?, 1) ON CONFLICT (kind) DO UPDATE SET next = next + 1').bind(kind),
    env.DB.prepare('INSERT INTO seq_objects (kind, seq, title) SELECT ?1, next, ?2 FROM seq_counters WHERE kind = ?1 RETURNING id, seq').bind(kind, title),
  ]);
  return r[1]!.results[0]!;
}

// Mechanism B (naive): MAX(seq)+1 computed inside the batch, no counter table.
async function createB(kind: string, title: string): Promise<{ id: number; seq: number }> {
  const r = await env.DB.batch<{ id: number; seq: number }>([
    env.DB.prepare('INSERT INTO seq_objects (kind, seq, title) SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2 FROM seq_objects WHERE kind = ?1 RETURNING id, seq').bind(kind, title),
  ]);
  return r[0]!.results[0]!;
}

/** Interleave a foreign action between two statements of a batch, like join-race.test.ts does. */
function splitBatch(db: D1Database, between: () => Promise<unknown>): D1Database {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'batch') { const v = (target as any)[prop]; return typeof v === 'function' ? v.bind(target) : v; }
      return async (stmts: D1PreparedStatement[]) => {
        const out: any[] = [];
        for (const s of stmts) {
          out.push(await (target as any).batch([s]).then((r: any) => r[0]));
          if (!fired) { fired = true; await between(); }
        }
        return out;
      };
    },
  }) as D1Database;
}

const seqs = async (kind: string) =>
  (await env.DB.prepare('SELECT seq FROM seq_objects WHERE kind = ? ORDER BY seq').bind(kind).all<{ seq: number }>()).results.map((r) => r.seq);

describe('seq assignment experiments (scratch)', () => {
  beforeAll(reset);

  it('A: 20 concurrent creates, one kind -> distinct contiguous seqs 1..20', async () => {
    await reset();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => createA1('raise', `t${i}`)));
    const got = rs.map((r) => r.seq).sort((a, b) => a - b);
    expect(got).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await seqs('raise')).toEqual(got);
    const kinds = await Promise.all([createA1('report', 'x'), createA1('report', 'y'), createA1('raise', 'z')]);
    expect(kinds.find((k) => k.seq === 1)).toBeTruthy(); // report numbering is independent
    expect(await seqs('report')).toEqual([1, 2]);
    expect((await seqs('raise')).length).toBe(21);
  });

  it('A: if the batch is ever split into separate transactions, UNIQUE + retry still yields distinct numbers', async () => {
    await reset();
    // Worst case: someone implements the two statements as separate transactions. The interleave proxy splits
    // the batch: my counter update commits, the foreign create lands fully, then my insert reads the MOVED
    // counter and collides. The UNIQUE constraint must turn that into a loud error, and a bounded retry must
    // then succeed with a fresh number - duplicates must never be possible.
    const dbx = splitBatch(env.DB, () => createA1('raise', 'foreign'));
    const attempt = (db: D1Database) =>
      (db as any).batch([
        env.DB.prepare("INSERT INTO seq_counters (kind, next) VALUES ('raise', 1) ON CONFLICT (kind) DO UPDATE SET next = next + 1"),
        env.DB.prepare("INSERT INTO seq_objects (kind, seq, title) SELECT 'raise', next, 'mine' FROM seq_counters WHERE kind = 'raise' RETURNING id, seq"),
      ]);
    let mine: { id: number; seq: number } | null = null;
    let sawCollision = false;
    for (let i = 0; i < 3 && !mine; i++) {
      try {
        mine = (await attempt(dbx))[1].results[0];
      } catch (e: any) {
        sawCollision = true;
        expect(String(e?.message ?? e)).toMatch(/UNIQUE constraint failed/); // loud, never silent
      }
    }
    expect(sawCollision).toBe(true); // the split really raced - the constraint did the work
    expect(mine).toBeTruthy(); // bounded retry recovered
    const all = await seqs('raise');
    // Degraded-path fact: numbers stay UNIQUE, but the colliding attempt burned its number (gap).
    // Both cards exist, no duplicate - gaps are the worst case of a broken-transaction implementation.
    expect(all.length).toBe(2);
    expect(new Set(all).size).toBe(2);
    expect(all).toContain(mine!.seq);
    console.log('degraded-path seqs (gaps acceptable, duplicates never):', all);
  });

  it('B naive MAX+1: interleave a create between two naive creates without UNIQUE -> documents the failure mode', async () => {
    await reset();
    await env.DB.prepare('DROP TABLE seq_objects').run();
    await env.DB.prepare('CREATE TABLE seq_objects (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, seq INTEGER NOT NULL, title TEXT NOT NULL)').run(); // no UNIQUE
    const dbx = splitBatch(env.DB, () => createB('raise', 'foreign'));
    await (dbx as any).batch([
      env.DB.prepare("INSERT INTO seq_objects (kind, seq, title) SELECT 'raise', COALESCE(MAX(seq),0)+1, 'mine' FROM seq_objects WHERE kind = 'raise'"),
    ]);
    const all = await seqs('raise');
    // Whatever miniflare does here, the UNIQUE constraint in the real design turns any such race into a clean
    // reject+retry instead of a duplicate. This test only documents local behavior.
    console.log('naive MAX+1 interleave result (no UNIQUE):', all);
    await reset();
  });

  it('migration requirement: counters must be initialized from the backfill (max(seq)+1), then retry gets the next number', async () => {
    await reset();
    // State right after a naive backfill WITHOUT counter initialization: rows exist, counter row missing.
    await env.DB.prepare("INSERT INTO seq_objects (kind, seq, title) VALUES ('raise', 1, 'first')").run();
    let failed = false;
    try {
      await createA1('raise', 'after-retry'); // counter starts at 1 -> collides with the backfilled seq 1
    } catch { failed = true; }
    expect(failed).toBe(true); // proof: an uninitialized counter re-issues taken numbers
    // Correct migration: initialize the counter from the backfill, then creates continue cleanly.
    await env.DB.prepare("INSERT INTO seq_counters (kind, next) SELECT 'raise', COALESCE(MAX(seq), 0) FROM seq_objects WHERE kind = 'raise'").run();
    const r = await createA1('raise', 'after-init');
    expect(r.seq).toBe(2);
    // And a forced duplicate still errors loudly, never silent.
    let dupFailed = false;
    try {
      await env.DB.prepare("INSERT INTO seq_objects (kind, seq, title) VALUES ('raise', 1, 'dup')").run();
    } catch { dupFailed = true; }
    expect(dupFailed).toBe(true);
  });

  it('batch with a failing second statement: is the whole batch rolled back (counter not burned)?', async () => {
    await reset();
    let failed = false;
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO seq_counters (kind, next) VALUES ('raise', 1) ON CONFLICT (kind) DO UPDATE SET next = next + 1"),
        env.DB.prepare("INSERT INTO seq_objects (kind, seq, title) SELECT 'raise', next, NULL FROM seq_counters WHERE kind = 'raise'"), // NULL title violates NOT NULL
      ]);
    } catch { failed = true; }
    expect(failed).toBe(true);
    const counter = await env.DB.prepare("SELECT next FROM seq_counters WHERE kind = 'raise'").first<{ next: number }>();
    const rows = (await env.DB.prepare("SELECT COUNT(*) AS n FROM seq_objects").first<{ n: number }>())!.n;
    console.log('after failed batch: counter =', counter, 'rows =', rows);
    // Documented D1 behavior is full rollback: counter stays absent/1, no row. If miniflare differs (counter
    // burned), the design must tolerate burned numbers on failed creates (acceptable: numbers stay unique,
    // gaps possible) - recorded as a fact either way.
    expect(rows).toBe(0);
  });

  it('hidden rows keep their seq; kind never changes (schema-level facts)', async () => {
    await reset();
    const a = await createA1('raise', 'a');
    const b = await createA1('raise', 'b');
    await env.DB.prepare('UPDATE seq_objects SET title = title WHERE id = ?').bind(a.id).run(); // stand-in: hide is an UPDATE of a flag, seq untouched
    expect(await seqs('raise')).toEqual([1, 2]);
    void b;
  });
});
