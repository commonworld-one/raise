// Live demo numbers (demo host only). Every count is a pure function of (card seed, time):
// the server renders it for the first paint and a small inline script keeps it ticking in the
// browser with the very same code (liveModel is serialized into the page), so nothing jumps.
// No extra requests and no database writes. The product (raise.commonworld.one) never uses it.
import type { Ctx } from './types';
import type { RaiseRow } from './data';

/** RAISE #0418 tells the /demo story, so its numbers stay as stored (small, scenario-driven). */
export const SCENARIO_RAISE_ID = 418;

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
  return { SEASON_MS, season, seasonNo, seasonStart, character, count, today, spark };
}

export const LIVE = liveModel();

/** Live rows for the demo lists. The product host (or the scenario RAISE) gets the stored values back, untouched. */
export function applyLive(ctx: Pick<Ctx, 'demo'>, items: RaiseRow[], now: number): RaiseRow[] {
  if (!ctx.demo) return items;
  return items.map((x) =>
    x.id === SCENARIO_RAISE_ID ? x : { ...x, joins_count: LIVE.count(x.id, now), today: LIVE.today(x.id, now), spark: LIVE.spark(x.id, now) },
  );
}

/** Is this card driven by the live formula on this host? */
export const isLive = (ctx: Pick<Ctx, 'demo'>, x: { id: number }): boolean => ctx.demo && x.id !== SCENARIO_RAISE_ID;

// esbuild's keepNames (wrangler's default) may wrap inner functions in __name(); define it for the browser copy.
const SHIM = 'var __name=window.__name||function(f){return f};';

/**
 * Inline script for /raises and /reports on the demo host: ticks every ~1 s, re-sorts "Top" every
 * ~4.5 s with a FLIP animation, pauses while the tab is hidden, and under prefers-reduced-motion
 * keeps the numbers moving without animation.
 */
export function liveScript(): string {
  return `<script>${SHIM}(function(M){
var col=document.querySelector('[data-live-list]');if(!col)return;
var top=col.getAttribute('data-live-list')==='top';
var rm=matchMedia('(prefers-reduced-motion: reduce)');
var f=function(n){return Math.round(n).toLocaleString('en-US')};
function sparkPts(s,w,h){var mx=Math.max.apply(null,s.concat([1]));return s.map(function(v,i){return (i/(s.length-1)*w).toFixed(1)+','+(h-(v/mx)*(h-3)-1).toFixed(1)}).join(' ')}
function tick(){var t=Date.now(),sum=0;
col.querySelectorAll('[data-live-seed]').forEach(function(el){var id=+el.getAttribute('data-live-seed');var c=M.count(id,t),d=M.today(id,t);
el.setAttribute('data-count',c);var n=el.querySelector('.n');if(n)n.textContent=f(c);var u=el.querySelector('.up');if(u)u.textContent='+'+f(d)+' today';
var p=el.querySelector('.spark polyline');if(p)p.setAttribute('points',sparkPts(M.spark(id,t),110,30));sum+=d});
col.querySelectorAll('.item:not([data-live-seed])').forEach(function(el){sum+=+(el.getAttribute('data-today')||0)});
var ft=document.querySelector('[data-foot-today]');if(ft)ft.textContent=f(sum);
var sn=document.querySelector('[data-season]');if(sn)sn.textContent='Season '+M.seasonNo(t)}
function resort(){var items=[].slice.call(col.children);var sorted=items.slice().sort(function(a,b){return (+b.getAttribute('data-count'))-(+a.getAttribute('data-count'))});
if(sorted.every(function(el,i){return el===items[i]}))return;
var anim=!rm.matches,first=anim?items.map(function(el){return el.getBoundingClientRect().top}):null;
sorted.forEach(function(el){col.appendChild(el)});
if(!anim)return;items.forEach(function(el,i){var dy=first[i]-el.getBoundingClientRect().top;if(!dy)return;
el.style.transition='none';el.style.transform='translateY('+dy+'px)';el.getBoundingClientRect();
el.style.transition='transform .6s cubic-bezier(.2,.7,.2,1)';el.style.transform='';})}
var a=null,b=null;function start(){if(a)return;tick();a=setInterval(tick,1000);if(top)b=setInterval(resort,4500)}
function stop(){clearInterval(a);clearInterval(b);a=b=null}
document.addEventListener('visibilitychange',function(){document.hidden?stop():start()});
tick();if(top)resort();if(!document.hidden)start();
})((${liveModel.toString()})());</script>`;
}
