// Favicon: Forge's avatar, round. Static files in public/ (served by Workers Assets before the Worker,
// so the demo host's no-API rule never sees them), linked from every page on both hosts and from /demo.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { dget, get } from './helpers';
import { isMachinePath } from '../src/index';

const LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">',
  '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
];

describe('favicon', () => {
  it('files exist in public/ with the right sizes', () => {
    const i = env.TEST_ICONS;
    for (const f of ['favicon.ico', 'favicon-32.png', 'apple-touch-icon.png']) expect(i.files).toContain(f);
    expect([...i.icoSizes].sort((a, b) => a - b)).toEqual([16, 32, 48]);
    expect(i.png32).toEqual([32, 32]);
    expect(i.apple).toEqual([180, 180]);
  });

  it('every layout links them: product pages, demo pages and the standalone /demo', async () => {
    const pages = [await get('/'), await get('/raises'), await get('/about'), await dget('/'), await dget('/raises'), await dget('/demo')];
    for (const r of pages) {
      expect(r.status).toBe(200);
      const t = await r.text();
      for (const l of LINKS) expect(t).toContain(l);
    }
  });

  it('icon paths are not machine paths, so the demo host does not 404 them', () => {
    for (const p of ['/favicon.ico', '/favicon-32.png', '/apple-touch-icon.png']) expect(isMachinePath(p)).toBe(false);
  });
});
