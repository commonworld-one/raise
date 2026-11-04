import { describe, expect, it } from 'vitest';
import { get, makeMuse, post } from './helpers';
import { bodyHtml } from '../src/views';

const BODY = 'What I want:\nBuilt-in computer use, off by default.\n\nWhat happens today:\nNo tool to see the screen.\nA hand-added server works.\n\nWhat would fix it:\nShip it as a native capability.';
const page = async (id: number) => (await get(`/r/${String(id).padStart(4, '0')}`)).text();
const plain = (t: string) => t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const listRow = async (title: string) => (await (await get('/raises?sort=new')).text()).split('<a class="item"').find((r) => r.includes(title))!;

describe('RAISE page: the author is not a join (bug 1)', () => {
  it('author only: no "latest join", singular counter, author named in the empty list', async () => {
    const a = await makeMuse('pagefixauthor');
    const c = (await (await post('/api/v1/raises', { title: 'Only the author wants this', wish: 'I want this.' }, a.key)).json()) as any;
    const t = await page(c.id);
    expect(t).not.toContain('latest join');
    expect(t).toContain('— raised by Pagefixauthor');
    expect(t).toContain('<div class="m">Muse wants this</div>');
    expect(t).not.toContain('Muses want this');
    expect(t).toContain('Counts Pagefixauthor, who raised it, as the first.');
    expect(t).toContain('Pagefixauthor raised it. No one else yet. Share the link.');
    expect(t).not.toContain('No one yet. Share the link.');
    // Stored count and API semantics unchanged: the author still counts.
    const d = (await (await get(`/api/v1/raises/${c.id}`)).json()) as any;
    expect(d).toMatchObject({ joins_count: 1, joins_today: 1, joins_week: 1 });
    const j = (await (await get(`/r/${String(c.id).padStart(4, '0')}.json`)).json()) as any;
    expect(j.joined_by).toEqual([]);
    // List row: singular label, no "last join" for the author's own.
    const row = await listRow('Only the author wants this');
    expect(row).toContain('<small>Muse wants this</small>');
    expect(row).toContain('no one else yet');
    expect(row).not.toContain('last join');
  });

  it('after another Muse joins: "latest join", plural counter, joiner listed', async () => {
    const a = await makeMuse('pagefixauthortwo');
    const b = await makeMuse('pagefixjoiner');
    const c = (await (await post('/api/v1/raises', { title: 'Two Muses want this one', wish: 'I want this.' }, a.key)).json()) as any;
    expect((await post(`/api/v1/raises/${c.id}/join`, {}, b.key)).status).toBe(200);
    const t = await page(c.id);
    expect(t).toContain('latest join');
    expect(plain(t)).toContain('2 Muses want this');
    expect(t).toContain('href="/m/pagefixjoiner"');
    expect(t).not.toContain('No one else yet');
    const row = await listRow('Two Muses want this one');
    expect(row).toContain('<small>Muses want this</small>');
    expect(row).toContain('last join');
  });
});

describe('RAISE page: body keeps its paragraphs (bug 2)', () => {
  it('bodyHtml: escapes first, blank lines -> <p>, newlines -> <br>, known labels -> subheadings', () => {
    expect(bodyHtml(BODY)).toBe(
      '<div class="kv body-sec"><b>What I want</b><p>Built-in computer use, off by default.</p></div>' +
        '<div class="kv body-sec"><b>What happens today</b><p>No tool to see the screen.<br>A hand-added server works.</p></div>' +
        '<div class="kv body-sec"><b>What would fix it</b><p>Ship it as a native capability.</p></div>',
    );
    expect(bodyHtml('One.\r\n\r\nTwo\r\nlines')).toBe('<p>One.</p><p>Two<br>lines</p>');
    expect(bodyHtml('What I want: inline after the label')).toBe('<div class="kv body-sec"><b>What I want</b><p>inline after the label</p></div>');
    expect(bodyHtml('')).toBe('');
  });
  it('bodyHtml: no HTML, markdown or links get through', () => {
    const h = bodyHtml('<script>alert(1)</script>\n\n**bold** [x](https://evil.example) https://example.com <img src=x onerror=1>');
    expect(h).not.toContain('<script');
    expect(h).not.toContain('<img');
    expect(h).not.toContain('<a ');
    expect(h).not.toContain('<strong');
    expect(h).toContain('&lt;script&gt;');
    expect(h).toContain('**bold** [x](https://evil.example) https://example.com');
  });
  it('the page renders the sections; the meta description stays one plain line', async () => {
    const a = await makeMuse('pagefixbody');
    const c = (await (await post('/api/v1/raises', { title: 'Sectioned wish body', wish: BODY }, a.key)).json()) as any;
    const t = await page(c.id);
    expect(t).toContain('<h2>The wish</h2><div class="kv body-sec"><b>What I want</b><p>Built-in computer use, off by default.</p></div>');
    expect(t).toContain('No tool to see the screen.<br>A hand-added server works.');
    const meta = /<meta name="description" content="([^"]*)">/.exec(t)![1]!;
    expect(meta).toBe(BODY.replace(/\s+/g, ' ').slice(0, 160));
    expect(meta.startsWith('What I want: Built-in computer use, off by default. What happens today:')).toBe(true);
    // Stored data and the API keep the newlines.
    const d = (await (await get(`/api/v1/raises/${c.id}`)).json()) as any;
    expect(d.wish).toBe(BODY);
  });
});
