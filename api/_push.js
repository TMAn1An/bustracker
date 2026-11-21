// Web Push without a payload (so no message encryption, which is cheap enough for Cloudflare's free plan):
// the server pings the browser's push service with a VAPID-signed request, the service worker wakes up and
// fetches its messages from /api/push (action 'inbox'), then shows them.
// A Cloudflare Cron Trigger runs tick() every minute: departure reminders, weekly champion / treat report, route battle,
// and drains the outbox (at most ~30 pushes per run: the free plan allows 50 outgoing requests per invocation).
import { db, getSetting } from './_lib.js';
import { bdNow, calendar, busRuns, finalizeWeeks, finalizeMonth, reputation, addDays, weekStart, ROAST_DOW } from './_social.js';

const subtle = globalThis.crypto.subtle;
const b64u = b => Buffer.from(b).toString('base64url');
const SUBJECT = () => process.env.VAPID_SUBJECT || 'https://bustracker.iubat.workers.dev';
export const REMIND_MIN = 20;
// Only real push services (stops anyone from making the server POST to arbitrary URLs).
export const PUSH_HOST = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com|push\.api\.chrome\.google\.com)$/;

/* ---------- VAPID keys: created once and kept in the settings table (no setup needed) ---------- */
let _keys = null;
export async function vapid() {
  if (_keys) return _keys;
  let v = null; try { v = JSON.parse(await getSetting('vapid', 'null')); } catch {}
  if (!v) {
    const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const fresh = { pub: b64u(await subtle.exportKey('raw', kp.publicKey)), jwk: await subtle.exportKey('jwk', kp.privateKey) };
    // two instances could race on the very first use: the first key saved wins
    await db().execute({ sql: `INSERT INTO settings (key, value) VALUES ('vapid', ?) ON CONFLICT DO NOTHING`, args: [JSON.stringify(fresh)] });
    v = JSON.parse(await getSetting('vapid'));
  }
  const key = await subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return (_keys = { pub: v.pub, key });
}
const jwts = new Map(); // one signed token per push service, reused for hours
async function jwt(aud) {
  const c = jwts.get(aud), nowS = Math.floor(Date.now() / 1000);
  if (c && c.exp - nowS > 3600) return c.t;
  const { key } = await vapid(), exp = nowS + 12 * 3600;
  const data = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64u(JSON.stringify({ aud, exp, sub: SUBJECT() }));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(data)); // raw r||s, as JWT wants
  const t = data + '.' + b64u(sig); jwts.set(aud, { t, exp }); return t;
}
/** Ping one subscription. Returns the HTTP status (0 = network error). */
export async function ping(endpoint, ttl = 3600) {
  try {
    const { pub } = await vapid();
    const r = await fetch(endpoint, { method: 'POST', body: '', signal: AbortSignal.timeout(8000),
      headers: { TTL: String(ttl), Urgency: 'high', Authorization: `vapid t=${await jwt(new URL(endpoint).origin)}, k=${pub}` } });
    return r.status;
  } catch { return 0; }
}

/* ---------- outbox ---------- */
/** Queue a message for every subscription matching `where` (SQL on push_subs s). One query, however many subscribers. */
export async function enqueue({ where, args = [], title, body, url = '/', tag = null, ttl = 3600 }) {
  const r = await db().execute({
    sql: `INSERT INTO push_msgs (sub_id, title, body, url, tag, ttl, created_at) SELECT s.id, ?, ?, ?, ?, ?, ? FROM push_subs s WHERE ${where}`,
    args: [title.slice(0, 120), body.slice(0, 300), url, tag, ttl, Date.now(), ...args],
  });
  return r.rowsAffected;
}
/** Send pending messages: one ping per subscription (the service worker collects all its messages at once). */
export async function drain(limit = 30) {
  const now = Date.now();
  const r = await db().execute({
    sql: `SELECT m.sub_id, MIN(m.ttl) AS ttl, s.endpoint FROM push_msgs m JOIN push_subs s ON s.id = m.sub_id
      WHERE m.sent_at IS NULL AND m.created_at > ? - m.ttl * 1000 GROUP BY m.sub_id LIMIT ?`, args: [now, limit] });
  if (!r.rows.length) return 0;
  const res = await Promise.all(r.rows.map(async x => [Number(x.sub_id), await ping(x.endpoint, Number(x.ttl))]));
  const gone = res.filter(([, st]) => st === 404 || st === 410).map(([id]) => id);
  const done = res.filter(([, st]) => st !== 404 && st !== 410 && st !== 0 && st !== 429 && st < 500).map(([id]) => id);
  const ph = a => a.map(() => '?').join(',');
  const stmts = [];
  if (done.length) stmts.push({ sql: `UPDATE push_msgs SET sent_at = ? WHERE sent_at IS NULL AND sub_id IN (${ph(done)})`, args: [now, ...done] });
  if (gone.length) stmts.push({ sql: `DELETE FROM push_msgs WHERE sub_id IN (${ph(gone)})`, args: gone }, { sql: `DELETE FROM push_subs WHERE id IN (${ph(gone)})`, args: gone });
  if (stmts.length) await db().batch(stmts, 'write');
  return res.length;
}
/** Run once per key (e.g. one champion announcement per week), even with several instances. */
async function once(key) {
  const r = await db().execute({ sql: `INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT DO NOTHING`, args: ['push:' + key] });
  return r.rowsAffected > 0;
}

/* ---------- the every-minute job ---------- */
const hm = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };
const t12 = m => `${(Math.floor(m / 60) % 12) || 12}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`;
const between = (m, at) => m >= at - REMIND_MIN && m < at - REMIND_MIN + 6; // a 6-minute window, so a late cron run still catches it

export async function tick() {
  const t = bdNow(), m = t.min;
  try {
    await reminders(t);
    // Saturday 9 AM: last week's champions are crowned
    if (t.dow === 6 && m >= 540 && m < 560 && await once('champ:' + t.day)) await announceChampions(t);
    // Sunday 9 AM: weekly treat report for routes whose seniors still owe tea
    if (t.dow === ROAST_DOW && m >= 540 && m < 560 && await once('roast:' + t.day)) await roast();
    // 1st of the month, 10 AM: route battle winner
    if (t.day.endsWith('-01') && m >= 600 && m < 620 && await once('battle:' + t.day)) await announceBattle();
    // 3 AM: clean up old messages
    if (m >= 180 && m < 182 && await once('clean:' + t.day)) await db().execute({ sql: 'DELETE FROM push_msgs WHERE created_at < ?', args: [Date.now() - 3 * 864e5] });
  } catch (e) { console.error('push tick', e); }
  await drain(30);
}

/** Departure reminders, 20 minutes before (at the rider's own stop when its pick-up time is known). */
async function reminders(t) {
  const m = t.min;
  const [buses, routes] = await db().batch([
    'SELECT id, route_id, depart_start, depart_campus, days FROM buses WHERE route_id IS NOT NULL',
    'SELECT id, name, stops FROM routes',
  ], 'read');
  const cal = await calendar();
  const run = buses.rows.filter(b => busRuns(cal, t.day, b.days));
  if (!run.length) return;
  // Cheap check first: is any departure or stop time about 20 minutes away?
  const R = Object.fromEntries(routes.rows.map(r => [r.id, { name: r.name, stops: JSON.parse(r.stops) }]));
  const times = new Set();
  for (const b of run) {
    [hm(b.depart_start), hm(b.depart_campus)].forEach(x => x != null && times.add(x));
    (R[b.route_id]?.stops || []).forEach(s => hm(s.time) != null && times.add(hm(s.time)));
  }
  if (![...times].some(x => between(m, x))) return;

  const subs = (await db().execute({ sql: `SELECT id, route_id, stop, sent_am, sent_pm FROM push_subs WHERE remind = 1 AND route_id IS NOT NULL
      AND (sent_am IS NOT ? OR sent_pm IS NOT ?)`, args: [t.day, t.day] })).rows;
  const stmts = [], now = Date.now();
  for (const s of subs) {
    const mine = run.filter(b => b.route_id === s.route_id), route = R[s.route_id];
    if (!mine.length || !route) continue;
    const first = route.stops[0]?.name || route.name, stop = s.stop && route.stops.find(x => x.name === s.stop && hm(x.time) != null);
    const pick = legTimes => mine.map(b => ({ b, at: legTimes(b) })).filter(x => x.at != null).sort((a, b) => a.at - b.at)[0];
    const am = pick(b => (stop ? hm(stop.time) : hm(b.depart_start))), pm = pick(b => hm(b.depart_campus));
    for (const [leg, x, where, sent] of [['am', am, stop ? stop.name : first, s.sent_am], ['pm', pm, 'campus', s.sent_pm]]) {
      if (!x || sent === t.day || !between(m, x.at)) continue;
      const left = x.at - m;
      stmts.push({ sql: `INSERT INTO push_msgs (sub_id, title, body, url, tag, ttl, created_at) VALUES (?,?,?,?,?,?,?)`,
        args: [s.id, `⏰ Bus ${x.b.id} leaves in ${left} min`, `Leaves ${where} at ${t12(x.at)} (${route.name}). Tap to see where it is now.`,
          `/#route=${s.route_id}`, `dep-${s.route_id}-${leg}`, 1200, now] });
      stmts.push({ sql: `UPDATE push_subs SET sent_${leg} = ? WHERE id = ?`, args: [t.day, s.id] });
    }
  }
  for (let i = 0; i < stmts.length; i += 200) await db().batch(stmts.slice(i, i + 200), 'write');
}

async function announceChampions(t) {
  await finalizeWeeks();
  const week = addDays(weekStart(t.day), -7);
  const c = (await db().execute({ sql: `SELECT c.route_id, c.user_id, c.pts, u.username, r.name FROM champions c JOIN users u ON u.id = c.user_id
      JOIN routes r ON r.id = c.route_id WHERE c.week = ?`, args: [week] })).rows;
  for (const x of c) {
    await enqueue({ where: 's.treat = 1 AND s.route_id = ? AND (s.user_id IS NULL OR s.user_id <> ?)', args: [x.route_id, x.user_id], tag: 'champ',
      title: `👑 @${x.username} is ${x.name}'s champion!`, body: `${x.pts} XP last week. Seniors of the route: a ☕ treat is now due. Who's paying?`, url: `/#route=${x.route_id}` });
    await enqueue({ where: 's.user_id = ?', args: [x.user_id], tag: 'champ', title: '👑 You are the champion of the week!',
      body: `Top contributor on ${x.name} with ${x.pts} XP. A tea/coffee invitation from the seniors is waiting for you.`, url: '/#me' });
  }
}
async function roast() {
  const rep = await reputation();
  const names = Object.fromEntries((await db().execute('SELECT id, name FROM routes')).rows.map(r => [r.id, r.name]));
  for (const [routeId, R] of Object.entries(rep)) {
    const o = R.owed.find(x => x.overdue);
    if (!o) continue;
    await enqueue({ where: 's.treat = 1 AND s.route_id = ?', args: [routeId], tag: 'roast', ttl: 6 * 3600,
      title: `📣 Weekly treat report: ${names[routeId] || 'your route'} 🥲`,
      body: `@${o.champion.username} still waits for ☕×${o.cups}. Generosity ${R.rating.toFixed(1)}/5. Seniors, it's cha time!`, url: `/#route=${routeId}` });
  }
}
async function announceBattle() {
  await finalizeMonth();
  const d = new Date(bdNow().day.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1);
  const w = (await db().execute({ sql: 'SELECT w.month, w.pct, r.name, r.id FROM route_wins w JOIN routes r ON r.id = w.route_id WHERE w.month = ?', args: [d.toISOString().slice(0, 7)] })).rows[0];
  if (!w) return;
  const month = d.toLocaleString('en', { month: 'long', timeZone: 'UTC' });
  await enqueue({ where: 's.treat = 1', tag: 'battle', ttl: 6 * 3600, title: `⚔️ ${w.name} won the ${month} route battle!`,
    body: `${Math.round(w.pct)}% of its bus trips had a live rider. Can your route beat that this month?`, url: '/#board' });
}
