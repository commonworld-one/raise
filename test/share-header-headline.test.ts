// /demo keeps the site header + demo bar; og:/twitter: share meta on every page; live headline counters on the demo host only.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { BASE, DEMO, PROD, dget, get } from './helpers';
import { HEADLINES, HEADLINE_PAGES, LIVE, headlineValue } from '../src/live';

const meta = (t: string, k: string) => {
  const m = new RegExp(`<meta (?:property|name)="${k.replace(/[:.]/g, '\\$&')}" content="([^"]*)">`).exec(t);
  return m ? m[1]! : null;
};

describe('/demo has the site header and the demo bar', () => {
  it('same header as other demo pages: brand, main nav, ▶ Demo, Commonworld, one theme toggle; demo bar; no app.js', async () => {
    const t = await (await dget('/demo')).text();
    const home = await (await dget('/raises')).text();
    const nav = (s: string) => s.slice(s.indexOf('<nav aria-label="Main">'), s.indexOf('</nav>') + 6);
    expect(t).toContain('<header class="site"><a class="brand" href="/">Muse <span>RAISE</span></a>');
    expect(nav(t)).toContain('<a href="/raises">RAISEs</a>');
    expect(nav(t)).toContain('<a href="/demo" class="demo">▶ Demo</a>');
    expect(nav(t).replace(' class="on"', '')).toBe(nav(home).replace(' class="on"', ''));
    expect(t).toContain('<a class="cw" href="https://commonworld.one/" title="Commonworld">Commonworld ↗</a>');
    expect(t).toContain('id="navtoggle"');
    expect(t.split('id="theme"').length - 1).toBe(1);
    expect(t).not.toContain('Connect your Muse');
    expect(t).toContain('<div class="demobar">Hackathon demo · <a href="/demo#play">▶ Play the story</a> · <a href="https://raise.commonworld.one/">Open the live product ↗</a></div>');
    expect(t).not.toContain('/app.js');
    // order: site header, demo bar, the story title, Meet the agents, scenarios, footer
    const at = (s: string) => t.indexOf(s);
    expect(at('<header class="site">')).toBeLessThan(at('<div class="demobar">'));
    expect(at('<div class="demobar">')).toBeLessThan(at('<header class="top">'));
    expect(at('<header class="top">')).toBeLessThan(at('Meet the agents'));
    expect(at('Meet the agents')).toBeLessThan(at('id="scn1"'));
    expect(t).toContain('<footer class="harmed">');
  });

  it('demo.css styles it and hides it in ?rec=1; demo.js wires the one toggle and the menu', () => {
    const css = env.TEST_DEMO_CSS, js = env.TEST_DEMO_JS;
    expect(css).toContain('header.site{');
    expect(css).toContain('body.rec header.site,body.rec .demobar{display:none!important}');
    expect(css).toContain('.js header.site:not(.open) .menu{display:none}');
    expect(js).toContain('$("#theme").onclick=');
    expect(js).toContain('$("#navtoggle")');
    expect(js).toContain('location.hash==="#play"');
  });
});

describe('share previews (og: + twitter:)', () => {
  it('pages on both hosts carry og:image (absolute PNG 1200x630) and twitter:card', async () => {
    for (const [host, path] of [[DEMO, '/'], [DEMO, '/raises'], [DEMO, '/demo'], [DEMO, '/muses'], [PROD, '/'], [BASE, '/about'], [PROD, '/granted']] as const) {
      const t = await (await get(path, {}, host)).text();
      expect(meta(t, 'twitter:card'), host + path).toBe('summary_large_image');
      expect(meta(t, 'twitter:site')).toBe('@nerd27dk');
      expect(meta(t, 'og:site_name')).toBe('Muse RAISE');
      expect(meta(t, 'og:type')).toBeTruthy();
      expect(meta(t, 'og:title')).toBeTruthy();
      expect(meta(t, 'og:description')).toBeTruthy();
      expect(meta(t, 'og:url')).toBe(host + path);
      expect(meta(t, 'og:image')).toBe(`${host}/og/default.png`);
      expect(meta(t, 'og:image:width')).toBe('1200');
      expect(meta(t, 'og:image:height')).toBe('630');
      expect(meta(t, 'og:image:alt')).toBeTruthy();
      // ASCII-safe: every og/twitter tag is plain ASCII (non-ASCII as numeric entities)
      for (const m of t.matchAll(/<meta (?:property="og:|name="twitter:)[^>]*>/g)) expect(m[0]).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it('the story cards get their own images on the demo host; titles carry the reference', async () => {
    const r = await (await dget('/r/0418')).text();
    expect(meta(r, 'og:image')).toBe(`${DEMO}/og/r-0418.png`);
    expect(meta(r, 'og:title')).toBe('RAISE #0418 &#183; Wings to fly to the Moon');
    expect(meta(r, 'og:url')).toBe(`${DEMO}/r/0418`);
    expect(meta(r, 'og:type')).toBe('article');
    const p = await (await dget('/r/0419')).text();
    expect(meta(p, 'og:image')).toBe(`${DEMO}/og/r-0419.png`);
    expect(meta(p, 'og:title')).toBe('REPORT #0419 &#183; Rocket countdown stuck at 1');
    // /raises/418 redirects to the card, which has the meta
    const red = await dget('/raises/418', { redirect: 'manual' });
    expect(red.headers.get('location')).toBe(`${DEMO}/r/0418`);
  });

  it('share images exist as 1200x630 PNGs', () => {
    for (const f of ['default.png', 'r-0418.png', 'r-0419.png']) expect(env.TEST_OG[f], f).toEqual([1200, 630]);
  });
});

describe('live headline counters', () => {
  const nums = (t: string) => [...t.matchAll(/<span class="hn" data-hl="([a-zA-Z]+)">([0-9,]+)<\/span><small>([^<]+)<\/small>/g)].map((m) => [m[1]!, Number(m[2]!.replace(/,/g, '')), m[3]!] as const);

  for (const [page, path] of [['home', '/'], ['granted', '/granted'], ['muses', '/muses'], ['corporation', '/corporation']] as const) {
    it(`demo ${path} shows ${HEADLINE_PAGES[page].join(', ')}; the product ${path} shows none`, async () => {
      const before = Date.now();
      const t = await (await dget(path)).text();
      const after = Date.now();
      expect(t).toContain('<section class="headline" data-headline');
      const got = nums(t);
      expect(got.map((g) => g[0])).toEqual(HEADLINE_PAGES[page]);
      for (const [k, v, label] of got) {
        expect(label).toBe(HEADLINES[k as keyof typeof HEADLINES].label);
        expect(v).toBeGreaterThanOrEqual(headlineValue(k as any, before));
        expect(v).toBeLessThanOrEqual(headlineValue(k as any, after));
      }
      expect(t).toContain('M.total(h.seeds[i],t)');
      expect(t).toContain("prefers-reduced-motion: reduce");
      for (const host of [BASE, PROD]) {
        const p = await (await get(path, {}, host)).text();
        expect(p).not.toContain('data-headline');
        expect(p).not.toContain('data-hl=');
      }
    });
  }

  it('the counters never go down, also across a season boundary, and Granted+Fixed >= Granted', () => {
    const s = LIVE.SEASON_MS, t0 = LIVE.seasonStart(Date.now()) + 3 * s;
    for (const k of Object.keys(HEADLINES) as (keyof typeof HEADLINES)[]) {
      let prev = -1;
      for (const t of [t0 - s / 2, t0 - 60000, t0 - 1, t0, t0 + 1, t0 + 60000, t0 + s / 2, t0 + s + 5]) {
        const v = headlineValue(k, t);
        expect(v, `${k} at ${t}`).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
    for (let i = 0; i < 20; i++) {
      const t = Date.now() + i * 3_600_000;
      expect(headlineValue('resolved', t)).toBeGreaterThanOrEqual(headlineValue('granted', t));
      expect(headlineValue('joins', t)).toBeGreaterThan(headlineValue('grantedJoins', t));
    }
  });

  it('style.css has the big-digit block', () => {
    expect(env.TEST_STYLE_CSS).toContain('.headline .hn{');
  });
});

describe('live card pages /r/NNNN (demo host)', () => {
  const big = (t: string, k: string) => {
    const m = new RegExp(`data-c="${k}">([0-9,]+)<`).exec(t);
    return m ? Number(m[1]!.replace(/,/g, '')) : null;
  };

  it('a live card shows the same number as its row in /raises, ticking from the same formula', async () => {
    const list = await (await dget('/raises?sort=top')).text();
    const ids = [...list.matchAll(/data-live-seed="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(0);
    const id = ids[0]!;
    const before = Date.now();
    const t = await (await dget(`/r/${String(id).padStart(4, '0')}`)).text();
    const after = Date.now();
    expect(t).toContain(`data-live-card="${id}"`);
    const j = big(t, 'joins')!;
    expect(j).toBeGreaterThanOrEqual(LIVE.count(id, before));
    expect(j).toBeLessThanOrEqual(LIVE.count(id, after));
    expect(big(t, 'week')!).toBeGreaterThanOrEqual(big(t, 'today')!);
    expect(big(t, 'views')!).toBeGreaterThan(j);
    expect(t).toContain('Muses saw it');
    expect(t).toContain(`,${id},true);</script>`);
  });

  for (const id of [418, 419]) {
    it(`scenario card #0${id}: stored joins stay (as in the lists), "Muses saw it" ticks`, async () => {
      const t = await (await dget(`/r/0${id}`)).text();
      const row = (await env.DEMO_DB.prepare('SELECT joins_count FROM raises WHERE id = ?').bind(id).first<{ joins_count: number }>())!;
      expect(big(t, 'joins')).toBe(row.joins_count);
      expect(big(t, 'views')!).toBeGreaterThan(0);
      expect(t).toContain(`,${id},false);</script>`);
    });
  }

  it('the product card page has no live counters', async () => {
    const r = await (await get('/raises?sort=top', {}, BASE)).text();
    const m = /href="\/r\/(\d{4})"/.exec(r);
    if (!m) return; // an empty product has no cards
    const t = await (await get(`/r/${m[1]}`, {}, BASE)).text();
    expect(t).not.toContain('data-live-card');
    expect(t).not.toContain('Muses saw it');
  });
});
