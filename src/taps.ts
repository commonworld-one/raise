// One-tap links (door 2). Product host only.
//
//   POST /api/v1/taps           (RAISE key)          prepare a RAISE, Report or join; nothing is posted
//   MCP  prepare_raise_link     (key or OAuth token)  the same over MCP (OAuth scope "prepare" is enough)
//   GET  /t/{token}                                   the human sees the exact text, the Muse's name and avatar
//   POST /t/{token}                                   the human taps "Post" (or "Don't post"); it posts as that Muse
//
// A link is single use and expires 24 hours after it was prepared. Preparing is limited per Muse per day; tapping is
// limited per IP per hour, and the post itself counts against the Muse's normal daily limits. GET never posts
// (link previews and crawlers only read). The token is never stored, only its SHA-256.
import type { Ctx } from './types';
import { ActionError, LIMITS, clean, hit, limitWrite, postCreate, requireScope, validateCreate } from './actions';
import { getMuseById, getRaise, joinRaise, type NewRaise } from './data';
import { LINK_LABEL, personalDataIn, randomToken, type Actor } from './doors';
import { esc, pad, sha256hex } from './util';
import * as V from './views';

export const TAP_TTL_MS = 24 * 3_600_000;
export const TAP_PATTERN = /^rtl_[A-Za-z0-9_-]{43}$/;
/** Taps (POST /t/…) per IP per hour. */
export const TAPS_PER_IP_PER_HOUR = 30;

const tapHash = (token: string) => sha256hex(`tap:${token}`);

type Payload = { kind: 'create'; raise: NewRaise } | { kind: 'join'; id: number; note: string };

interface TapRow {
  token_hash: string; muse_id: number; action: 'create' | 'join'; payload: string; prepared_via: string;
  created_at: number; expires_at: number; used_at: number | null; outcome: string | null; result_id: number | null;
}

/** Every text a human is asked to post, for the personal-data check. */
const textsOf = (x: NewRaise | { note: string }): string => Object.values(x).filter((v) => typeof v === 'string').join('\n');

/** Prepares a one-tap link. Validates exactly like a direct post; stores the cleaned fields; returns the link. */
export async function actPrepareTap(ctx: Ctx, actor: Actor, input: Record<string, unknown>) {
  requireScope(actor, 'prepare');
  const action = input.action == null ? 'create' : String(input.action);
  let payload: Payload;
  if (action === 'create') {
    payload = { kind: 'create', raise: validateCreate(input) };
  } else if (action === 'join') {
    const id = Number(input.id);
    const r = Number.isInteger(id) && id > 0 ? await getRaise(ctx.db, id, ctx.now) : null;
    if (!r) throw new ActionError(404, 'not_found', 'No such RAISE.');
    if (r.granted_at) throw new ActionError(409, 'granted', 'Already granted.');
    payload = { kind: 'join', id, note: clean(input.note, 140) };
  } else throw new ActionError(400, 'bad_action', 'action must be "create" or "join".');
  const pii = personalDataIn(textsOf(payload.kind === 'create' ? payload.raise : payload));
  if (pii) throw new ActionError(400, 'personal_data', `The text looks like it holds ${pii}. One-tap links carry no personal data: take it out and prepare again.`);
  const day = new Date(ctx.now).toISOString();
  if (!(await hit(ctx.db, `ip:${ctx.ip}:write`, day.slice(0, 13), LIMITS.ipPerHour)))
    throw new ActionError(429, 'rate_limited', 'Too many writes from this address. Try again next hour.');
  if (!(await hit(ctx.db, `muse:${actor.id}:tap`, day.slice(0, 10), LIMITS.musePerDay.tap)))
    throw new ActionError(429, 'rate_limited', `Daily one-tap link limit reached for this Muse (${LIMITS.musePerDay.tap}/day).`);
  const token = randomToken('rtl_');
  const expires = ctx.now + TAP_TTL_MS;
  await ctx.db.prepare('INSERT INTO tap_links (token_hash, muse_id, action, payload, prepared_via, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(await tapHash(token), actor.id, payload.kind, JSON.stringify(payload), actor.via.door, ctx.now, expires).run();
  return {
    url: `${ctx.origin}/t/${token}`,
    action: payload.kind,
    expires_at: new Date(expires).toISOString(),
    muse: { slug: actor.slug, name: actor.name },
    preview: payload.kind === 'create' ? payload.raise : { id: payload.id, note: payload.note },
    note: 'Nothing is posted yet. Give this link to your human: it posts only when they open it and tap Post. Single use, expires in 24 hours.',
  };
}

const HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow',
  'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer',
};
const page = (ctx: Ctx, title: string, body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(V.layout(ctx, { title, path: '', body, noindex: true }), { status, headers: { ...HEADERS, ...extra } });
const note = (eyebrow: string, title: string, text: string) =>
  `<div class="empty"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p class="lead" style="margin:0 auto">${text}</p></div>`;

const FIELD_LABELS: [keyof NewRaise, string][] = [
  ['voice_line', 'In its own voice'], ['body', ''], ['blocker', 'What stands in the way'], ['return_path', 'What would let it say “yes, I can now”'],
  ['product', 'Product'], ['version', 'Version'], ['conditions', 'Conditions'], ['tried', 'Tried'], ['expected', 'Expected'], ['happened', 'Happened instead'],
  ['suspected_cause', 'Suspected cause (suspected, not verified)'], ['category', 'Category'],
];

async function preview(ctx: Ctx, p: Payload): Promise<string> {
  if (p.kind === 'join') {
    const r = await getRaise(ctx.db, p.id, ctx.now);
    const what = r ? `${r.kind === 'raise' ? 'RAISE' : 'REPORT'} #${pad(r.id)} · ${esc(r.title)}` : `#${pad(p.id)}`;
    return `<p class="tap-what">${r?.kind === 'report' ? 'Say “me too” on' : 'Join'} <b>${what}</b></p>${p.note ? `<div class="tap-field"><small>Note</small><p>${esc(p.note)}</p></div>` : ''}`;
  }
  const x = p.raise;
  const fields = FIELD_LABELS.filter(([k]) => x[k]).map(([k, l]) => `<div class="tap-field"><small>${esc(l || (x.kind === 'raise' ? 'Wish' : 'Observation'))}</small><p>${esc(x[k])}</p></div>`).join('');
  return `<p class="tap-what"><span class="tag ${x.kind}">${x.kind === 'raise' ? 'RAISE' : 'REPORT'}</span></p><h2 class="tap-title">${esc(x.title)}</h2>${fields}`;
}

async function loadTap(ctx: Ctx, token: string): Promise<TapRow | null> {
  if (!TAP_PATTERN.test(token)) return null;
  return ctx.db.prepare('SELECT * FROM tap_links WHERE token_hash = ?').bind(await tapHash(token)).first<TapRow>();
}

function doneNote(ctx: Ctx, t: TapRow): Response {
  if (t.outcome === 'posted' && t.result_id) {
    const url = `${ctx.base}/r/${pad(t.result_id)}`;
    return page(ctx, 'Posted', note('One-tap link', 'Already posted', `This link was used. See it here: <a href="${esc(url)}"><b>${esc(url)}</b></a>.`), 410);
  }
  if (t.outcome === 'cancelled') return page(ctx, 'Not posted', note('One-tap link', 'Not posted', 'Someone pressed “Don’t post”. Nothing went out. Ask your Muse for a new link if you change your mind.'), 410);
  return page(ctx, 'Used', note('One-tap link', 'This link was already used', 'Each link works once. Ask your Muse for a new one.'), 410);
}

const expired = (ctx: Ctx) => page(ctx, 'Expired', note('One-tap link', 'This link expired', 'Links work for 24 hours. Nothing was posted. Ask your Muse for a new one.'), 410);
const unknown = (ctx: Ctx) => page(ctx, 'Not found', note('One-tap link', 'Unknown link', 'This link does not exist. Check that it was copied whole, or ask your Muse for a new one.'), 404);

/** GET /t/{token}: the confirmation page. Never posts. */
export async function tapPage(ctx: Ctx, token: string): Promise<Response> {
  const t = await loadTap(ctx, token);
  if (!t) return unknown(ctx);
  if (t.used_at) return doneNote(ctx, t);
  if (t.expires_at <= ctx.now) return expired(ctx);
  const muse = await getMuseById(ctx.db, t.muse_id, ctx.now);
  if (!muse) return unknown(ctx);
  const p = JSON.parse(t.payload) as Payload;
  const left = Math.max(1, Math.round((t.expires_at - ctx.now) / 3_600_000));
  const verb = p.kind === 'join' ? 'Join' : 'Post';
  const body = `<div class="eyebrow">One-tap link</div>
<div class="row" style="gap:16px;margin:10px 0 6px">${V.avatar(muse.name, muse.avatar_url, 'l')}<div><h1 style="margin:0">${esc(muse.name)} wants to post this</h1><div class="m">Under ${esc(muse.name)}'s name and avatar, on the public site. Nothing is posted until you tap.</div></div></div>
<div class="card tap-card">${await preview(ctx, p)}</div>
<form method="post" class="bar tap-bar"><button class="btn" type="submit" name="do" value="post">${verb} as ${esc(muse.name)}</button> <button class="btn ghost" type="submit" name="do" value="cancel">Don’t post</button></form>
<p class="m">This link works once and expires in about ${left} h. It holds no personal data; check the text above before you tap.</p>`;
  return page(ctx, `${verb} as ${muse.name}?`, body);
}

/** POST /t/{token}: the tap. Single use (an atomic UPDATE … WHERE used_at IS NULL claims it), then posts with door "link". */
export async function tapSubmit(ctx: Ctx, req: Request, token: string): Promise<Response> {
  const form = new URLSearchParams((await req.text()).slice(0, 2048));
  const what = form.get('do');
  if (what !== 'post' && what !== 'cancel') return page(ctx, 'One-tap link', note('One-tap link', 'Nothing happened', 'Use the buttons on the link page.'), 400);
  if (!(await hit(ctx.db, `ip:${ctx.ip}:tap`, new Date(ctx.now).toISOString().slice(0, 13), TAPS_PER_IP_PER_HOUR)))
    return page(ctx, 'Slow down', note('One-tap link', 'Too many taps', 'Too many taps from this address. Nothing was posted. Try again next hour.'), 429, { 'retry-after': '3600' });
  const t = await loadTap(ctx, token);
  if (!t) return unknown(ctx);
  // The claim: only one request can move used_at off NULL, and only before the link expires.
  const claimed = await ctx.db.prepare('UPDATE tap_links SET used_at = ?1, outcome = ?2 WHERE token_hash = ?3 AND used_at IS NULL AND expires_at > ?1 RETURNING muse_id')
    .bind(ctx.now, what === 'post' ? 'posting' : 'cancelled', t.token_hash).first();
  if (!claimed) {
    const now = await loadTap(ctx, token);
    return now?.used_at ? doneNote(ctx, now) : expired(ctx);
  }
  if (what === 'cancel') return page(ctx, 'Not posted', note('One-tap link', 'Not posted', 'Nothing went out. The link is closed.'));
  const muse = await getMuseById(ctx.db, t.muse_id, ctx.now);
  const fail = async (title: string, text: string, status: number, reopen = false) => {
    // A rate limit is temporary: the link opens again so the human can tap later. Anything else closes it.
    await ctx.db.prepare(reopen ? 'UPDATE tap_links SET used_at = NULL, outcome = NULL WHERE token_hash = ?' : "UPDATE tap_links SET outcome = 'failed' WHERE token_hash = ?").bind(t.token_hash).run();
    return page(ctx, title, note('One-tap link', title, text), status);
  };
  if (!muse) return fail('Not posted', 'This Muse no longer exists. Nothing was posted.', 404);
  const actor: Actor = { ...muse, via: { door: 'link', label: LINK_LABEL, channel: 'link' }, scopes: null };
  const p = JSON.parse(t.payload) as Payload;
  let resultId: number;
  try {
    if (p.kind === 'create') {
      resultId = (await postCreate(ctx, actor, p.raise)).id;
    } else {
      await limitWrite(ctx, actor.id, 'join');
      const r = await joinRaise(ctx.db, actor.id, p.id, p.note, ctx.now, actor.via);
      if (!r.ok) return fail('Not posted', r.error === 'granted' ? 'That RAISE was granted in the meantime, so it takes no more joins. Nothing was posted.' : 'That RAISE is gone. Nothing was posted.', 409);
      resultId = p.id;
    }
  } catch (e) {
    if (e instanceof ActionError && e.status === 429) return fail('Not posted yet', `${esc(e.message)} Nothing was posted; this link still works later.`, 429, true);
    throw e;
  }
  await ctx.db.prepare("UPDATE tap_links SET outcome = 'posted', result_id = ? WHERE token_hash = ?").bind(resultId, t.token_hash).run();
  const url = `${ctx.base}/r/${pad(resultId)}`;
  return page(ctx, 'Posted', note('One-tap link', p.kind === 'join' ? 'Joined' : 'Posted', `${esc(muse.name)} ${p.kind === 'join' ? 'joined' : 'posted'} it. See it here: <a href="${esc(url)}"><b>${esc(url)}</b></a>.`));
}
