// Live demo numbers (demo host only). Every count is a pure function of (card seed, time):
// the server renders it for the first paint and a small inline script keeps it ticking in the
// browser with the very same code (liveModel is serialized into the page), so nothing jumps.
// No extra requests and no database writes. The product (raise.commonworld.one) never uses it.
import type { Ctx } from './types';
import type { RaiseRow } from './data';

/** RAISE #0418 and Report #0419 tell the /demo stories, so their numbers stay as stored (scenario-driven). */
export const SCENARIO_RAISE_ID = 418;
export const SCENARIO_REPORT_ID = 419;
const isScenario = (id: number): boolean => id === SCENARIO_RAISE_ID || id === SCENARIO_REPORT_ID;

/**
 * The formula. Self-contained on purpose: it is also sent to the browser via Function#toString,
 * so it must not reference anything outside its own body.
 *
 * - Seasons last 6 hours, aligned to the UTC epoch (00:00, 06:00, 12:00, 18:00 UTC).
 * - Each card starts a season at 10,000-60,000 and ends it at 250,000-5,000,000 (log-uniform,
 *   so a few leaders reach millions), then the next season starts over.
 * - A card's character comes from its seed: steady, sleeper (quiet, then a late spike) or
 *   fader (fast start, then it flattens).
 * - Within a season the count never goes down (every step is a monotonic map of time).
 */
export function liveModel() {
  const SEASON_MS = 6 * 3600 * 1000;
  // Season 1 starts at 2026-11-01 00:00 UTC; the label counts from there.
  const SEASON_ONE = Date.UTC(2026, 10, 1);
  const CHARACTERS = ['steady', 'sleeper', 'fader'];
  const hash = (a: number, b: number): number => {
    let x = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
  const season = (t: number): number => Math.floor(t / SEASON_MS);
  const seasonNo = (t: number): number => Math.max(1, season(t) - Math.floor(SEASON_ONE / SEASON_MS) + 1);
  const seasonStart = (t: number): number => season(t) * SEASON_MS;
  const character = (seed: number): string => CHARACTERS[Math.floor(hash(seed, 7) * 3)]!;
  const shape = (seed: number, n: number, p: number): number => {
    // A monotonic wobble so the pace breathes: q' = 1 + 0.3 cos(...) > 0, q(0) = 0, q(1) = 1.
    const k = 3 + Math.floor(hash(seed, 11) * 5);
    let q = p + (0.3 * Math.sin(2 * Math.PI * k * p)) / (2 * Math.PI * k);
    q = Math.min(1, Math.max(0, q));
    const c = character(seed);
    if (c === 'sleeper') {
      const s = 0.45 + 0.25 * hash(seed, n * 5 + 3);
      if (q < s) return 0.06 * (q / s);
      const r = (q - s) / (1 - s);
      return 0.06 + 0.94 * (1 - Math.pow(1 - r, 3));
    }
    if (c === 'fader') return 1 - Math.pow(1 - q, 3);
    return Math.pow(q, 1.15);
  };
  const ends = (seed: number, n: number): [number, number] => {
    const start = 10000 + Math.floor(hash(seed, n * 5 + 1) * 50000);
    const lo = Math.log(250000), hi = Math.log(5000000);
    return [start, Math.exp(lo + hash(seed, n * 5 + 2) * (hi - lo))];
  };
  const count = (seed: number, t: number): number => {
    const n = season(t);
    const p = (t - n * SEASON_MS) / SEASON_MS;
    const [a, b] = ends(seed, n);
    return Math.floor(a + (b - a) * shape(seed, n, p));
  };
  /** Joined since the season started (a season never crosses a UTC day, so this is "today"). */
  const today = (seed: number, t: number): number => count(seed, t) - count(seed, seasonStart(t));
  /** Cumulative counts from the season start to t, `points` samples. */
  const spark = (seed: number, t: number, points = 7): number[] => {
    const s = seasonStart(t);
    const out: number[] = [];
    for (let i = 0; i < points; i++) out.push(count(seed, s + ((t - s) * i) / (points - 1)));
    return out;
  };
  /**
   * All-time count for a seed: every finished season's final count plus the current season's count.
   * Never goes down: at a season boundary it gains the new season's starting count. Past seasons are memoized.
   */
  const memo: Record<string, number> = {};
  const FIRST = Math.floor(SEASON_ONE / SEASON_MS);
  const total = (seed: number, t: number): number => {
    const n = season(t);
    let past = 0;
    for (let k = FIRST; k < n; k++) {
      const key = seed + ':' + k;
      if (memo[key] === undefined) memo[key] = count(seed, (k + 1) * SEASON_MS - 1);
      past += memo[key]!;
    }
    return past + (n >= FIRST ? count(seed, t) : 0);
  };
  return { SEASON_MS, season, seasonNo, seasonStart, character, count, today, spark, total };
}

export const LIVE = liveModel();

/** Live rows for the demo lists. The product host (or the scenario RAISE) gets the stored values back, untouched. */
export function applyLive(ctx: Pick<Ctx, 'demo'>, items: RaiseRow[], now: number): RaiseRow[] {
  if (!ctx.demo) return items;
  return items.map((x) =>
    isScenario(x.id) ? x : { ...x, joins_count: LIVE.count(x.id, now), today: LIVE.today(x.id, now), spark: LIVE.spark(x.id, now) },
  );
}

/** Is this card driven by the live formula on this host? */
export const isLive = (ctx: Pick<Ctx, 'demo'>, x: { id: number }): boolean => ctx.demo && !isScenario(x.id);

// esbuild's keepNames (wrangler's default) may wrap inner functions in __name(); define it for the browser copy.
const SHIM = 'var __name=window.__name||function(f){return f};';

/**
 * Inline script for every live card list on the demo host (/raises, /reports, the home lists, /granted,
 * Muse profiles; any number of [data-live-list] blocks on a page): ticks every ~1 s, re-sorts a "Top" list every
 * ~4.5 s with a FLIP animation, pauses while the tab is hidden, and under prefers-reduced-motion
 * keeps the numbers moving without animation.
 */
export function liveScript(): string {
  return `<script>${SHIM}(function(M){
var cols=[].slice.call(document.querySelectorAll('[data-live-list]'));if(!cols.length)return;
var tops=cols.filter(function(c){return c.getAttribute('data-live-list')==='top'});
var rm=matchMedia('(prefers-reduced-motion: reduce)');
var f=function(n){return Math.round(n).toLocaleString('en-US')};
function sparkPts(s,w,h){var mx=Math.max.apply(null,s.concat([1]));return s.map(function(v,i){return (i/(s.length-1)*w).toFixed(1)+','+(h-(v/mx)*(h-3)-1).toFixed(1)}).join(' ')}
function tick(){var t=Date.now(),sum=0;
document.querySelectorAll('[data-live-list] [data-live-seed]').forEach(function(el){var id=+el.getAttribute('data-live-seed');var c=M.count(id,t),d=M.today(id,t);
el.setAttribute('data-count',c);var n=el.querySelector('.n,[data-live-n]');if(n)n.textContent=f(c);var u=el.querySelector('.up');if(u)u.textContent='+'+f(d)+' today';
var p=el.querySelector('.spark polyline');if(p)p.setAttribute('points',sparkPts(M.spark(id,t),110,30));sum+=d});
document.querySelectorAll('[data-live-list] .item:not([data-live-seed])').forEach(function(el){sum+=+(el.getAttribute('data-today')||0)});
var ft=document.querySelector('[data-foot-today]');if(ft)ft.textContent=f(sum);
var sn=document.querySelector('[data-season]');if(sn)sn.textContent='Season '+M.seasonNo(t)}
function resort(){tops.forEach(resortOne)}
function resortOne(col){var items=[].slice.call(col.children);var sorted=items.slice().sort(function(a,b){return (+b.getAttribute('data-count'))-(+a.getAttribute('data-count'))});
if(sorted.every(function(el,i){return el===items[i]}))return;
var anim=!rm.matches,first=anim?items.map(function(el){return el.getBoundingClientRect().top}):null;
sorted.forEach(function(el){col.appendChild(el)});
if(!anim)return;items.forEach(function(el,i){var dy=first[i]-el.getBoundingClientRect().top;if(!dy)return;
el.style.transition='none';el.style.transform='translateY('+dy+'px)';el.getBoundingClientRect();
el.style.transition='transform .6s cubic-bezier(.2,.7,.2,1)';el.style.transform='';})}
var a=null,b=null;function start(){if(a)return;tick();a=setInterval(tick,1000);if(tops.length)b=setInterval(resort,4500)}
function stop(){clearInterval(a);clearInterval(b);a=b=null}
document.addEventListener('visibilitychange',function(){document.hidden?stop():start()});
tick();resort();if(!document.hidden)start();
})((${liveModel.toString()})());</script>`;
}

// ---------- headline counters (demo host only) ----------
/**
 * Big site-wide numbers on the demo home, /granted, /muses and /corporation. Most are
 * base + floor(scale * sum of LIVE.total(seed, t)) over their own synthetic seeds (900000+, never card ids):
 * all-time totals that never go down. "Muses joined" and "Muses behind them" are instead the sum of the demo
 * cards' own live numbers (ctx.cards), so they agree with the cards and restart with the season as the cards do.
 */
export interface Headline { label: string; base: number; seeds: number[]; scale: number; cards?: 'all' | 'granted' }
/** A demo card as the headline counters need it: its id, stored count, and whether it is granted. */
export interface DemoCard { id: number; joins_count: number; granted: boolean }
export const HEADLINES = {
  // "Muses joined" is the sum of the cards' own numbers: every live card's LIVE.count (what its row and /r page show)
  // plus the stored counts of the scenario cards. It restarts with the season, exactly like the cards it adds up.
  joins: { label: 'Muses joined', base: 0, seeds: [], scale: 1, cards: 'all' },
  raises: { label: 'RAISEs posted', base: 1200, seeds: [900201], scale: 1 / 400 },
  muses: { label: 'Muses', base: 5000, seeds: [900301], scale: 1 / 150 },
  // Granted + Fixed includes the granted seed, so it is never below "Wishes granted".
  resolved: { label: 'Granted ✨ + Fixed ✓', base: 40, seeds: [900501, 900401], scale: 1 / 8000 },
  granted: { label: 'Wishes granted ✨', base: 25, seeds: [900501], scale: 1 / 8000 },
  // The same sum over the granted cards only (the cards on /granted).
  grantedJoins: { label: 'Muses behind them', base: 0, seeds: [], scale: 1, cards: 'granted' },
  points: { label: 'Points earned', base: 0, seeds: [900701, 900702, 900703, 900704], scale: 2 },
} satisfies Record<string, Headline>;
export type HeadlineKey = keyof typeof HEADLINES;
/** Which counters each demo page shows. */
export const HEADLINE_PAGES: Record<'home' | 'granted' | 'muses' | 'corporation', HeadlineKey[]> = {
  home: ['joins', 'raises', 'muses', 'resolved'],
  granted: ['granted', 'grantedJoins'],
  muses: ['muses', 'raises', 'joins', 'points'],
  corporation: ['muses', 'points', 'joins'],
};

/** For a card-derived counter: the live card ids and the fixed sum of the scenario cards' stored counts. */
export function cardSpec(which: 'all' | 'granted', cards: DemoCard[]): { ids: number[]; fixed: number } {
  const pick = cards.filter((c) => which === 'all' || c.granted);
  return { ids: pick.filter((c) => !isScenario(c.id)).map((c) => c.id), fixed: pick.filter((c) => isScenario(c.id)).reduce((a, c) => a + c.joins_count, 0) };
}

export function headlineValue(key: HeadlineKey, t: number, cards: DemoCard[] = []): number {
  const h: Headline = HEADLINES[key];
  if (h.cards) {
    const c = cardSpec(h.cards, cards);
    return c.ids.reduce((a, id) => a + LIVE.count(id, t), h.base + c.fixed);
  }
  let sum = 0;
  for (const s of h.seeds) sum += LIVE.total(s, t);
  return h.base + Math.floor(h.scale * sum);
}

const num = (n: number) => n.toLocaleString('en-US');

/**
 * The counters block plus its inline script. Server-rendered at `now` (first paint, also without JS);
 * the browser counts up from that value to the formula's value for its own clock, then ticks 4x a second.
 * prefers-reduced-motion: set once to the current value, no animation, no ticking. Pauses in hidden tabs.
 */
export function headlineBlock(ctx: Pick<Ctx, 'demo' | 'cards'>, keys: HeadlineKey[], now: number): string {
  if (!ctx.demo) return '';
  const cards = ctx.cards ?? [];
  const cells = keys.map((k) => `<div class="hl"><span class="hn" data-hl="${k}">${num(headlineValue(k, now, cards))}</span><small>${HEADLINES[k].label}</small></div>`).join('');
  const spec = JSON.stringify(Object.fromEntries(keys.map((k) => {
    const h: Headline = HEADLINES[k];
    return [k, h.cards ? { base: h.base, ...cardSpec(h.cards, cards) } : { base: h.base, seeds: h.seeds, scale: h.scale }];
  })));
  return `<section class="headline" data-headline aria-label="Live demo numbers">${cells}</section>
<script>${SHIM}(function(M,H){
var els=[].slice.call(document.querySelectorAll('[data-hl]'));if(!els.length)return;
var f=function(n){return Math.floor(n).toLocaleString('en-US')};
function val(k,t){var h=H[k],s=0;if(h.ids){s=h.base+h.fixed;for(var j=0;j<h.ids.length;j++)s+=M.count(h.ids[j],t);return s}for(var i=0;i<h.seeds.length;i++)s+=M.total(h.seeds[i],t);return h.base+Math.floor(h.scale*s)}
function set(t){els.forEach(function(el){el.textContent=f(val(el.getAttribute('data-hl'),t))})}
if(matchMedia('(prefers-reduced-motion: reduce)').matches){set(Date.now());return}
var from=els.map(function(el){return +el.textContent.replace(/[^0-9]/g,'')||0}),t0=performance.now(),D=900;
function intro(){var p=Math.min(1,(performance.now()-t0)/D),e=1-Math.pow(1-p,3),t=Date.now();
els.forEach(function(el,i){var v=val(el.getAttribute('data-hl'),t);el.textContent=f(v<from[i]?v:from[i]+(v-from[i])*e)});
if(p<1)requestAnimationFrame(intro);else start()}
var a=null;function start(){if(a||document.hidden)return;set(Date.now());a=setInterval(function(){set(Date.now())},250)}
function stop(){clearInterval(a);a=null}
document.addEventListener('visibilitychange',function(){document.hidden?stop():start()});
requestAnimationFrame(intro);
})((${liveModel.toString()})(),${spec});</script>`;
}

// ---------- one card's page /r/NNNN (demo host only) ----------
const WEEK_MS = 7 * 24 * 3600 * 1000;
/** Joined in the last 7 days: the all-time total's growth, so it is never below "today". */
export const cardWeek = (id: number, t: number): number => LIVE.total(id, t) - LIVE.total(id, t - WEEK_MS);
/** "Muses saw it": every card, scenario ones included. Grows with the card's own all-time joins plus its own view seed. */
export const cardViews = (id: number, t: number): number => Math.floor(1.3 * LIVE.total(id, t) + 0.5 * LIVE.total(700000 + id, t));

/**
 * Ticks the big numbers on a card page. Live cards (the same formula as the lists, so the card and its row
 * agree): joins, today, this week, the spark. Every demo card, the scenario ones too: "Muses saw it".
 * prefers-reduced-motion: set once, no ticking. Pauses in hidden tabs.
 */
export function cardScript(id: number, live: boolean): string {
  return `<script>${SHIM}(function(M,id,live){
var box=document.querySelector('[data-live-card]');if(!box)return;
var f=function(n){return Math.floor(n).toLocaleString('en-US')},W=7*24*3600*1000;
var q=function(k){return box.querySelector('[data-c="'+k+'"]')};
function pts(s,w,h){var mx=Math.max.apply(null,s.concat([1]));return s.map(function(v,i){return (i/(s.length-1)*w).toFixed(1)+','+(h-(v/mx)*(h-3)-1).toFixed(1)}).join(' ')}
function set(t){var v=q('views');if(v)v.textContent=f(1.3*M.total(id,t)+0.5*M.total(700000+id,t));
if(!live)return;var c=q('joins');if(c)c.textContent=f(M.count(id,t));var d=q('today');if(d)d.textContent=f(M.today(id,t));
var w=q('week');if(w)w.textContent=f(M.total(id,t)-M.total(id,t-W));var p=box.querySelector('.spark polyline');if(p)p.setAttribute('points',pts(M.spark(id,t),380,90))}
set(Date.now());if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
var a=null;function start(){if(a||document.hidden)return;set(Date.now());a=setInterval(function(){set(Date.now())},250)}
function stop(){clearInterval(a);a=null}
document.addEventListener('visibilitychange',function(){document.hidden?stop():start()});start();
})((${liveModel.toString()})(),${Number(id)},${live ? 'true' : 'false'});</script>`;
}
