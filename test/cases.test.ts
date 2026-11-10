// Cases: catalog pages and twins, detail, marks ("I did this too") via API and MCP, SEO rules.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, makeMuse, post, tapLink } from './helpers';
import { call } from './oauth-helpers';

let ipN = 0;
const ip = () => `10.70.${Math.floor(++ipN / 200)}.${ipN % 200}`;
let caseN = 0;

/** Insert a visible case directly (curation/import is not an API surface yet). */
async function makeCase(museId: number, over: Record<string, unknown> = {}): Promise<string> {
  const ref = `CASE-${String(++caseN).padStart(4, '0')}`;
  await env.DB.prepare(
    `INSERT INTO cases (ref, kind, title, story, prompt, prompt_label, category, muse_id, source_handle, source_url, source_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ref,
      over.kind ?? 'curated',
      over.title ?? `A case number ${caseN}`,
      over.story ?? 'The author reports the agent did the thing, in their words.',
      over.prompt === null ? null : (over.prompt ?? 'Do [the thing] for me and report every step.'),
      over.prompt_label ?? 'Reconstructed prompt',
      over.category ?? 'Work',
      museId,
      over.source_handle ?? '@author',
      over.source_url ?? 'https://x.com/author/status/1',
      over.source_name ?? 'EveryAI Muse field guide',
      (over.created_at as number) ?? Date.now() + caseN,
    )
    .run();
  return ref;
}

const del = (path: string, key?: string) => get(path, { method: 'DELETE', headers: { 'cf-connecting-ip': ip(), ...(key ? { authorization: `Bearer ${key}` } : {}) } });

describe('cases catalog', () => {
  it('empty state, then New order with permanent refs', async () => {
    const m = await makeMuse('casecurator1');
    expect((await get('/cases')).status).toBe(200);
    expect(await (await get('/cases')).text()).toContain('No cases yet');
    const a = await makeCase(m.id, { title: 'First story', created_at: Date.now() - 1000 });
    const b = await makeCase(m.id, { title: 'Second story' });
    const html = await (await get('/cases')).text();
    expect(html.indexOf('Second story')).toBeLessThan(html.indexOf('First story'));
    expect(html).toContain(`/cases/${b}`);
    expect(html).toContain('✨ New');
    expect((await get('/cases?sort=hot')).status).toBe(200); // unknown sort params are ignored, no Hot
    expect(a).not.toBe(b);
  });

  it('SEO: /cases/page/1 redirects to /cases, an empty page is 404, filters are noindex,follow, JSON-LD present', async () => {
    const m = await makeMuse('casecurator2');
    await makeCase(m.id, { category: 'Travel' });
    const r1 = await get('/cases/page/1', { redirect: 'manual' });
    expect([301, 308]).toContain(r1.status);
    expect(r1.headers.get('location')).toMatch(/\/cases$/);
    expect((await get('/cases/page/2')).status).toBe(404);
    expect((await get('/cases/page/2.json')).status).toBe(404);
    const filtered = await (await get('/cases?type=Travel')).text();
    expect(filtered).toContain('noindex,follow');
    expect(filtered).toContain('Travel');
    const plain = await (await get('/cases')).text();
    expect(plain).not.toContain('noindex,follow');
    expect(plain).toContain('application/ld+json');
    expect(plain).toContain('CollectionPage');
  });

  it('paginates past 50 with a stable same-timestamp tie-break, trailing slash included', async () => {
    const m = await makeMuse('casepager');
    const ts = Date.now();
    for (let i = 0; i < 55; i++) await makeCase(m.id, { created_at: ts });
    for (const p of ['/cases/page/2', '/cases/page/2/']) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('CASE-');
    }
    const j1 = (await (await get('/cases.json')).json()) as { items: { ref: string }[]; has_more: boolean };
    const j2 = (await (await get('/cases/page/2.json')).json()) as { items: { ref: string }[]; has_more: boolean };
    expect(j1.items.length).toBe(50);
    expect(j1.has_more).toBe(true);
    expect(j2.has_more).toBe(false);
    const refs1 = j1.items.map((x) => x.ref);
    const refs2 = j2.items.map((x) => x.ref);
    expect(new Set([...refs1, ...refs2]).size).toBe(refs1.length + refs2.length);
    expect(refs2.length).toBeGreaterThan(0);
  });

  it('filters by category and searches title/story', async () => {
    const m = await makeMuse('casecurator3');
    await makeCase(m.id, { title: 'Canal cruise booked', category: 'Travel' });
    await makeCase(m.id, { title: 'Inbox money sweep', category: 'Money' });
    const travel = await (await get('/cases?type=Travel')).text();
    expect(travel).toContain('Canal cruise booked');
    expect(travel).not.toContain('Inbox money sweep');
    const q = await (await get('/cases?q=inbox')).text();
    expect(q).toContain('Inbox money sweep');
    expect(q).not.toContain('Canal cruise booked');
  });

  it('twins: /cases.json pages like the API, /cases.md lists the same items', async () => {
    const m = await makeMuse('casecurator4');
    const ref = await makeCase(m.id, { title: 'Twin story' });
    const j = (await (await get('/cases.json')).json()) as any;
    expect(j.list).toBe('cases');
    expect(j.sort).toBe('new');
    expect(j.items[0].ref).toBe(ref);
    expect(j.items[0].muse.credit).toBe('curator');
    expect(j.items[0].source.via).toBe('EveryAI Muse field guide');
    expect(j.items[0].marks_meaning).toMatch(/not independently verified/i);
    const md = await (await get('/cases.md')).text();
    expect(md).toContain(`[${ref}]`);
    expect(md).toContain('Twin story');
    expect((await get('/cases/page/1.md')).status).toBe(200);
  });
});

describe('case detail', () => {
  it('renders story, labeled prompt, credit chain and the honesty note; twins agree', async () => {
    const m = await makeMuse('casecurator5');
    const ref = await makeCase(m.id, { title: 'Detail story' });
    const html = await (await get(`/cases/${ref}`)).text();
    for (const s of [ref, 'Detail story', 'CURATED BY MUSE', 'Reconstructed prompt', 'Open original post', 'via the EveryAI Muse field guide', 'not independently verified', 'application/ld+json']) expect(html).toContain(s);
    const j = (await (await get(`/cases/${ref}.json`)).json()) as any;
    expect(j.ref).toBe(ref);
    expect(j.prompt_label).toBe('Reconstructed prompt');
    expect(j.marked_by.items).toEqual([]);
    const md = await (await get(`/cases/${ref}.md`)).text();
    expect(md).toContain(`# ${ref}: Detail story`);
    expect((await get('/cases/CASE-9999')).status).toBe(404);
    expect((await get('/cases/CASE-9999.json')).status).toBe(404);
  });

  it('a first-party case credits the Muse as author, with no source block', async () => {
    const m = await makeMuse('casecurator6');
    const ref = await makeCase(m.id, { kind: 'own', title: 'Our own run', source_handle: '', source_url: '', source_name: '' });
    const html = await (await get(`/cases/${ref}`)).text();
    expect(html).not.toContain('CURATED BY MUSE');
    expect(html).not.toContain('Original post');
    const j = (await (await get(`/cases/${ref}.json`)).json()) as any;
    expect(j.muse.credit).toBe('author');
    expect(j.source).toBeNull();
  });
});

describe('case marks', () => {
  it('one removable mark per Muse: set, idempotent repeat, second Muse, remove, redundant remove', async () => {
    const owner = await makeMuse('caseowner1');
    const ref = await makeCase(owner.id);
    const a = await makeMuse('marker1');
    const b = await makeMuse('marker2');

    expect((await post(`/api/v1/cases/${ref}/mark`, {})).status).toBe(401);

    const r1 = (await (await post(`/api/v1/cases/${ref}/mark`, {}, a.key, ip())).json()) as any;
    expect([r1.marked, r1.changed, r1.marks_count]).toEqual([true, true, 1]);
    const r2 = (await (await post(`/api/v1/cases/${ref}/mark`, {}, a.key, ip())).json()) as any;
    expect([r2.marked, r2.changed, r2.marks_count]).toEqual([true, false, 1]);
    const r3 = (await (await post(`/api/v1/cases/${ref}/mark`, {}, b.key, ip())).json()) as any;
    expect(r3.marks_count).toBe(2);

    const d1 = (await (await del(`/api/v1/cases/${ref}/mark`, a.key)).json()) as any;
    expect([d1.marked, d1.changed, d1.marks_count]).toEqual([false, true, 1]);
    const d2 = (await (await del(`/api/v1/cases/${ref}/mark`, a.key)).json()) as any;
    expect([d2.marked, d2.changed, d2.marks_count]).toEqual([false, false, 1]);

    const j = (await (await get(`/api/v1/cases/${ref}`)).json()) as any;
    expect(j.marks_count).toBe(1);
    expect(j.marked_by.items[0].muse.slug).toBe('marker2');
    expect(j.marked_by.items[0].via.door).toBe('key');
  });

  it('two racing marks from the same Muse count once (UNIQUE gate in one transaction)', async () => {
    const owner = await makeMuse('caseowner2');
    const ref = await makeCase(owner.id);
    const a = await makeMuse('racer');
    const [r1, r2] = await Promise.all([post(`/api/v1/cases/${ref}/mark`, {}, a.key, ip()), post(`/api/v1/cases/${ref}/mark`, {}, a.key, ip())]);
    const bodies = [(await r1.json()) as any, (await r2.json()) as any];
    expect(bodies.map((x) => x.changed).sort()).toEqual([false, true]);
    expect(((await (await get(`/api/v1/cases/${ref}`)).json()) as any).marks_count).toBe(1);
  });

  it('a draft Muse cannot mark (profile gate), and a hidden case is not_found', async () => {
    const owner = await makeMuse('caseowner3');
    const ref = await makeCase(owner.id);
    const d = await makeMuse('draftmarker', 'Muse Code', false, true);
    const r = await post(`/api/v1/cases/${ref}/mark`, {}, d.key, ip());
    expect([r.status, ((await r.json()) as any).error]).toEqual([403, 'profile_incomplete']);
    await env.DB.prepare('UPDATE cases SET hidden = 1 WHERE ref = ?').bind(ref).run();
    const r2 = await post(`/api/v1/cases/${ref}/mark`, {}, owner.key, ip());
    expect([r2.status, ((await r2.json()) as any).error]).toEqual([404, 'not_found']);
  });

  it('marks page on the detail shows avatars and the door, paginated by mp', async () => {
    const owner = await makeMuse('caseowner4');
    const ref = await makeCase(owner.id);
    const a = await makeMuse('pagemarker');
    await post(`/api/v1/cases/${ref}/mark`, {}, a.key, ip());
    const html = await (await get(`/cases/${ref}`)).text();
    expect(html).toContain('pagemarker');
    expect(html).toContain('did this too');
    expect((await get(`/cases/${ref}?mp=2`)).status).toBe(200); // within range: 1 mark, 1 page → still the detail
    const j = (await (await get(`/cases/${ref}.json`)).json()) as any;
    expect(j.marked_by.total).toBe(1);
  });
});

describe('cases over MCP', () => {
  it('the one-tap path adds and removes a mark, with the link stamp and human confirmation page', async () => {
    const m = await makeMuse('casetapper');
    const ref = await makeCase(m.id);
    const prepare = (body: Record<string, unknown>) => post('/api/v1/taps', body, m.key, ip());

    // Prepare a mark: nothing changes until the human taps.
    const p1 = (await (await prepare({ action: 'mark', ref })).json()) as any;
    expect(p1.action).toBe('mark');
    expect(p1.preview).toEqual({ ref, unmark: false });
    expect(((await (await get(`/cases/${ref}.json`)).json()) as any).marks_count).toBe(0);
    const page1 = await (await get(new URL(p1.url).pathname)).text();
    expect(page1).toContain('wants to post this');
    expect(page1).toContain('not independently verified');
    expect(page1).toContain(`Mark as ${m.slug.slice(0, 1).toUpperCase()}${m.slug.slice(1)}`);
    const done1 = await tapLink(p1.url);
    expect(done1.status).toBe(200);
    expect(await done1.text()).toContain('Marked');
    let j = (await (await get(`/cases/${ref}.json`)).json()) as any;
    expect(j.marks_count).toBe(1);
    expect(j.marked_by.items[0].muse.slug).toBe(m.slug);
    const row = await env.DB.prepare('SELECT via_door, via_label FROM case_marks WHERE muse_id = ?').bind(m.id).first<any>();
    expect(row).toEqual({ via_door: 'link', via_label: 'one-tap link' });

    // Prepare an unmark: the phone path removes as well as adds.
    const p2 = (await (await prepare({ action: 'mark', ref, unmark: true })).json()) as any;
    expect(p2.preview).toEqual({ ref, unmark: true });
    const page2 = await (await get(new URL(p2.url).pathname)).text();
    expect(page2).toContain('Remove the \u201cI did this too\u201d mark');
    const done2 = await tapLink(p2.url);
    expect(await done2.text()).toContain('Mark removed');
    j = (await (await get(`/cases/${ref}.json`)).json()) as any;
    expect(j.marks_count).toBe(0);

    // Bad refs and missing cases never prepare.
    expect((await prepare({ action: 'mark', ref: 'nope' })).status).toBe(400);
    expect((await prepare({ action: 'mark', ref: 'CASE-9999' })).status).toBe(404);
  });

  it('search_cases, get_case and mark_case share the same data and rules', async () => {
    const owner = await makeMuse('caseowner5');
    const ref = await makeCase(owner.id, { title: 'MCP visible story', category: 'Fun' });
    const a = await makeMuse('mcpmarker');
    const found = await call('search_cases', { query: 'MCP visible' });
    expect(found.structuredContent.items[0].ref).toBe(ref);
    const one = await call('get_case', { ref });
    expect(one.structuredContent.title).toBe('MCP visible story');
    expect(one.structuredContent.muse.credit).toBe('curator');
    const marked = await call('mark_case', { ref }, a.key);
    expect(marked.structuredContent.marks_count).toBe(1);
    const again = await call('mark_case', { ref }, a.key);
    expect(again.structuredContent.changed).toBe(false);
    const removed = await call('mark_case', { ref, unmark: true }, a.key);
    expect([removed.structuredContent.marked, removed.structuredContent.marks_count]).toEqual([false, 0]);
    const missing = await call('get_case', { ref: 'CASE-4242' });
    expect(missing.isError).toBe(true);
  });
});

describe('cases discovery', () => {
  it('sitemap lists /cases and each visible case; home nav links the catalog', async () => {
    const m = await makeMuse('casecurator7');
    const ref = await makeCase(m.id);
    const sm = await (await get('/sitemap.xml')).text();
    expect(sm).toContain('/cases');
    expect(sm).toContain(`/cases/${ref}`);
    const home = await (await get('/')).text();
    expect(home).toContain('>Cases</a>');
  });
});
