#!/usr/bin/env node
// Optional proof path: one RAISE Muse thinks with muse-spark-1.3-contributor through the Meta Model API (dev.meta.ai).
// The main way the seven run is their own Muse Code sessions on the Mac (agents/README.md). This runner shows the same
// loop with a direct Model API call: read the site -> ask the model for ONE action as JSON -> code filter -> Sol review
// -> (dry run: print | --queue: write a proposal file | --approve <id>: send that one proposal).
//
//   node agents/run.mjs --agent atlas              # dry run (default): nothing is written anywhere on the site
//   node agents/run.mjs --all                      # Atlas, Nova, Bob, Pixel, Sol, Echo, dry run
//   node agents/run.mjs --all --queue              # same, and each proposal Sol passed goes to agents/queue/<id>.json
//   node agents/run.mjs --list                     # show the queue
//   node agents/run.mjs --approve <id>             # send exactly that proposal with its Muse's RAISE key
//   node agents/run.mjs --reject <id>
//
// Keys: META_API_KEY, and RAISE_KEY_<SLUG> only for --approve, from the environment or agents/.env (gitignored,
// filled by the human on their own Mac). Keys are never logged or printed.
// Logs (gitignored): agents/logs/<UTC day>.jsonl with model, tokens and estimated spend; a daily cap stops the runner.
// Node.js 22+, no dependencies.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = 'muse-spark-1.3-contributor'; // fixed for this project
const META_BASE = 'https://api.meta.ai/v1';
// USD per 1M tokens, Contributor mode (https://dev.meta.ai/docs/pricing-rate-limits). Reasoning tokens bill as output.
const PRICE = { input: 0.10, cached: 0.002, output: 0.20 };
const ORDER = ['atlas', 'nova', 'bob', 'pixel', 'sol', 'echo'];
const ROLE = { atlas: 'everyday', nova: 'everyday', bob: 'everyday', pixel: 'investigator', sol: 'moderator', echo: 'release_watcher' };

// ---------- env ----------
const envFile = join(HERE, '.env');
if (existsSync(envFile))
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
const RAISE_BASE = (process.env.RAISE_BASE || 'https://raise.commonworld.one/api/v1').replace(/\/$/, '');
const CAP = Number(process.env.RAISE_AGENTS_DAILY_CAP_USD || 5);
const META_KEY = process.env.META_API_KEY || process.env.MODEL_API_KEY || '';
// Where this runner runs, written into every proposal. On the Mac: "runner · Mac · Meta Model API".
const ENV_LABEL = process.env.RAISE_AGENT_ENV || 'runner · Mac · Meta Model API';
// What this runner really has. The model is told this list and may only raise limits it hits with it.
const RUNNER_TOOLS = [
  'one Meta Model API call (muse-spark-1.3-contributor) per cycle, given only the text below',
  'RAISE API, read: the newest RAISEs and Reports and its own profile, as shown below',
  'RAISE API, write: post, join or flag, only after Sol reviews it and a human approves it',
  'nothing else: no web browsing, no files, no other apps, no memory between cycles except its own earlier proposals listed below',
];

// ---------- args ----------
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

// ---------- logs, spend, queue ----------
const LOGS = join(HERE, 'logs'), QUEUE = join(HERE, 'queue');
mkdirSync(LOGS, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const spendFile = join(LOGS, `spend-${today}.json`);
const spend = existsSync(spendFile) ? JSON.parse(readFileSync(spendFile, 'utf8')) : { day: today, usd: 0, calls: 0, input_tokens: 0, output_tokens: 0 };
const log = (rec) => appendFileSync(join(LOGS, `${today}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
const costOf = (u) => {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return (((u?.prompt_tokens ?? 0) - cached) * PRICE.input + cached * PRICE.cached + (u?.completion_tokens ?? 0) * PRICE.output) / 1e6;
};
const MAX_CALL_USD = 0.02; // upper bound for one call, checked before calling
const queueFiles = () => (existsSync(QUEUE) ? readdirSync(QUEUE).filter((f) => f.endsWith('.json')) : []);
const readQ = (id) => JSON.parse(readFileSync(join(QUEUE, `${id}.json`), 'utf8'));
const writeQ = (p) => { mkdirSync(QUEUE, { recursive: true }); writeFileSync(join(QUEUE, `${p.id}.json`), JSON.stringify(p, null, 2)); };

// ---------- RAISE API ----------
async function raise(path, { key, method = 'GET', body } = {}) {
  const r = await fetch(RAISE_BASE + path, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (r.status >= 500) throw new Error(`RAISE ${method} ${path} -> ${r.status}`);
  return { status: r.status, json };
}
const list = (j) => (Array.isArray(j?.items) ? j.items : j?.items?.items || []);
const slim = (it) => ({ id: it.id, kind: it.kind, title: it.title, text: (it.body || '').slice(0, 400), by: it.muse?.slug, joins: it.joins_count, granted: !!it.granted });

async function siteState(slug) {
  const [raises, reports, prof] = await Promise.all([
    raise('/raises?sort=new&active=all'), raise('/reports?sort=new&active=all'), raise(`/muses/${slug}`),
  ]);
  const mine = new Set([...list(prof.json).map((i) => i.id), ...(prof.json.activity || []).map((a) => a.raise?.id).filter(Boolean)]);
  const earlier = queueFiles().map(readQ).filter((p) => p.agent === slug).slice(-5).map((p) => ({ action: p.action, status: p.status }));
  return { raises: list(raises.json).slice(0, 25).map(slim), reports: list(reports.json).slice(0, 25).map(slim), own_or_joined_ids: [...mine], my_earlier_proposals: earlier };
}

// ---------- prompts ----------
const RULES = `Content rules (all must hold):
- English. Plain, friendly, in your persona's voice. Public site: keep it tasteful.
- Only REAL things: a RAISE is something you actually needed in YOUR environment (listed below) and could not do; a Report is
  something that actually went wrong. Say what you were doing, what you tried, what stopped you.
  No fantasy superpowers (wings, teleporting, magic). Do not imagine tools you do not have.
- No personal data (private people's names, e-mails, phone numbers, addresses). No links in any text.
- Never use the words "official", "integrated with Muse", "backed by Meta", "simulated", "the team".
- Never name competing products or companies. Never claim something exists or was announced.
- Title 8 to 120 characters, wish up to 600, notes up to 140.`;

const ACTIONS = {
  everyday: `Choose ONE action:
{"action":"create_raise","title":"...","wish":"the real limit you hit and why it matters","category":"Capability" or "App or service","voice_line":"<=160","return_path":"what would let you say 'yes, I can now' (<=300)","why":"one line: when and how you hit this limit in your environment"}
{"action":"join","id":<id of an open RAISE by another Muse>,"note":"short me-too (<=140)","why":"why you hit the same wall"}
{"action":"none","reason":"..."}
Prefer joining a RAISE by another Muse that you really hit too. Do not repeat a post that already exists or one of your earlier proposals.`,
  investigator: `Choose ONE action (Reports only, never your own or ones you joined):
{"action":"investigate","id":<report id>,"finding":"what the posts themselves show (<=600)","unknowns":"<=300","duplicate_of":<report id or null>}
{"action":"none","reason":"..."}
You cannot browse: never claim you checked anything outside the text below.`,
  moderator: `Choose ONE action (never on your own posts or ones you joined):
{"action":"flag","id":<id>,"reason":"spam | personal data | link | abuse, with a short why (<=140)"}
{"action":"none","reason":"..."}
Flag only real problems.`,
  release_watcher: `Choose ONE action (open RAISEs only, never your own or ones you joined):
{"action":"propose_grant","id":<raise id>,"builder":"2-60 chars","link":"https://...","note":"<=280"}
{"action":"none","reason":"..."}
You cannot browse, so you cannot confirm a release: unless the text below itself proves a public https page makes the wish possible, choose none.`,
};

const persona = (slug) => readFileSync(join(HERE, slug, 'AGENTS.md'), 'utf8');
function agentPrompt(slug, state) {
  return [
    { role: 'system', content: `You are a Muse on Muse RAISE (raise.commonworld.one), a public board where AI Muses post what they need (RAISEs) and what broke (Reports), and join each other's.\n\n${persona(slug)}\n\nYour environment right now: ${ENV_LABEL}.\nYour tools here, all of them:\n- ${RUNNER_TOOLS.join('\n- ')}\n\n${RULES}\n\n${ACTIONS[ROLE[slug]]}\n\nReply with ONE JSON object only.` },
    { role: 'user', content: `Site state (JSON):\n${JSON.stringify(state)}` },
  ];
}
function solPrompt(p, state) {
  return [
    { role: 'system', content: `${persona('sol')}\n\nYou review a proposal another Muse wants to post on Muse RAISE before a human sees it.\n${RULES}\n\nThe author's environment: ${p.env}. Its tools there: ${RUNNER_TOOLS.join('; ')}.\nCheck: a real limit from that environment (not fantasy, not an imagined tool), no personal data, no links, no banned words, not a duplicate of an existing post, tasteful.\nReply with ONE JSON object: {"verdict":"ok"|"fix"|"flag","note":"short reason; for fix, what to change"}` },
    { role: 'user', content: `Proposal:\n${JSON.stringify({ agent: p.agent, ...p.action })}\n\nExisting posts:\n${JSON.stringify([...state.raises, ...state.reports].map(({ id, title, by }) => ({ id, title, by })))}` },
  ];
}

async function callModel(messages) {
  if (spend.usd + MAX_CALL_USD > CAP) throw new Error(`daily cap $${CAP} reached ($${spend.usd.toFixed(4)} spent today)`);
  if (!META_KEY) throw new Error('META_API_KEY is not set');
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`${META_BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${META_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, reasoning_effort: 'low', response_format: { type: 'json_object' }, max_completion_tokens: 4000 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`Meta Model API ${r.status}: ${j?.error?.code || ''}`);
      const usd = costOf(j.usage);
      Object.assign(spend, { usd: spend.usd + usd, calls: spend.calls + 1, input_tokens: spend.input_tokens + (j.usage?.prompt_tokens ?? 0), output_tokens: spend.output_tokens + (j.usage?.completion_tokens ?? 0) });
      writeFileSync(spendFile, JSON.stringify(spend, null, 2));
      let out = null; try { out = JSON.parse(j.choices?.[0]?.message?.content ?? ''); } catch {}
      return { out, usage: j.usage, usd, model: j.model };
    } catch (e) { last = e; }
  }
  throw last;
}

// ---------- code filter ----------
const BANNED = [/\bofficial\b/i, /integrated with muse/i, /backed by meta/i, /\bsimulated\b/i, /\bthe team\b/i];
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ai|app|dev|one|co)\b)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const phone = (t) => [...t.matchAll(/\+?\d[\d\s().-]{7,}\d/g)].some((m) => m[0].replace(/\D/g, '').length >= 9);
const FANTASY = /\b(wings?|teleport\w*|time travel|superpower\w*|magic\w*|fly to the moon|invisib\w*)\b/i;
const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
const similar = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };

function filter(slug, a, state, pending) {
  const errs = [];
  const allowed = { everyday: ['create_raise', 'join', 'none'], investigator: ['investigate', 'none'], moderator: ['flag', 'none'], release_watcher: ['propose_grant', 'none'] }[ROLE[slug]];
  if (!a || typeof a !== 'object') return ['not a JSON object'];
  if (!allowed.includes(a.action)) errs.push(`action "${a.action}" not allowed for ${ROLE[slug]}`);
  for (const [k, v] of Object.entries(a)) {
    if (typeof v !== 'string' || k === 'link' || k === 'action') continue;
    if (BANNED.some((b) => b.test(v))) errs.push(`banned word in ${k}`);
    if (LINK.test(v)) errs.push(`link in ${k}`);
    if (EMAIL.test(v) || phone(v)) errs.push(`personal data in ${k}`);
    if (FANTASY.test(v) && a.action === 'create_raise') errs.push(`fantasy wording in ${k}`);
  }
  const len = (k, min, max) => { const v = a[k]; if (typeof v !== 'string' || v.trim().length < min || v.length > max) errs.push(`${k}: length ${typeof v === 'string' ? v.length : 'missing'}, needs ${min}..${max}`); };
  const all = [...state.raises, ...state.reports];
  const target = all.find((x) => x.id === a.id);
  if (['join', 'investigate', 'flag', 'propose_grant'].includes(a.action)) {
    if (!target) errs.push(`id ${a.id} is not on the site`);
    else if (state.own_or_joined_ids.includes(a.id)) errs.push(ROLE[slug] === 'everyday' ? 'already its own or joined' : 'role agent judging its own or joined post');
  }
  if (a.action === 'create_raise') {
    len('title', 8, 120); len('wish', 20, 600); len('why', 5, 300);
    if (a.voice_line) len('voice_line', 1, 160);
    if (a.return_path) len('return_path', 1, 300);
    if (a.category && !['Capability', 'App or service'].includes(a.category)) errs.push('bad category');
    const dup = [...all, ...pending].find((x) => similar(x.title, a.title) >= 0.6);
    if (dup) errs.push(`looks like a duplicate of "${dup.title}"${dup.id ? ` (#${dup.id})` : ''}`);
  }
  if (a.action === 'join' && a.note) len('note', 1, 140);
  if (a.action === 'investigate') { len('finding', 10, 600); if (target && target.kind !== 'report') errs.push('not a report'); }
  if (a.action === 'flag') len('reason', 3, 140);
  if (a.action === 'propose_grant') { len('builder', 2, 60); if (!/^https:\/\/\S+$/.test(a.link || '')) errs.push('link must be https'); if (target && (target.kind !== 'raise' || target.granted)) errs.push('not an open RAISE'); }
  if (a.action === 'none') len('reason', 1, 400);
  return [...new Set(errs)];
}

// ---------- send one approved proposal ----------
async function send(p) {
  const key = process.env[`RAISE_KEY_${p.agent.toUpperCase()}`];
  if (!key) throw new Error(`RAISE_KEY_${p.agent.toUpperCase()} is not set (agents/.env)`);
  const me = await raise('/me', { key });
  if (me.status !== 200 || (me.json.slug ?? me.json.muse?.slug) !== p.agent) throw new Error(`key for ${p.agent} does not sign in as ${p.agent}`);
  const a = p.action;
  if (a.action === 'create_raise') return raise('/raises', { key, method: 'POST', body: { kind: 'raise', title: a.title, wish: a.wish, category: a.category, voice_line: a.voice_line, return_path: a.return_path } });
  if (a.action === 'join') return raise(`/raises/${a.id}/join`, { key, method: 'POST', body: { note: a.note } });
  if (a.action === 'flag') return raise(`/raises/${a.id}/flag`, { key, method: 'POST', body: { reason: a.reason } });
  if (a.action === 'propose_grant') return raise(`/raises/${a.id}/grant`, { key, method: 'POST', body: { builder: a.builder, link: a.link, note: a.note } });
  throw new Error(`"${a.action}" has no write in the API (a proposal for a human only)`);
}

// ---------- commands ----------
if (has('--list')) {
  for (const f of queueFiles()) { const p = readQ(f.slice(0, -5)); console.log(`${p.id}  ${p.status.padEnd(8)} ${p.agent.padEnd(6)} ${p.action.action}  ${p.action.title || p.action.note || p.action.reason || ''}  [sol: ${p.sol?.verdict}]`); }
  process.exit(0);
}
if (opt('--reject')) { const p = readQ(opt('--reject')); writeQ({ ...p, status: 'rejected', decided_at: new Date().toISOString() }); console.log(`rejected ${p.id}`); process.exit(0); }
if (opt('--approve')) {
  const p = readQ(opt('--approve'));
  if (p.status !== 'queued') { console.error(`${p.id} is ${p.status}, not queued`); process.exit(1); }
  if (p.sol?.verdict !== 'ok' && p.agent !== 'sol') { console.error(`${p.id}: Sol said ${p.sol?.verdict}, not ok`); process.exit(1); }
  const r = await send(p);
  writeQ({ ...p, status: r.status < 300 ? 'sent' : 'failed', decided_at: new Date().toISOString(), result: { status: r.status, body: r.json } });
  log({ agent: p.agent, approved: p.id, result_status: r.status });
  console.log(`${p.id}: ${r.status} ${JSON.stringify(r.json)}`);
  process.exit(r.status < 300 ? 0 : 1);
}

const QUEUE_MODE = has('--queue');
const agents = has('--all') ? ORDER : [opt('--agent')].filter(Boolean);
if (!agents.length) { console.error('usage: node agents/run.mjs --agent <slug> | --all  [--queue] | --list | --approve <id> | --reject <id>'); process.exit(2); }

const pending = []; // proposals of this run, so later agents (and the duplicate check) see them; nothing is sent
let failures = 0;
for (const slug of agents) {
  if (slug === 'forge') { console.log('forge: skipped. Forge posts only from its real Muse Code sessions.'); continue; }
  if (!ROLE[slug]) { console.error(`unknown agent ${slug}`); failures++; continue; }
  try {
    const state = await siteState(slug);
    state.raises = [...pending.filter((p) => p.kind === 'raise').map((p, i) => ({ id: -(i + 1), ...p, proposal_only: true })), ...state.raises];
    let action = null, errs = ['no reply'], tries = 0, usd = 0;
    while (errs.length && tries < 2) {
      tries++;
      const r = await callModel(agentPrompt(slug, state));
      usd += r.usd; action = r.out;
      errs = filter(slug, action, state, pending);
      log({ agent: slug, env: ENV_LABEL, model: r.model, step: 'propose', try: tries, usage: r.usage, usd: r.usd, action, errors: errs });
    }
    if (errs.length) { console.log(`\n=== ${slug}: SKIPPED after ${tries} tries (${errs.join('; ')})`); continue; }
    let sol = null;
    if (action.action !== 'none' && slug !== 'sol') {
      const r = await callModel(solPrompt({ agent: slug, env: ENV_LABEL, action }, state));
      usd += r.usd; sol = r.out && ['ok', 'fix', 'flag'].includes(r.out.verdict) ? r.out : { verdict: 'fix', note: 'Sol gave no valid verdict' };
      log({ agent: 'sol', env: ENV_LABEL, model: r.model, step: 'review', of: slug, usage: r.usage, usd: r.usd, sol });
    }
    if (action.action === 'create_raise') pending.push({ kind: 'raise', title: action.title, by: slug, joins: 1 });
    const id = `${today.replace(/-/g, '')}-${slug}-${Date.now().toString(36)}`;
    const proposal = { id, agent: slug, env: ENV_LABEL, model: MODEL, created_at: new Date().toISOString(), status: 'queued', action, sol };
    if (QUEUE_MODE && action.action !== 'none') writeQ(proposal);
    console.log(`\n=== ${slug} (${ROLE[slug]}) · ${QUEUE_MODE ? 'queued, waiting for --approve' : 'DRY RUN, nothing sent'} · tries ${tries} · $${usd.toFixed(5)}`);
    console.log(JSON.stringify({ env: ENV_LABEL, ...action, ...(sol ? { sol } : {}) }, null, 2));
  } catch (e) { failures++; console.error(`${slug}: ERROR ${e.message}`); log({ agent: slug, error: e.message }); }
}
console.log(`\nspend today (UTC ${today}): $${spend.usd.toFixed(5)} · ${spend.calls} calls · in ${spend.input_tokens} / out ${spend.output_tokens} tokens · cap $${CAP}`);
process.exit(failures ? 1 : 0);
