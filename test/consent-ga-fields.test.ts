// public/consent.js run against a fake page: GA4 gets a sanitized page_location / page_referrer (a one-tap or OAuth
// URL in document.referrer never reaches Google), and Accept after Reject on the same page clears ga-disable.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { get } from './helpers';

const GA = 'G-9QB65R36K6';

function run(opts: { href: string; referrer?: string; stored?: string }) {
  const url = new URL(opts.href);
  const store = new Map<string, string>(opts.stored ? [['cw-consent', opts.stored]] : []);
  const buttons: Record<string, () => void> = {};
  const banner = {
    hidden: true,
    getAttribute: (k: string) => (k === 'data-ga' ? GA : null),
    querySelector: () => null,
    querySelectorAll: () => ['granted', 'denied'].map((v) => ({ getAttribute: () => v, addEventListener: (_: string, f: () => void) => { buttons[v] = f; } })),
  };
  const scripts: string[] = [];
  const win: any = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } };
  const doc: any = {
    referrer: opts.referrer ?? '', cookie: '',
    querySelector: (s: string) => (s === '.cw-consent' ? banner : null),
    querySelectorAll: () => [],
    createElement: () => ({}),
    head: { appendChild: (s: any) => scripts.push(s.src) },
  };
  const loc: any = { href: url.href, pathname: url.pathname, hostname: url.hostname, origin: url.origin, reload: () => {} };
  new Function('window', 'document', 'location', env.TEST_CONSENT_JS)(win, doc, loc);
  const config = () => (win.dataLayer || []).map((a: any) => Array.from(a)).filter((a: any[]) => a[0] === 'config');
  return { win, buttons, scripts, config };
}

describe('consent.js GA4 fields', () => {
  it('a same-origin /t/<token> referrer is redacted and page_location drops query and hash', () => {
    const p = run({ href: 'https://raise.example/raises?x=rtl_secret#h', referrer: 'https://raise.example/t/rtl_SECRETTOKEN123?a=b', stored: 'granted' });
    expect(p.config()).toEqual([['config', GA, { page_location: 'https://raise.example/raises', page_referrer: 'https://raise.example/t/redacted' }]]);
    expect(JSON.stringify(p.win.dataLayer.map((a: any) => Array.from(a)))).not.toContain('SECRET');
  });

  it('an /oauth/ referrer is redacted, other referrers lose their query string', () => {
    expect(run({ href: 'https://raise.example/', referrer: 'https://raise.example/oauth/authorize?state=secret&code=abc', stored: 'granted' }).config()[0][2])
      .toEqual({ page_location: 'https://raise.example/', page_referrer: 'https://raise.example/oauth/redacted' });
    expect(run({ href: 'https://raise.example/about', referrer: 'https://news.example/item?token=abc', stored: 'granted' }).config()[0][2])
      .toEqual({ page_location: 'https://raise.example/about', page_referrer: 'https://news.example/item' });
    expect(run({ href: 'https://raise.example/about', stored: 'granted' }).config()[0][2]).toEqual({ page_location: 'https://raise.example/about' });
  });

  it('nothing loads on a /t/ page itself', () => {
    const p = run({ href: 'https://raise.example/t/rtl_SECRETTOKEN123', stored: 'granted' });
    expect(p.scripts).toEqual([]);
    expect(p.win.dataLayer).toBeUndefined();
  });

  it('Accept after Reject on the same page clears ga-disable and loads GA', () => {
    const p = run({ href: 'https://raise.example/' });
    p.buttons.denied!();
    expect(p.win['ga-disable-' + GA]).toBe(true);
    expect(p.scripts).toEqual([]);
    p.buttons.granted!();
    expect(p.win['ga-disable-' + GA]).toBe(false);
    expect(p.scripts).toEqual([`https://www.googletagmanager.com/gtag/js?id=${GA}`]);
    expect(p.config()).toHaveLength(1);
  });

  it('OAuth pages send no referrer; one-tap pages stay same-origin (their form POST needs a real Origin)', async () => {
    expect((await get('/oauth/authorize?response_type=code&client_id=x&state=secret')).headers.get('referrer-policy')).toBe('no-referrer');
    expect((await get('/t/sometoken123')).headers.get('referrer-policy')).toBe('same-origin');
  });
});
