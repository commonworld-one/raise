// Cookie consent + GA4 (public/consent.js): the banner is on every HTML page of both hosts and on /demo,
// and the server never renders a Google script: gtag.js is added by consent.js only after "Accept".
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { dget, get } from './helpers';
import { GA4_ID } from '../src/util';

const BANNER = '<div class="cw-consent" role="dialog" aria-live="polite" aria-label="Cookie consent" data-ga="G-9QB65R36K6" hidden>';

describe('cookie consent and Google Analytics', () => {
  it('uses the commonworld.one measurement id', () => {
    expect(GA4_ID).toBe('G-9QB65R36K6');
  });

  it('every HTML page on both hosts has the hidden banner and no server-side gtag script', async () => {
    const pages = [
      await get('/'), await get('/raises'), await get('/reports'), await get('/granted'), await get('/muses'), await get('/agents'),
      await get('/about'), await get('/connect'), await get('/corporation'), await get('/nope-404'),
      await dget('/'), await dget('/raises'), await dget('/about'), await dget('/demo'),
    ];
    for (const r of pages) {
      expect(r.headers.get('content-type')).toContain('text/html');
      const t = await r.text();
      expect(t).toContain(BANNER);
      expect(t).toContain('We use Google Analytics cookies to count visits, only if you allow it.');
      expect(t).toContain('<a href="https://commonworld.one/privacy/">Privacy</a>');
      expect(t).toContain('data-consent="denied">Reject</button>');
      expect(t).toContain('data-consent="granted">Accept</button>');
      expect(t).toContain('<script src="/consent.js" defer></script>');
      expect(t).toContain('<button type="button" class="cw-linkbtn" data-cookie-settings>Cookie settings</button>');
      expect(t).not.toContain('googletagmanager');
      expect(t).not.toContain('gtag(');
      expect(t).not.toMatch(/<script[^>]+google/i);
    }
  });

  it('JSON, Markdown and API responses carry no banner', async () => {
    for (const r of [await get('/raises/page/1.json'), await get('/api/v1/raises'), await get('/raises.md')]) {
      expect(await r.text()).not.toContain('cw-consent');
    }
  });

  it('consent.js loads gtag.js only on Accept and remembers the choice', () => {
    const js = env.TEST_CONSENT_JS;
    // The only place the Google script is created is loadGA(), called for "granted" (click or stored choice).
    expect(js.match(/googletagmanager\.com\/gtag\/js/g)?.length).toBe(1);
    expect(js).toMatch(/function loadGA\(\)[\s\S]*googletagmanager/);
    expect(js).toContain("if (v === 'granted') loadGA();");
    expect(js).toContain("if (c === 'granted') loadGA(); else if (c !== 'denied') banner.hidden = false;");
    expect(js).toContain("set('cw-consent', v)");
    expect(js).toContain("analytics_storage: 'denied'");
  });

  it('product /about says Google Analytics cookies are used only after Accept', async () => {
    const t = await (await get('/about')).text();
    expect(t).toContain('Google Analytics cookies to count visits, only if you press Accept');
    expect(t).not.toContain('No tracking cookies');
  });

  it('one-tap link pages (/t/<token>) and OAuth pages have no banner, no consent script and no Google script', async () => {
    const pages = [await get('/t/sometoken123'), await get('/oauth/authorize?response_type=code&client_id=x&state=secret')];
    for (const r of pages) {
      expect(r.headers.get('content-type')).toContain('text/html');
      const t = await r.text();
      expect(t).not.toContain('cw-consent');
      expect(t).not.toContain('data-ga=');
      expect(t).not.toContain('/consent.js');
      expect(t).not.toContain('data-cookie-settings');
      expect(t).not.toContain('googletagmanager');
    }
  });

  it('consent.js loads nothing on /t/ and /oauth/ paths, and Reject after Accept turns GA off and clears _ga cookies', () => {
    const js = env.TEST_CONSENT_JS;
    expect(js).toContain('var PRIVATE_PATH = /^\\/(t|oauth)\\//;');
    expect(js).toContain('if (PRIVATE_PATH.test(location.pathname)) return;');
    // The guard runs before anything else can load GA.
    expect(js.indexOf('if (PRIVATE_PATH.test(location.pathname)) return;')).toBeLessThan(js.indexOf('function loadGA'));
    expect(js).toContain("window['ga-disable-' + GA] = true;");
    expect(js).toContain('clearGACookies();');
    expect(js).toContain("if (prev === 'granted' && loaded) location.reload();");
    expect(js).toContain("document.querySelectorAll('[data-cookie-settings]')");
  });
});
