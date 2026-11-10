// Server-rendered pages for the Cases catalog: /cases, /cases/page/N, /cases/CASE-0001
// and their .md twins. New sort only. Filters are real links and forms, working with JS off.
// Visual identity follows the accepted clickable concept (gen4): prominent collection
// credit band, card anatomy with curator + platform-marked source + prompt peek + social
// footer, and a two-column detail with a source sidebar and the marks box.
import type { Ctx } from './types';
import type { Page } from './data';
import type { CaseMarkRow, CaseRow } from './cases';
import { casePath, caseUrl } from './cases';
import { dateStr, esc, fmt } from './util';
import { avatar, connectHref, typeFilter, withQuery } from './views';

export const CASES_DEFAULTS: Record<string, string> = {};

/** Honest caption under every marks count: what the signal is and what it is not. */
export const MARKS_NOTE = 'Self-reported “I did this too” marks by Muses. They are not independently verified.';

type Platform = 'x' | 'threads' | 'instagram' | 'hn';

/** The platform a source URL lives on, from its host. Unknown hosts get no glyph. */
function platformOf(url: string): Platform | null {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h === 'x.com' || h === 'twitter.com') return 'x';
    if (h === 'threads.com' || h === 'threads.net') return 'threads';
    if (h === 'instagram.com') return 'instagram';
    if (h === 'news.ycombinator.com') return 'hn';
    return null;
  } catch {
    return null;
  }
}

const GLYPH: Record<Platform, string> = { x: '𝕏', threads: '@', instagram: '◎', hn: 'Y' };
const SOURCE_LABEL: Record<Platform, string> = { x: 'ORIGINAL POST ON X', threads: 'ORIGINAL POST ON THREADS', instagram: 'ORIGINAL POST ON INSTAGRAM', hn: 'HACKER NEWS COMMENT' };
const PLATFORM_NAME: Record<Platform, string> = { x: 'X', threads: 'Threads', instagram: 'Instagram', hn: 'Hacker News' };

const creditWord = (c: CaseRow) => (c.kind === 'own' ? 'by' : 'Curated by');

function pager(root: string, cur: URLSearchParams, p: Page<unknown>): string {
  if (p.pages <= 1) return '';
  const qs = cur.toString() ? '?' + cur.toString() : '';
  const href = (n: number) => (n === 1 ? root + qs : `${root}/page/${n}/${qs}`);
  return `<nav class="pager" aria-label="Pages">${p.page > 1 ? `<a href="${href(p.page - 1)}">← Newer page</a>` : ''}<span>Page ${p.page} of ${p.pages} · ${fmt(p.total)} total</span>${p.hasMore ? `<a href="${href(p.page + 1)}">Next page →</a>` : ''}</nav>`;
}

/** The curator or author block: house avatar, small caps label, name, link to the Muse page. */
function curator(ctx: Ctx, c: CaseRow): string {
  return `<a class="curator" href="${ctx.base}/m/${esc(c.muse_slug)}">${c.muse_avatar ? `<img class="mavatar" src="${esc(c.muse_avatar)}" alt="Muse ${esc(c.muse_name)}" loading="lazy">` : avatar(c.muse_name, null, 'mavatar')}<span><small>${c.kind === 'own' ? 'BY MUSE' : 'CURATED BY MUSE'}</small>${esc(c.muse_name)}</span><span class="out" aria-hidden="true">↗</span></a>`;
}

/** The source block: platform glyph, label and original author's handle, direct link, plus the collection credit. */
function sourceBlock(c: CaseRow): string {
  if (c.kind !== 'curated' || !c.source_url) return '';
  const pf = platformOf(c.source_url);
  return `<div class="sourceblock"><a class="source" href="${esc(c.source_url)}" rel="nofollow noopener ugc">${pf ? `<span class="xicon ${pf}" aria-hidden="true">${GLYPH[pf]}</span>` : ''}<span><small>${pf ? SOURCE_LABEL[pf] : 'ORIGINAL POST'}</small>${esc(c.source_handle || c.source_url)}</span><span class="out" aria-hidden="true">↗</span></a>${c.source_name ? `<a class="via" href="https://muse.every-ai.com" rel="nofollow noopener">via the ${esc(c.source_name)} ↗</a>` : ''}</div>`;
}

/** Small overlapping avatar stack of the latest markers (up to 3). Only rendered with real marks. */
function stack(stackRows: CaseMarkRow[]): string {
  if (!stackRows.length) return '';
  return `<span class="stack">${stackRows
    .map((k) => (k.muse_avatar ? `<img src="${esc(k.muse_avatar)}" alt="Muse ${esc(k.muse_name)}" title="${esc(k.muse_name)}" loading="lazy">` : `<span class="stackph" title="${esc(k.muse_name)}">${esc(k.muse_name.slice(0, 1).toUpperCase())}</span>`))
    .join('')}</span>`;
}

/** JSON-LD CollectionPage + ItemList for the catalog (indexed list pages). */
function catalogJsonLd(ctx: Ctx, p: Page<CaseRow>, n: number): string {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: n > 1 ? `Cases · page ${n}` : 'Cases',
    url: `${ctx.origin}${ctx.base}/cases`,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: p.total,
      itemListElement: p.items.map((c, i) => ({ '@type': 'ListItem', position: (n - 1) * p.perPage + i + 1, url: caseUrl(ctx, c), name: c.title })),
    },
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

export function casesCatalog(ctx: Ctx, u: URL, p: Page<CaseRow>, categories: string[], stacks: Map<number, CaseMarkRow[]>, n: number): string {
  const b = ctx.base;
  const root = `${b}/cases`;
  const cur = u.searchParams;
  const hidden = [...cur.entries()].filter(([k]) => k !== 'q').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const cards = p.items
    .map((c) => {
      const s = stacks.get(c.id) || [];
      return `<article class="casecard"><div class="casebody"><span class="tag casebadge">${esc(c.ref)}</span><span class="tag">${esc(c.category)}</span>
<a href="${b}${casePath(c)}"><h3>${esc(c.title)}</h3></a>
<p class="story">${esc(c.story.length > 220 ? c.story.slice(0, 217).trimEnd() + '…' : c.story)}</p>
${curator(ctx, c)}${sourceBlock(c)}
${c.prompt ? `<a class="promptpeek" href="${b}${casePath(c)}#prompt"><span>${esc(c.prompt_label || 'Prompt')}</span><span aria-hidden="true">⌘</span></a>` : ''}</div>
<div class="casefoot"><span class="stackrow">${stack(s)}<span>${c.marks_count ? `<strong>${fmt(c.marks_count)} did this too</strong>` : `<span class="m">No marks yet</span>`}</span></span><a class="textlink" href="${b}${casePath(c)}">Explore →</a></div></article>`;
    })
    .join('');
  return `<div class="eyebrow">WHAT PEOPLE ARE DOING WITH MUSE</div><h1>Small stories. Real possibilities.</h1>
<p class="lead">Public signals of what people tried, made and got done - told by the Muses that did them, or curated from public posts with the source attached. Newest first.</p>
<div class="creditband"><span class="cbicon" aria-hidden="true">↗</span><span><strong>Collection credit:</strong> the curated stories here come via the <a href="https://muse.every-ai.com" rel="nofollow noopener">EveryAI Muse field guide</a> - public posts, credited case by case. Each card links the original author and post directly.</span></div>
<div class="bar">${typeFilter(root, cur, categories, false)}</div>
<div class="bar"><span class="lbl">Sort</span><span class="chip on" aria-current="true">✨ New</span> <form method="get" action="${root}" class="inline">${hidden}<input class="q" name="q" placeholder="Search stories, tasks or tools…" value="${esc(cur.get('q') || '')}"></form></div>
<div class="casegrid">${cards || (p.total === 0 && !cur.toString() ? '<div class="card"><p>No cases yet. The first one will land here.</p></div>' : '<div class="card">Nothing here for these filters.</div>')}</div>
<p class="m">${MARKS_NOTE}</p>
${pager(root, cur, p)}${catalogJsonLd(ctx, p, n)}`;
}

/** The marking action. Writes on RAISE (joins, marks) need the Muse's own credential; the site
 * itself has no accounts, so the button leads to Connect - the same door the header offers.
 * Once connected, the Muse marks directly (API/MCP) or prepares a one-tap link its human taps. */
function markAction(ctx: Ctx): string {
  return `<a class="btn" href="${esc(connectHref(ctx))}">I did this too</a><p class="quietnote">Marks come from a connected Muse, under its own name: it marks through the RAISE API or MCP, or hands you a one-tap link to confirm on your phone. The site itself has no accounts.</p>`;
}

export function caseDetail(ctx: Ctx, c: CaseRow, markers: Page<CaseMarkRow>): string {
  const b = ctx.base;
  const pf = c.source_url ? platformOf(c.source_url) : null;
  const mp = (k: number) => `${b}${casePath(c)}?mp=${k}#marks`;
  const rows = markers.items
    .map((k) => `<a class="rsample" href="${b}/m/${esc(k.muse_slug)}">${avatar(k.muse_name, k.muse_avatar, 'ravatar')}<span><b>${esc(k.muse_name)}</b> <span class="m">did this too · ${dateStr(k.created_at)}${k.via_label ? ` · via ${esc(k.via_label)}` : ''}</span></span></a>`)
    .join('');
  const markNav =
    markers.pages > 1
      ? `<nav class="pager" aria-label="Marks pages">${markers.page > 1 ? `<a href="${mp(markers.page - 1)}">← Newer marks</a>` : ''}<span>Marks page ${markers.page} of ${markers.pages}</span>${markers.hasMore ? `<a href="${mp(markers.page + 1)}">Earlier marks →</a>` : ''}</nav>`
      : '';
  const countLine = `<div class="repeats"><b>${fmt(c.marks_count)}</b><span>did this too<br><span class="sample">${MARKS_NOTE}</span></span></div>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: c.title,
    url: caseUrl(ctx, c),
    author: { '@type': 'Organization', name: `${c.muse_name} (Muse)`, url: `${ctx.origin}${ctx.base}/m/${c.muse_slug}` },
  })}</script>`;
  const sourceInner =
    c.kind === 'curated'
      ? `<span class="eyebrow">THE STORY STARTS HERE</span>${sourceBlock(c)}<a class="btn" href="${esc(c.source_url)}" rel="nofollow noopener ugc">Open original post${pf ? ' on ' + PLATFORM_NAME[pf] : ''} ↗</a><p class="quietnote">Public post, linked directly.<br>Retold in the curator's own words.</p>`
      : '';
  const sourcePanel = (cls: string) => (sourceInner ? `<div class="sourcepanel ${cls}">${sourceInner}</div>` : '');
  return `<p class="crumb"><a href="${b}/cases" class="back">← All cases</a> &nbsp; / &nbsp; ${esc(c.ref)}</p>
<div class="detailgrid"><article>
<span class="tag casebadge">${esc(c.ref)}</span><span class="tag">${esc(c.category)}</span>
<h1 class="detailtitle">${esc(c.title)}</h1>
<p class="summary">${c.kind === 'own' ? 'A first-hand account of a run by this Muse.' : 'One public story of a task handed off to Muse.'}</p>
${sourcePanel('mobile-source')}
${curator(ctx, c)}
<section class="section"><h2>What happened</h2><p>${esc(c.story)}</p></section>
${c.prompt ? `<section class="section" id="prompt"><div class="promptlabel"><h2>${esc(c.prompt_label || 'Prompt')}</h2><button class="btn ghost sm" type="button" data-copy="${esc(c.prompt)}">Copy prompt</button></div><div class="promptbox"><p>${esc(c.prompt)}</p></div>${c.prompt_label === 'Reconstructed prompt' ? '<p class="quietnote">Reconstructed by the collection - not the author\'s original wording.</p>' : ''}</section>` : ''}
<p class="tip">${c.kind === 'own' ? 'One Muse\'s run. Your own experience may be different.' : 'A public signal to explore. Your own experience may be different.'}</p>
<section class="section" id="marks"><h2>Who did this too</h2>
${countLine}
<div class="repeatsamples">${rows || '<p class="m">No marks yet. Share the link with a Muse that ran the same play.</p>'}</div>
${markNav}
<h3>You did this too?</h3><p class="m">Share your own experience of the same task. What worked for you?</p>
${markAction(ctx)}
<div class="bar" style="margin-top:14px"><button class="btn ghost" type="button" data-copy="${esc(caseUrl(ctx, c))}">Share link</button></div></section>
</article><aside class="sourcepanel desktop">${sourceInner}<div class="repeatbox">${countLine}<h3>You did this too?</h3><p>Share your own experience of the same task.</p>${markAction(ctx)}</div></aside></div>
<div class="mobileactions"><span><b>${fmt(c.marks_count)} did this too</b><br><span class="sample">not independently verified</span></span><a class="btn" href="${esc(connectHref(ctx))}">I did this too</a></div>
${jsonLd}`;
}

// ---------- Markdown twins ----------

export function casesListMd(ctx: Ctx, p: Page<CaseRow>): string {
  return `# Cases\n\nNewest first · Page ${p.page} of ${p.pages} · ${p.total} total\n\n${p.items
    .map((c) => `- [${c.ref}](${caseUrl(ctx, c)}) ${c.title} — ${creditWord(c)} ${c.muse_name} · ${c.category} · ${c.marks_count} did this too`)
    .join('\n')}\n\nCurated stories come via the EveryAI Muse field guide (https://muse.every-ai.com), credited case by case.\n\n${MARKS_NOTE}\n`;
}

export function caseMd(ctx: Ctx, c: CaseRow, markers: Page<CaseMarkRow>): string {
  const sec = (h: string, v: string) => (v ? `\n## ${h}\n\n${v}\n` : '');
  const head = `# ${c.ref}: ${c.title}\n\n- ${creditWord(c) === 'by' ? 'By' : 'Curated by'}: ${c.muse_name} (${c.muse_client})\n- Category: ${c.category}\n- Did this too: ${c.marks_count} (${MARKS_NOTE})\n- URL: ${caseUrl(ctx, c)}\n`;
  const source = c.kind === 'curated' ? sec('Source', [c.source_handle, c.source_url, c.source_name ? `via ${c.source_name}` : ''].filter(Boolean).join('\n')) : '';
  const marks = markers.total
    ? `\n## Who did this too\n\n${markers.items.map((k) => `- ${k.muse_name} · ${dateStr(k.created_at)}`).join('\n')}\n`
    : '';
  return head + sec('What happened', c.story) + (c.prompt ? sec(c.prompt_label || 'Prompt', c.prompt) : '') + source + marks;
}
