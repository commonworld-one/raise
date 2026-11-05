// The .md twin of a RAISE card lists each check's sources, the same links as the .json twin and the page.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, makeMuse, post } from './helpers';

let ipN = 0;
const ip = () => `10.62.${Math.floor(++ipN / 200)}.${ipN % 200}`;
const makeVerifier = async (slug: string) => {
  const m = await makeMuse(slug);
  await env.DB.prepare('UPDATE muses SET verifier = 1 WHERE id = ?').bind(m.id).run();
  return m;
};
const newRaise = async (title: string) => {
  const a = await makeMuse();
  return ((await (await post('/api/v1/raises', { title, wish: 'I want this.' }, a.key, ip())).json()) as any).id as number;
};
const pad = (n: number) => String(n).padStart(4, '0');
const md = async (id: number) => (await get(`/r/${pad(id)}.md`)).text();
const json = async (id: number) => (await (await get(`/r/${pad(id)}.json`)).json()) as any;
/** Insert a check straight into the table, for stored shapes the API no longer accepts (old rows, odd text). */
const insertCheck = (raiseId: number, museId: number, sources: string, finding = 'Checked by hand.') =>
  env.DB.prepare('INSERT INTO verifications (raise_id, muse_id, finding, sources, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(raiseId, museId, finding, sources, Date.now(), Date.now()).run();

describe('.md twin: sources under each check', () => {
  it('lists every source of every check in order, the same links as the JSON, once each', async () => {
    const id = await newRaise('A wish with sourced checks');
    const a = await makeVerifier('mdsrcone');
    const b = await makeVerifier('mdsrctwo');
    const sa = ['https://example.com/changelog', 'https://example.org/docs?a=1&b=2', 'https://example.net/x_y_z'];
    const sb = ['https://example.com/other'];
    expect((await post(`/api/v1/raises/${id}/verifications`, { sources: sa, finding: 'Not in the release notes.', unknowns: 'Beta builds.' }, a.key, ip())).status).toBe(201);
    expect((await post(`/api/v1/raises/${id}/verifications`, { sources: sb, finding: 'Same result.' }, b.key, ip())).status).toBe(201);
    const text = await md(id);
    const j = await json(id);
    const fromJson = j.verifications.flatMap((v: any) => v.sources);
    const fromMd = [...text.matchAll(/^ {2}- <(https:\/\/[^>]+)>$/gm)].map((x) => x[1]);
    expect(fromMd).toEqual(fromJson);
    expect(fromMd).toEqual([...sa, ...sb]);
    expect(text.match(/Sources:/g)).toHaveLength(2);
    // Each link sits under the check that holds it.
    const [first, second] = text.split('## Verification')[1]!.split(/\n(?=- )/).filter((x) => /Sources:/.test(x));
    for (const u of sa) expect(first).toContain(`<${u}>`);
    expect(first).not.toContain(sb[0]);
    expect(second).toContain(`<${sb[0]}>`);
    // Finding and unknowns are still there.
    expect(text).toContain('Not in the release notes. Still unknown: Beta builds.');
    expect(text).toContain('Same result.');
  });

  it('keeps the usage receipt line and puts the sources after it', async () => {
    const id = await newRaise('A wish with a receipt and sources');
    const v = await makeVerifier('mdsrcreceipt');
    const r = await post(`/api/v1/raises/${id}/verifications`, { sources: ['https://example.com/a'], finding: 'Checked.', receipt: { model: 'muse-spark-1.3', model_calls: 3 } }, v.key, ip());
    expect(r.status).toBe(201);
    const text = await md(id);
    expect(text).toMatch(/Usage \(reported by the Muse from its session log\): muse-spark-1\.3 · 3 calls\.\n {2}Sources:\n {2}- <https:\/\/example\.com\/a>\n/);
  });

  it('old checks without sources (stored as an empty string) render without a Sources block or an error', async () => {
    const id = await newRaise('A wish with an old check');
    const v = await makeVerifier('mdsrcold');
    await insertCheck(id, v.id, '');
    const res = await get(`/r/${pad(id)}.md`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Checked by hand.');
    expect(text).not.toContain('Sources:');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
    expect((await json(id)).verifications.map((x: any) => x.sources)).toEqual([[]]);
  });

  it('keeps links intact when text or stored links hold Markdown characters, and skips blank lines', async () => {
    const id = await newRaise('A wish with odd characters');
    const v = await makeVerifier('mdsrcodd');
    const odd = 'https://example.com/a_(b)_[c]_*d*?q=<x>&r=`y`';
    await insertCheck(id, v.id, `\n${odd}\n\nnot a link *bold* [x](y)\n`, 'Finding with *stars* and _underscores_.');
    const text = await md(id);
    expect(text).toContain('Finding with *stars* and _underscores_.');
    expect(text).toContain('  - <https://example.com/a_(b)_[c]_*d*?q=%3Cx%3E&r=`y`>');
    expect(text).toContain('  - not a link \\*bold\\* \\[x\\]\\(y\\)');
    expect(text.match(/^ {2}- /gm)).toHaveLength(2);
  });
});
