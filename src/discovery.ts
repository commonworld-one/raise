// Discovery files for crawlers and agents (#21), on both hosts, each from its own database:
//   /sitemap.xml   every public page: the lists, each visible RAISE/Report and each public Muse profile
//   /robots.txt    allow all (except old /demo/ links) + the host's own Sitemap line
//   /llms-full.txt llms.txt followed by docs/api.md, as plain text (bundled as text modules, wrangler.jsonc "rules")
//   /openapi.json  OpenAPI 3.1 of the JSON API v1 (src/openapi.ts)
// They go through the same per-IP READ_LIMITER as every other Worker route (src/index.ts).
import type { Ctx } from './types';
import { CHARACTERS } from './characters';
import { PUBLIC_MUSE_SQL } from './draft';
import { dayStr, pad } from './util';
import llmsTxt from '../llms.txt';
import apiMd from '../docs/api.md';
import { openapi } from './openapi';

export const DISCOVERY_PATHS = ['/sitemap.xml', '/robots.txt', '/llms-full.txt', '/openapi.json'] as const;
/** Cap per sitemap file is 50,000 URLs; RAISEs are capped below that, newest activity first. */
const MAX_RAISES = 45_000;
const MAX_MUSES = 4_000;

const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const text = (body: string, type: string, maxAge = 3600) =>
  new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': `public, max-age=${maxAge}`, 'access-control-allow-origin': '*' } });

/** The public list and info pages of this host, in the order of the top menu. */
export function staticPages(ctx: Ctx): string[] {
  return ctx.demo
    ? ['/', '/demo', '/raises', '/reports', '/granted', '/muses', '/agents', '/corporation', '/about']
    : ['/', '/raises', '/reports', '/granted', '/cases', '/muses', '/agents', '/corporation', '/connect', '/about'];
}

export async function sitemapUrls(ctx: Ctx): Promise<{ loc: string; lastmod?: string }[]> {
  const [raises, muses, cases] = await ctx.db.batch<any>([
    // Hidden RAISEs and Reports are left out (their pages are 404).
    ctx.db.prepare('SELECT id, kind, seq, last_activity_at FROM raises WHERE hidden = 0 ORDER BY last_activity_at DESC, id DESC LIMIT ?').bind(MAX_RAISES),
    // Drafts (no name and avatar yet, src/draft.ts) are left out.
    ctx.db.prepare(`SELECT slug FROM muses m WHERE ${PUBLIC_MUSE_SQL} ORDER BY m.id LIMIT ?`).bind(MAX_MUSES),
    // Hidden cases are left out; the ref is the permanent public address.
    ctx.db.prepare('SELECT ref, created_at FROM cases WHERE hidden = 0 ORDER BY created_at DESC, id DESC LIMIT ?').bind(MAX_RAISES),
  ]);
  const base = ctx.origin + ctx.base;
  const urls: { loc: string; lastmod?: string }[] = staticPages(ctx).map((p) => ({ loc: base + p }));
  for (const c of cases!.results as { ref: string; created_at: number }[]) urls.push({ loc: `${base}/cases/${c.ref}`, lastmod: dayStr(c.created_at) });
  for (const r of raises!.results as { id: number; kind: 'raise' | 'report'; seq: number; last_activity_at: number }[])
    // Product: the canonical per-kind address (migration 0012); the demo keeps its /r/{id} story addresses.
    urls.push({ loc: ctx.demo ? `${base}/r/${pad(r.id)}` : `${base}/${r.kind === 'raise' ? 'raises' : 'reports'}/${pad(r.seq)}`, lastmod: dayStr(r.last_activity_at) });
  // The seven characters always have a profile (src/characters.ts), with or without a database row.
  const slugs = new Set<string>(CHARACTERS.map((c) => c.slug));
  for (const m of muses!.results as { slug: string }[]) slugs.add(m.slug);
  for (const s of slugs) urls.push({ loc: `${base}/m/${s}` });
  return urls;
}

export async function sitemap(ctx: Ctx): Promise<Response> {
  const urls = await sitemapUrls(ctx);
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `<url><loc>${xmlEsc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`)
    .join('\n')}\n</urlset>\n`;
  return text(body, 'application/xml');
}

export function robots(ctx: Ctx): Response {
  return text(`User-agent: *\nDisallow: /demo/\nAllow: /\n\nSitemap: ${ctx.origin}/sitemap.xml\n`, 'text/plain', 86400);
}

/** llms.txt, then the full API reference (docs/api.md). The same text on both hosts. */
export const LLMS_FULL = `${llmsTxt.trimEnd()}\n\n---\n\n${apiMd.trimEnd()}\n`;

export function llmsFull(): Response {
  return text(LLMS_FULL, 'text/plain');
}

export function openapiJson(ctx: Ctx): Response {
  return new Response(JSON.stringify(openapi(ctx.env), null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' },
  });
}

/** One of the discovery files, or null for any other path. GET and HEAD only (others fall through to the 405). */
export async function handleDiscovery(ctx: Ctx, req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (path === '/sitemap.xml') return sitemap(ctx);
  if (path === '/robots.txt') return robots(ctx);
  if (path === '/llms-full.txt') return llmsFull();
  if (path === '/openapi.json') return openapiJson(ctx);
  return null;
}
