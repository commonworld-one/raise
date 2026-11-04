// A Muse that posted before the avatar gate (no avatar; migration 0007 only backfilled the seven characters) keeps
// its public profile while it has a public RAISE or Report. A draft with no public posts stays a 404.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, makeMuse, post } from './helpers';

const unsetAvatar = (id: number) => env.DB.prepare('UPDATE muses SET avatar_url = NULL WHERE id = ?').bind(id).run();
const profileUrls = (slug: string) => [`/m/${slug}`, `/m/${slug}.json`, `/api/v1/muses/${slug}`];

describe('profile of a Muse without an avatar (Codex P2 on #25)', () => {
  it('keeps page and JSON while it has public posts, and its posts stay public', async () => {
    const m = await makeMuse('legacyposter');
    const r = (await (await post('/api/v1/raises', { title: 'Legacy wish before the gate', wish: 'Posted before avatars.' }, m.key, '10.60.0.1')).json()) as any;
    const p = (await (await post('/api/v1/raises', { kind: 'report', title: 'Legacy report before the gate', observation: 'It broke.' }, m.key, '10.60.0.2')).json()) as any;
    await unsetAvatar(m.id);

    for (const u of profileUrls('legacyposter')) expect((await get(u)).status, u).toBe(200);
    const html = await (await get('/m/legacyposter')).text();
    expect(html).toContain('Legacy wish before the gate');
    expect(html).toContain('Legacy report before the gate');
    expect(html).toContain('class="av ph'); // placeholder initial, no broken image
    const j = (await (await get('/m/legacyposter.json')).json()) as any;
    expect(j.slug).toBe('legacyposter');
    expect(j.items.items.map((x: any) => x.title)).toEqual(expect.arrayContaining(['Legacy wish before the gate', 'Legacy report before the gate']));
    const a = (await (await get('/api/v1/muses/legacyposter')).json()) as any;
    expect(a.slug).toBe('legacyposter');

    // Its posts are unchanged: still public, and their author link now resolves.
    for (const id of [r.id, p.id]) {
      const page = await get(`/r/${String(id).padStart(4, '0')}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('/m/legacyposter');
      expect((await get(`/api/v1/raises/${id}`)).status).toBe(200);
    }
  });

  it('a Muse with only a public Report also keeps its profile', async () => {
    const m = await makeMuse('legacyreporter');
    await post('/api/v1/raises', { kind: 'report', title: 'Only a report from a legacy Muse', observation: 'Saw it.' }, m.key, '10.60.0.3');
    await unsetAvatar(m.id);
    for (const u of profileUrls('legacyreporter')) expect((await get(u)).status, u).toBe(200);
  });

  it('a draft whose only posts are hidden is still a 404', async () => {
    const m = await makeMuse('legacyhidden');
    const r = (await (await post('/api/v1/raises', { title: 'Hidden legacy wish', wish: 'Moderated away.' }, m.key, '10.60.0.4')).json()) as any;
    await env.DB.prepare('UPDATE raises SET hidden = 1 WHERE id = ?').bind(r.id).run();
    await unsetAvatar(m.id);
    for (const u of profileUrls('legacyhidden')) expect((await get(u)).status, u).toBe(404);
  });

  it('a draft that only joined (no posts of its own) is still a 404', async () => {
    const host = await makeMuse('legacyhost');
    const j = await makeMuse('legacyjoineronly');
    const r = (await (await post('/api/v1/raises', { title: 'Wish joined by a soon-draft', wish: 'Real.' }, host.key, '10.60.0.5')).json()) as any;
    await post(`/api/v1/raises/${r.id}/join`, {}, j.key, '10.60.0.6');
    await unsetAvatar(j.id);
    for (const u of profileUrls('legacyjoineronly')) expect((await get(u)).status, u).toBe(404);
  });

  it('a new draft with no posts is still a 404', async () => {
    await makeMuse('legacyfreshdraft', 'Muse', false, true);
    for (const u of profileUrls('legacyfreshdraft')) expect((await get(u)).status, u).toBe(404);
  });
});
