export const PER_PAGE = 50;
export const DAY_MS = 86_400_000;
/** Activity window (#2): a Report is Active when an occurrence was reported within it, else Quiet. Time never changes Resolution. */
export const ACTIVE_WINDOW_MS = 3 * DAY_MS;
export const activityOf = (lastOccurrence: number, now: number): 'active' | 'quiet' => (now - lastOccurrence < ACTIVE_WINDOW_MS ? 'active' : 'quiet');
/**
 * Demo host reference clock (epoch ms). The demo must look the way it was recorded, forever, so age
 * reads (activity windows, Active/Quiet state, "ago" labels) use this fixed instant instead of the
 * wall clock: 2026-11-04T16:27:25Z (Nov 4 18:27:25 Europe/Riga, the recording's filename instant,
 * owner-confirmed Riga time). It reproduces the recording's content, order, Active badges and Nov 3
 * occurrence dates; age labels sit ~1h later than one captured frame ("18 h ago" vs "17 h ago").
 * Counters, seasons and writes keep real time (src/live.ts).
 */
export const DEMO_REFERENCE_MS = 1_793_809_645_000;
/** Date as shown on pages, e.g. "Nov 3, 2026" (UTC). */
export const dateStr = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
export const pad = (n: number): string => String(n).padStart(4, '0');

export const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const seasonOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
export const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());

export function seasonName(season: string): string {
  const [y, m] = season.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

export const ACTIVE_MS: Record<string, number> = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS };

export const RANKS: [number, string][] = [
  [2000, 'Fellow'],
  [1000, 'Principal'],
  [600, 'Senior'],
  [250, 'Specialist'],
  [0, 'Contributor'],
];
export const rankOf = (points: number): string => RANKS.find((r) => points >= r[0])![1];
export function rankRange(rank: string): [number, number] | null {
  const i = RANKS.findIndex((r) => r[1] === rank);
  if (i < 0) return null;
  return [RANKS[i]![0], i === 0 ? Number.MAX_SAFE_INTEGER : RANKS[i - 1]![0] - 1];
}

/** Snapshot id: the minute the list was read (lists are cached ~60s). */
export const snapshotId = (now: number): string => 's' + Math.floor(now / 60000).toString(36);

export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const json = (data: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...(init.headers || {}) },
  });

export const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * Location for a same-origin redirect. `to` is a path (plus query) built from the request path,
 * which an attacker controls: `//evil.example/` or `/\\evil.example` would otherwise become a
 * protocol-relative Location that browsers follow off-site. So runs of slashes or backslashes in
 * the path part collapse to one "/", control characters are dropped (no header injection), and
 * the result is an absolute URL on the request's own origin: it can never name another host.
 */
export function sameOrigin(origin: string, to: string): string {
  const clean = to.replace(/[\u0000-\u001f\u007f]/g, '');
  const q = clean.search(/[?#]/);
  const path = q < 0 ? clean : clean.slice(0, q);
  const rest = q < 0 ? '' : clean.slice(q);
  return origin + ('/' + path).replace(/[\/\\]+/g, '/') + rest;
}

// ---------- hosts: product vs hackathon demo ----------

const DEFAULT_SITE = 'https://raise.commonworld.one';
const DEFAULT_DEMO = 'https://raise-demo.commonworld.one';
const originOf = (url: string | undefined, dflt: string): string => {
  try {
    return new URL(url || dflt).origin;
  } catch {
    return dflt;
  }
};
/** Origin of the product site, e.g. https://raise.commonworld.one */
export const productSite = (env: { SITE_URL?: string }): string => originOf(env.SITE_URL, DEFAULT_SITE);
/** Origin of the hackathon demo site, e.g. https://raise-demo.commonworld.one */
export const demoSite = (env: { DEMO_SITE_URL?: string }): string => originOf(env.DEMO_SITE_URL, DEFAULT_DEMO);

/**
 * True when this request is for the demo host. Only the exact DEMO_SITE_URL hostname counts
 * (plus raise-demo.localhost for `wrangler dev`). Every other hostname is the product and uses DB,
 * so demo and real numbers never mix.
 */
export function isDemoHost(env: { DEMO_SITE_URL?: string }, hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return h === new URL(demoSite(env)).hostname || h === 'raise-demo.localhost';
}

/** The same path (and query) on the product site: the demo bar's "Open the live product" link. */
export const productUrl = (env: { SITE_URL?: string }, path: string, search = ''): string => sameOrigin(productSite(env), path + search);

/** Favicon (Forge, round) and the Apple touch icon: static files in public/, linked from every page incl. /demo. */
export const ICON_LINKS = '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">\n<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">\n<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">';

/** Google Analytics 4 measurement id (the same property as https://commonworld.one/). */
export const GA4_ID = 'G-9QB65R36K6';
/**
 * Cookie consent banner + its script, on every page layout and on /demo (both hosts). Hidden until public/consent.js
 * shows it; gtag.js loads only after "Accept" (no Google script in the server HTML). Same pattern as https://commonworld.one/.
 */
/** Footer link that reopens the cookie banner (public/consent.js), on every page that has the banner. */
export const COOKIE_SETTINGS = '<button type="button" class="cw-linkbtn" data-cookie-settings>Cookie settings</button>';
export const CONSENT_BANNER = `<div class="cw-consent" role="dialog" aria-live="polite" aria-label="Cookie consent" data-ga="${GA4_ID}" hidden><p><b>Cookies.</b> We use Google Analytics cookies to count visits, only if you allow it. <a href="https://commonworld.one/privacy/">Privacy</a></p><div class="cw-consent-actions"><button type="button" class="cw-btn" data-consent="denied">Reject</button><button type="button" class="cw-btn cw-btn-primary" data-consent="granted">Accept</button></div></div>
<script src="/consent.js" defer></script>`;
