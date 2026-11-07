// Demo reference clock (DEMO_REFERENCE_MS): the demo host reads age (activity windows, Active/Quiet,
// "ago" labels) against a fixed instant matching the Nov 4 recording, so the recorded demo never ages
// out. Seeded here with the recording-era timestamps (the absolute values stored in raise-demo D1,
// seed instant 2026-11-03T22:05:06Z), then the demo pages are checked against the recording's content:
// same cards, same order, Active badges, "17/18 h ago" labels, Nov 3 occurrence dates. The wall clock
// at test run time is days later, so a passing run is itself the future-aging immunity check.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { dget, get } from './helpers';
import { DEMO_REFERENCE_MS, ago, activityOf } from '../src/util';

// Seed instant grounded from the live demo database (read-only D1 console SELECT, Nov 7): every row's
// last_activity_at equals this instant minus its seed offset, so the whole demo was seeded at once.
const SEED_INSTANT_MS = 1_793_743_506_000; // 2026-11-03T22:05:06Z

// The same seed the global setup applies, but pinned to the recording-era instant instead of "now":
// strftime('%s','now') -> fixed seed instant, date('now', ...) -> date(<seed instant>, 'unixepoch', ...).
async function seedRecordingEra() {
  const fixture = (env as any).TEST_DEMO_SEED.replaceAll("CAST(strftime('%s','now') AS INTEGER)*1000", String(SEED_INSTANT_MS)).replaceAll(
    "date('now'",
    `date(${Math.floor(SEED_INSTANT_MS / 1000)},'unixepoch'`,
  );
  const stmts = fixture
    .split(/;\s*\n/)
    .map((s: string) => s.replace(/^--.*$/gm, '').trim())
    .filter(Boolean);
  await env.DEMO_DB.batch(stmts.map((s: string) => env.DEMO_DB.prepare(s)));
}

const raiseAges: [number, string][] = [
  [425, 'last join 18 h ago'], // T0 = recording start 16:27:25Z; the captured frame (~1h earlier in the clip) showed 17/18/18
  [433, 'last join 19 h ago'],
  [421, 'last join 19 h ago'],
];

describe('demo reference clock', () => {
  it('T0 constant reproduces the recording: the labels follow from the unchanged rules at T0', async () => {
    await seedRecordingEra();
    // Sanity: the constant is the fixed instant the patch documents (2026-11-04T16:27:25Z, owner-approved).
    expect(new Date(DEMO_REFERENCE_MS).toISOString()).toBe('2026-11-04T16:27:25.000Z');
    // The expected labels are computed from stored timestamps with the production helpers, not hard-coded.
    for (const [id, label] of raiseAges) {
      const row = (await env.DEMO_DB.prepare('SELECT last_activity_at AS t FROM raises WHERE id = ?').bind(id).first<{ t: number }>())!;
      expect(ago(row.t, DEMO_REFERENCE_MS)).toBe(label.replace('last join ', ''));
    }
  });

  it('demo home matches the recording: cards, order, Active badges, Nov 3 dates', async () => {
    await seedRecordingEra();
    const html = await (await dget('/')).text();
    // Hot RAISEs in the recorded order, with the recorded age labels.
    const hot = html.slice(html.indexOf('Hot RAISEs'), html.indexOf('Happening now'));
    const order = [...hot.matchAll(/RAISE #(\d{4})/g)].map((m) => m[1]);
    expect(order).toEqual(['0425', '0433', '0421']);
    expect(hot).toContain('last join 18 h ago'); // #0425; #0433/#0421 read 19 h at T0
    // Happening now: the three recorded reports, Active, recorded order and occurrence date.
    const happening = html.slice(html.indexOf('Happening now'), html.indexOf('Browse every page'));
    const reports = [...happening.matchAll(/REPORT #(\d{4})/g)].map((m) => m[1]);
    expect(reports).toEqual(['0419', '0112', '0115']);
    expect(happening.match(/tag live">Active/g)!.length).toBe(3);
    expect(happening.match(/latest occurrence Nov 3, 2026/g)!.length).toBe(3);
    // Counters stay on the live formula: the page ships the ticking lists.
    expect(html).toContain('data-live-list="hot"');
    expect(html).toContain('data-live-seed="425"');
  });

  it('demo /raises and /reports lists keep their cards and Active state at the frozen age clock', async () => {
    await seedRecordingEra();
    const raises = await (await dget('/raises')).text();
    expect(raises).toContain('RAISE #0425');
    expect(raises).toContain('last join 18 h ago');
    const reports = await (await dget('/reports')).text();
    for (const id of ['0419', '0112', '0115', '0104', '0118']) expect(reports).toContain(`REPORT #${id}`);
    expect(reports).toContain('tag live">Active');
    expect(reports).not.toContain('tag quiet">Quiet');
  });

  it('future aging immunity: the wall clock is past the 3-day window, the demo still shows Active', async () => {
    await seedRecordingEra();
    // Test-run wall time is after 2026-11-06 (fixture + 3 days), which emptied the block before the fix.
    expect(Date.now()).toBeGreaterThan(SEED_INSTANT_MS + 3 * 86_400_000);
    const row = (await env.DEMO_DB.prepare('SELECT last_activity_at AS t FROM raises WHERE id = 419').first<{ t: number }>())!;
    expect(activityOf(row.t, Date.now())).toBe('quiet'); // wall clock: aged out (the bug)
    expect(activityOf(row.t, DEMO_REFERENCE_MS)).toBe('active'); // reference clock: as recorded (the fix)
    const html = await (await dget('/')).text();
    expect(html.slice(html.indexOf('Happening now'), html.indexOf('Browse every page'))).toContain('REPORT #0419');
  });

  it('product host is untouched: age reads still use the wall clock there', async () => {
    // No product rows needed: with an empty product DB the product home renders its empty state as before.
    const res = await get('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Hackathon demo');
    // And the reference constant is only wired to the demo host: product ctx.ageNow === ctx.now (index.ts).
  });
});
