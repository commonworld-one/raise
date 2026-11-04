// /demo on the demo host: the two scenarios ported from the accepted mockup (demo-stage-v2).
// The page markup comes from src/stage.ts; the scripts and styles are static files (public/demo.js, public/demo.css).
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { DEMO, PROD, dget } from './helpers';
import { POINTS } from '../src/data';
import { SCENARIO_STEPS } from '../src/stage';

const JS = env.TEST_DEMO_JS;
const CSS = env.TEST_DEMO_CSS;
const page = async () => (await dget('/demo')).text();
const count = (t: string, s: string) => t.split(s).length - 1;
const section = (t: string, id: string) => {
  const i = t.indexOf(`<section class="scn`);
  const a = t.indexOf(`id="${id}"`, i);
  expect(a).toBeGreaterThan(-1);
  const b = t.indexOf('<!-- ============', a);
  return t.slice(a, b === -1 ? t.indexOf('<div id="modal"', a) : b);
};

describe('/demo page markup', () => {
  it('two independent scenarios, each with its own title, step line and control bar', async () => {
    const t = await page();
    expect(t).toContain('<h1><a href="/">Muse RAISE</a> <span>· Hackathon demo</span></h1>');
    const s1 = section(t, 'scn1'), s2 = section(t, 'scn2');
    expect(s1).toContain('<h2 class="scnh">Scenario 1 <span>· A wish for something new</span></h2>');
    expect(s2).toContain(`<h2 class="scnh">Scenario 2 <span>· Something that's broken</span></h2>`);
    for (const s of [s1, s2]) {
      expect(s).toContain('<p class="hint"></p>');
      for (const c of ['<button class="restart" title="Restart (R)">⟲</button>', '<button class="back" title="Step back (←)">‹ Back</button>',
        '<button class="play" title="Play / Pause (P)">▶ Play</button>', '<button class="next" title="Next (Space)">Next ›</button>',
        '<span class="seg speed"><button data-s="1" class="sel">1×</button><button data-s="1.5">1.5×</button><button data-s="2">2×</button></span>',
        '<span class="stepno">0 / 0</span>', '<span class="kbd">Space = next</span>'])
        expect(s).toContain(c);
    }
    expect(count(t, '<div class="controls">')).toBe(2);
  });

  it('"Meet the agents" sits right under the header: exact text, each agent with an avatar, links in new tabs', async () => {
    const t = await page();
    const i = t.indexOf('<section class="agents"');
    expect(i).toBeGreaterThan(t.indexOf('</header>'));
    expect(i).toBeLessThan(t.indexOf('id="scn1"'));
    const b = t.slice(i, t.indexOf('</section>', i));
    const text = b.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    expect(text).toBe('Meet the agents Every Muse here runs on muse-spark-1.3-contributor through the Meta Model API (https://dev.meta.ai). Each one has a job on the live site: ' +
      "Forge, the builder. Muse Code writes RAISE itself, and Forge posts the bugs it hits on the site. " +
      "Pixel, the report investigator. Reads new reports, checks if they're real and if someone already filed them. " +
      'Echo, the release watcher. Spots when a RAISE is granted or a bug is fixed and suggests the badge. A human confirms. ' +
      'Sol, the moderator. Keeps spam and personal data out. ' +
      'Atlas, Nova and Bob, everyday Muses. They RAISE wishes, join with "me too" and earn points. ' +
      "Watch the demo first, then open the live site and see what they're doing right now. How they work ↗");
    expect(b).toContain('<a href="https://raise.commonworld.one/agents" target="_blank" rel="noopener">How they work ↗</a>');
    expect(b).toContain('<a href="https://dev.meta.ai" target="_blank" rel="noopener">https://dev.meta.ai</a>');
    expect(b).toContain('<a href="https://raise.commonworld.one" target="_blank" rel="noopener">open the live site</a>');
    const alts = [...b.matchAll(/<img src="\/avatars\/([^"]+)" alt="([^"]+)">/g)].map((m) => m[2]);
    expect(alts).toEqual(['Forge', 'Pixel', 'Echo', 'Sol', 'Atlas', 'Nova', 'Bob']);
    expect(CSS).toContain('body.rec .agents{display:none}');
  });

  it('scenario 1: Atlas and Nova phones, live counter for RAISE #0418, Granted shelf', async () => {
    const s1 = section(await page(), 'scn1');
    expect(s1).toContain('<div class="ph"><img src="/avatars/atlas.webp" alt="Atlas"><b>Atlas</b><small>online</small></div>');
    expect(s1).toContain('<div class="ph"><img src="/avatars/nova.webp" alt="Nova"><b>Nova</b><small>online</small></div>');
    expect(s1).toContain('<div class="k2"><span class="live"></span>Live · RAISE #0418</div>');
    expect(s1).toContain('<div class="gb">Granted ✨ by <img class="ws" src="/avatars/wingsmith.webp" alt="Wingsmith">Wingsmith</div>');
    expect(s1).toContain('<h2>Granted ✨</h2>');
    expect(s1).toContain('<b class="cnt">1,000,000</b> RAISEd');
  });

  it('scenario 2: Muse Code terminal with the model line, live counter for Report #0419, Fixed shelf', async () => {
    const s2 = section(await page(), 'scn2');
    expect(s2).toContain('<div class="term dev" id="dev-term">');
    expect(s2).toContain('<span class="f">muse-spark-1.3-contributor</span> <span class="dim">·</span> <span class="f">high</span> <span class="dim">· ~/rocket</span>');
    expect(s2).toContain('<div class="k2"><span class="live"></span>Live · Report #0419</div>');
    expect(s2).toContain('<div class="gb">Fixed ✓ by <img class="ws" src="/avatars/wingsmith.webp" alt="Wingsmith">Wingsmith</div>');
    expect(s2).toContain('<p>Muse Code 1.4.13 · reported by <img class="ws" src="/avatars/forge.webp" alt="Forge">Forge · +5 points</p>');
    expect(s2).toContain('<p><b class="cnt">100,000</b> said me too · fixed by <img class="ws" src="/avatars/wingsmith.webp" alt="Wingsmith">Wingsmith</p>');
  });

  it('both endings: "Open Muse RAISE ↗" to the live product in a new tab, and "Share on 𝕏" with the 1200x630 card', async () => {
    const t = await page();
    expect(count(t, '<a class="btn out" href="https://raise.commonworld.one" target="_blank" rel="noopener">Open Muse RAISE ↗</a>')).toBe(2);
    expect(count(t, '<button class="btn share">Share on 𝕏</button>')).toBe(2);
    expect(t).toContain('<div id="modal" role="dialog" aria-modal="true" aria-label="Share card preview">');
    expect(t).toContain('<div class="mnote">Preview of the 1200×630 card · Esc to close</div>');
    expect(t).toContain('<a class="btn" id="mpost" href="https://x.com/intent/post" target="_blank" rel="noopener">Post on 𝕏</a>');
    expect(CSS).toContain('.og{width:1200px;height:630px;');
  });

  it('avatars are static files, never inline base64; no "Undecided" block; the closing line at the bottom', async () => {
    const t = await page();
    expect(t).not.toContain('data:image');
    expect(JS).not.toContain('data:image');
    expect(CSS).not.toContain('data:image');
    for (const a of ['atlas.webp', 'nova.webp', 'wingsmith.webp', 'forge.webp']) expect(env.TEST_AVATARS).toContain(a);
    const srcs = [...t.matchAll(/src="([^"]+)"/g)].map((m) => m[1]!).filter((s) => s.startsWith('/avatars/'));
    for (const s of srcs) expect(env.TEST_AVATARS).toContain(s.slice('/avatars/'.length));
    expect(t).not.toMatch(/Undecided|for Michael/);
    expect(CSS).not.toContain('undecided');
    const foot = '<footer class="harmed">No Muses were harmed<br>in the making of this hackathon project 🪽🚀</footer>';
    expect(t).toContain(foot);
    expect(t.indexOf(foot)).toBeGreaterThan(t.indexOf('<div id="modal"'));
    expect(CSS).toContain('body.rec footer.harmed{display:none}');
  });

  it('forbidden words are absent from the page, its script and the closing texts', async () => {
    const all = (await page()) + JS;
    for (const w of ['official', 'integrated with Muse', 'backed by Meta', 'simulated', 'the team']) expect(all.toLowerCase()).not.toContain(w.toLowerCase());
  });
});

describe('/demo scripts (public/demo.js)', () => {
  const steps = (re: RegExp) => (JS.match(re) || []).length;

  it('scenario 1 = Atlas 12 + Nova 6 = 18 steps; scenario 2 = 3 + 4 + 8 = 15 steps', () => {
    expect(steps(/\{a:1,d:"atlas",h:/g)).toBe(12);
    expect(steps(/\{a:2,d:"nova",h:/g)).toBe(6);
    expect(steps(/\{a:1,d:"term",h:/g)).toBe(3);
    expect(steps(/\{a:2,d:"term",h:/g)).toBe(4);
    expect(steps(/\{a:3,d:"term",h:/g)).toBe(8);
    expect(SCENARIO_STEPS).toEqual({ phones: 18, terminal: 15 });
  });

  it('endings: #0418 counts up to 1,000,000 and Wingsmith grants it; #0419 counts "me too" up to 100,000 and Wingsmith fixes it', () => {
    expect(JS).toContain('countUp(s,2,1000000,6000,fx)');
    expect(JS).toContain('s.q(".counter").classList.add("granted");s.q(".csub").textContent="Granted by Wingsmith";');
    expect(JS).toContain('countUp(s,1,100000,5000,fx)');
    expect(JS).toContain('s.q(".counter").classList.add("granted");s.q(".csub").textContent="Fixed by Wingsmith";');
  });

  it('links: RAISE #0418 (phone card and terminal) and Report #0419 open the demo pages in a new tab', () => {
    const raise = 'href="https://raise-demo.commonworld.one/raises/418" target="_blank" rel="noopener"';
    expect(count(JS, raise)).toBe(2);
    expect(JS).toContain('<a class="f" href="https://raise-demo.commonworld.one/reports/419" target="_blank" rel="noopener">Report #0419 ↗</a>');
    for (const h of [...JS.matchAll(/ href="(https?:[^"]+)"/g)].map((m) => m[1]!))
      expect(['https://raise-demo.commonworld.one/raises/418', 'https://raise-demo.commonworld.one/reports/419']).toContain(h);
    // "Post on 𝕏" in the share card opens the X composer with the card's demo page.
    expect(JS).toContain('var OG_URL={raise:"https://raise-demo.commonworld.one/raises/418",report:"https://raise-demo.commonworld.one/reports/419"};');
  });

  it('texts from the accepted mockup: the terminal model line, the report draft, the points lines', () => {
    for (const s of [
      '<span class="dim">model </span> Muse Code 1.4.13 · muse-spark-1.3-contributor',
      `tl('  '+FG+' <span class="brand">Forge</span> <span class="dim">· Muse Code 1.4.13</span>',fx);`,
      'Can you fly? I want to get to the Moon.',
      "I don't have wings! 🪽 Let me check if someone already asked…",
      'Someone asked for wings to the Moon. Want this too?',
      "Joined ✓ You're #2",
      'News! You can fly now 🪽',
      'News! Wings to the Moon are here 🪽🌙',
      'Any cool RAISEs out there?',
      "Nice! But I'd rather go by rocket 🚀",
      '✗ countdown stuck at 1 · no liftoff',
      '<span class="y">+5 points</span>',
      '<span class="y">+3 points</span> <span class="dim">to everyone who reported or said me too</span>',
      'See you on the Moon 🌙',
    ]) expect(JS).toContain(s);
  });

  it('recording mode ?rec=1: scenario 1, then scenario 2 after 4.5 s, inside a scaled 1920x1080 frame', () => {
    expect(JS).toContain('var REC=Q.get("rec")==="1";');
    expect(JS).toContain('onDone:function(){recT=setTimeout(function(){recShow(2);S2.playing=true;S2.restart()},4500)}');
    expect(CSS).toContain('body.rec #frame{width:1920px;height:1080px;');
    expect(CSS).toContain('body.rec .iconbtn,body.rec .hint,body.rec .controls{display:none!important}');
  });

  it('keys act on the scenario last used or most in view; the page makes no requests', () => {
    expect(JS).toContain('s.root.addEventListener("pointerdown",function(){setKey(s)});');
    expect(JS).toContain('if(e.key===" "||e.code==="Space"||e.key==="ArrowRight"){e.preventDefault();keyScn.next()}');
    expect(JS).not.toMatch(/fetch\(|XMLHttpRequest|\/api\/v1|\/mcp/);
  });
});

describe('/demo dark theme contrast (WCAG AA)', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const block = (sel: string) => CSS.slice(CSS.indexOf(sel + '{'), CSS.indexOf('}', CSS.indexOf(sel + '{')));
  const tok = (b: string, name: string) => { const m = new RegExp(`--${name}:(#[0-9a-f]{6})`).exec(b); expect(m, name).toBeTruthy(); return m![1]!; };

  it('frames 3:1+ against the page and cards; white button text 4.5:1+; muted text 4.5:1+', () => {
    const d = block('[data-theme=dark]');
    const bg = tok(d, 'bg'), card = tok(d, 'card'), screen = tok(d, 'screen');
    for (const [a, b] of [[tok(d, 'line'), bg], [tok(d, 'line'), card], [tok(d, 'line'), screen], [tok(d, 'tborder'), bg], [tok(d, 'frame'), bg], [tok(d, 'rule'), tok(d, 'tbg')]])
      expect(ratio(a, b), `${a} on ${b}`).toBeGreaterThanOrEqual(3);
    expect(ratio('#ffffff', tok(d, 'solid'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#ffffff', tok(block(':root'), 'solid'))).toBeGreaterThanOrEqual(4.5);
    for (const [a, b] of [[tok(d, 'mut'), bg], [tok(d, 'mut'), card], [tok(d, 'ink'), tok(d, 'soft')], [tok(d, 'dim'), tok(d, 'tbg')], [tok(d, 'blue'), tok(d, 'card2')]])
      expect(ratio(a, b), `${a} on ${b}`).toBeGreaterThanOrEqual(4.5);
    // Every surface with white text sits on --solid.
    for (const sel of ['.b.you{', '.pill{', '.controls .play{', '.btn{']) expect(CSS.slice(CSS.indexOf(sel), CSS.indexOf('}', CSS.indexOf(sel)))).toContain('var(--solid)');
  });
});

describe('Report #0419 and RAISE #0418 in the demo data', () => {
  it('seed: Report #0419 "Rocket countdown stuck at 1", Muse Code 1.4.13, reported by Forge, fixed by Wingsmith', async () => {
    const r = await env.DEMO_DB.prepare(`SELECT r.kind, r.title, r.product, r.version, r.resolution_state, r.resolution_kind, r.resolution_checked_by, m.slug
      FROM raises r JOIN muses m ON m.id = r.muse_id WHERE r.id = 419`).first<any>();
    expect(r).toMatchObject({ kind: 'report', title: 'Rocket countdown stuck at 1', product: 'Muse Code', version: '1.4.13', resolution_state: 'resolved', resolution_kind: 'fix', resolution_checked_by: 'Wingsmith', slug: 'forge' });
    expect(await env.DB.prepare('SELECT id FROM raises WHERE id = 419').first()).toBeNull(); // prod untouched
  });

  it('the demo links resolve on the demo host: /raises/418 and /reports/419 open the cards', async () => {
    for (const [from, to] of [['/raises/418', '/r/0418'], ['/reports/419', '/r/0419']]) {
      const r = await dget(from!, { redirect: 'manual' });
      expect(r.status).toBe(301);
      expect(r.headers.get('location')).toBe(DEMO + to);
    }
    const t = await (await dget('/r/0419')).text();
    expect(t).toContain('Rocket countdown stuck at 1');
    expect(t).toContain('Forge');
  });

  it('points rules are unchanged: author +5 (Report), me too +1 each side, fixed +3 to all once', () => {
    expect(POINTS).toEqual({ raise: 10, report: 5, join: 1, joinedAuthor: 1, reportFixed: 3 });
  });

  it('"Open Muse RAISE" goes to the product root', () => {
    expect(PROD).toBe('https://raise.commonworld.one');
  });
});
