// Contributor accounts without passwords.
// Joining creates a random secret "device key" that only this phone keeps (localStorage); the server stores only its SHA-256.
// The app signs in with a long-lived session token; the device key doubles as the recovery code for a new phone.
//   POST {action:'join', username, emoji, color, routeId, batch, turnstile}   -> { token, key, me }
//   POST {action:'restore', key}                                             -> { token, key, me }
//   GET  (Bearer token)                                                      -> { me, token? (refreshed) }
//   POST (Bearer token) {action: update | photo | removePhoto | newKey | claimTreat | vouch | report | delete}
import { randomBytes } from 'node:crypto';
import { db, ensureSchema, userFrom, signSession, sha256, num, CAMPUS, getSetting } from './_lib.js';
import { routeTimes, estimatePoint } from './_eta.js';
import { metres } from './_geo.js';
import { hit, ipOf, checkLock, recordFail, clearFails } from './_ratelimit.js';
import { profile, checkUsername, EMOJIS, COLORS, finalizeWeeks, ACTIVE_MS, neededVotes } from './_social.js';

const SESSION_H = 60 * 24;               // 60 days; refreshed whenever the app opens with less than 30 days left
const RENAME_MS = 90 * 24 * 3600e3;      // a username can change once every 90 days (names are first come, first served; treats are confirmed by name)
const PHOTO_MAX = 24 * 1024;              // bytes after decoding (the app sends a 128x128 WebP/JPEG, usually 5-10 KB)
// One report is enough: the photo goes to the admin's review queue (admin dashboard -> Community) and the admin decides.

const newKey = () => randomBytes(24).toString('base64url');
const fail = (res, code, error) => res.status(code).json({ error });

async function turnstileOk(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true; // optional: only when the site owner configured Cloudflare Turnstile
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: String(token || ''), remoteip: ip }), signal: AbortSignal.timeout(8000),
    });
    return !!(await r.json()).success;
  } catch { return false; }
}

async function routeOk(id) {
  if (!id) return null;
  const r = await db().execute({ sql: 'SELECT id FROM routes WHERE id = ?', args: [String(id)] });
  return r.rows[0] ? r.rows[0].id : null;
}
// Batch: the university's batch number, e.g. 232 (lower = more senior). The admin can set an allowed range (Community tab); empty = no limit.
const batchOk = async v => {
  v = String(v ?? '').trim(); if (!v) return null;
  if (!/^\d{1,6}$/.test(v)) return undefined;
  const [lo, hi] = await Promise.all([getSetting('batch_min', ''), getSetting('batch_max', '')]), n = Number(v);
  if ((lo !== '' && n < Number(lo)) || (hi !== '' && n > Number(hi))) return undefined;
  return n;
};
const BATCH_ERR = async () => { const [lo, hi] = await Promise.all([getSetting('batch_min', ''), getSetting('batch_max', '')]);
  return `Batch: enter your batch number, e.g. 232${lo !== '' || hi !== '' ? ` (allowed: ${lo || '…'} to ${hi || '…'})` : ''}.`; };

/** Private view of the signed-in user: public profile + what only they should see. */
async function mine(id) {
  await finalizeWeeks();
  const p = await profile(id); if (!p) return null;
  const blocked = (await db().execute({ sql: 'SELECT 1 FROM share_blocks WHERE student_id = ?', args: [id] })).rows[0];
  const sug = (await db().execute({ sql: `SELECT id, route_id, name, status, est_am, est_pm, km_to_campus, admin_note, created_at FROM stop_suggestions
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`, args: [id] })).rows;
  return { ...p.pub, noPhoto: !!p.user.no_photo, photoHidden: p.avatarHidden, shareBlocked: !!blocked,
    suggestions: sug.map(x => ({ id: x.id, routeId: x.route_id, name: x.name, status: x.status, am: x.est_am, pm: x.est_pm, km: x.km_to_campus, note: x.admin_note, at: x.created_at })),
    renameAfter: p.user.renamed_at ? p.user.renamed_at + RENAME_MS : 0, owed: p.owed };
}

export default async function handler(req, res) {
  await ensureSchema();
  res.setHeader('Cache-Control', 'no-store');
  const body = req.body || {}, ip = ipOf(req), now = Date.now();

  /* ----- username availability (first come, first served) ----- */
  if (req.method === 'GET' && (req.query || {}).check != null) {
    if (!(await hit('check:' + ip, 200, 3600e3))) return fail(res, 429, 'Slow down a little.');
    const u = checkUsername(req.query.check); if (u.error) return res.status(200).json({ available: false, error: u.error });
    const taken = (await db().execute({ sql: 'SELECT id FROM users WHERE username = ? COLLATE NOCASE', args: [u.value] })).rows[0];
    const self = userFrom(req);
    return res.status(200).json({ available: !taken || (self && taken.id === self.id) });
  }
  /* ----- not signed in yet ----- */
  if (req.method === 'POST' && body.action === 'join') {
    if (!(await hit('join:' + ip, 30, 3600e3))) return fail(res, 429, 'Too many new accounts from this network. Try again later.');
    if (!(await turnstileOk(body.turnstile, ip))) return fail(res, 400, 'Please complete the "I am human" check.');
    const u = checkUsername(body.username); if (u.error) return fail(res, 400, u.error);
    const batch = await batchOk(body.batch); if (batch === undefined) return fail(res, 400, await BATCH_ERR());
    const id = 'u' + randomBytes(6).toString('hex'), key = newKey();
    try {
      await db().execute({ sql: `INSERT INTO users (id, username, key_hash, emoji, color, route_id, batch, created_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [id, u.value, sha256(key), EMOJIS.includes(body.emoji) ? body.emoji : '🚌', COLORS.includes(body.color) ? body.color : COLORS[0],
          await routeOk(body.routeId), batch, now, now] });
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return fail(res, 409, `"${u.value}" is taken. Try another username.`);
      throw e;
    }
    return res.status(200).json({ token: signSession('u:' + id, SESSION_H), key, me: await mine(id) });
  }
  if (req.method === 'POST' && body.action === 'restore') {
    const lock = await checkLock(['ip:' + ip]);
    if (lock.blocked) return fail(res, 429, 'Too many wrong codes. Try again later.');
    const r = await db().execute({ sql: 'SELECT id FROM users WHERE key_hash = ?', args: [sha256(String(body.key || '').trim())] });
    if (!r.rows[0]) { await recordFail('restore:' + ip, 'ip:' + ip); return fail(res, 401, 'That recovery code does not match any account.'); }
    await clearFails('restore:' + ip);
    const id = r.rows[0].id;
    return res.status(200).json({ token: signSession('u:' + id, SESSION_H), key: String(body.key).trim(), me: await mine(id) });
  }

  /* ----- signed in ----- */
  const s = userFrom(req);
  if (!s) return fail(res, 401, 'Not signed in.');
  const id = s.id;
  const user = (await db().execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] })).rows[0];
  if (!user) return fail(res, 401, 'Account not found.');

  if (req.method === 'GET') {
    if (now - user.seen_at > 3600e3) await db().execute({ sql: 'UPDATE users SET seen_at = ? WHERE id = ?', args: [now, id] });
    const fresh = s.exp - now < 30 * 24 * 3600e3 ? signSession('u:' + id, SESSION_H) : undefined;
    return res.status(200).json({ me: await mine(id), token: fresh });
  }
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  switch (body.action) {
    case 'update': {
      const sets = [], args = [];
      if (body.username != null && body.username !== user.username) {
        const u = checkUsername(body.username); if (u.error) return fail(res, 400, u.error);
        if (u.value.toLowerCase() !== user.username.toLowerCase() && user.renamed_at && now - user.renamed_at < RENAME_MS)
          return fail(res, 400, `You can change your username again on ${new Date(user.renamed_at + RENAME_MS).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`);
        sets.push('username = ?', 'renamed_at = ?'); args.push(u.value, now);
      }
      if (body.emoji != null) { sets.push('emoji = ?'); args.push(EMOJIS.includes(body.emoji) ? body.emoji : '🚌'); }
      if (body.color != null) { sets.push('color = ?'); args.push(COLORS.includes(body.color) ? body.color : COLORS[0]); }
      if (body.routeId !== undefined) { sets.push('route_id = ?'); args.push(await routeOk(body.routeId)); }
      if (body.batch !== undefined) { const b = await batchOk(body.batch); if (b === undefined) return fail(res, 400, await BATCH_ERR()); sets.push('batch = ?'); args.push(b); }
      if (sets.length) {
        try { await db().execute({ sql: `UPDATE users SET ${sets.join(', ')}, seen_at = ? WHERE id = ?`, args: [...args, now, id] }); }
        catch (e) { if (/UNIQUE/i.test(e.message)) return fail(res, 409, 'That username is taken. Try another.'); throw e; }
      }
      break;
    }
    case 'photo': {
      if (user.no_photo) return fail(res, 403, 'Photo uploads are turned off for your account.');
      if (!(await hit('photo:' + id, 10, 24 * 3600e3))) return fail(res, 429, 'Too many photo changes today. Try tomorrow.');
      const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
      if (!m) return fail(res, 400, 'Unsupported image.');
      const bytes = Buffer.from(m[2], 'base64');
      const magic = { 'image/webp': b => b.slice(8, 12).toString() === 'WEBP', 'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8, 'image/png': b => b[0] === 0x89 && b[1] === 0x50 };
      if (bytes.length > PHOTO_MAX || !magic[m[1]](bytes)) return fail(res, 400, 'The photo is too large or not a real image.');
      await db().batch([
        { sql: 'INSERT INTO avatars (user_id, mime, data, at, hidden) VALUES (?,?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET mime=excluded.mime, data=excluded.data, at=excluded.at, hidden=0', args: [id, m[1], m[2], now] },
        { sql: 'DELETE FROM reports WHERE target = ?', args: [id] },
        { sql: 'UPDATE users SET avatar_v = ? WHERE id = ?', args: [now, id] },
      ], 'write');
      break;
    }
    case 'removePhoto':
      await db().batch([{ sql: 'DELETE FROM avatars WHERE user_id = ?', args: [id] }, { sql: 'UPDATE users SET avatar_v = 0 WHERE id = ?', args: [id] }], 'write');
      break;
    case 'newKey': { // new recovery code; the old one stops working (this phone stays signed in)
      const key = newKey();
      await db().execute({ sql: 'UPDATE users SET key_hash = ? WHERE id = ?', args: [sha256(key), id] });
      return res.status(200).json({ key, me: await mine(id) });
    }
    case 'claimTreat': { // the champion confirms the treat and names the senior who paid
      const routeId = String(body.routeId || '');
      const giver = (await db().execute({ sql: 'SELECT id, username FROM users WHERE username = ? COLLATE NOCASE', args: [String(body.giver || '').trim().replace(/^@/, '')] })).rows[0];
      if (!giver) return fail(res, 400, 'No rider with that username. Ask your senior for their exact username.');
      if (giver.id === id) return fail(res, 400, 'Nice try 😄 The treat has to come from someone else.');
      const r = await db().execute({ sql: `UPDATE treats SET status = 'paid', giver_id = ?, settled_at = ? WHERE champion_id = ? AND route_id = ? AND status = 'pending'`, args: [giver.id, now, id, routeId] });
      if (!r.rowsAffected) return fail(res, 400, 'No pending treat for you on this route.');
      break;
    }
    case 'vouch': { // riders of the route confirm the treat happened (when the champion forgets to)
      const ids = (Array.isArray(body.treatIds) ? body.treatIds : []).map(Number).filter(Number.isInteger).slice(0, 20);
      if (!ids.length) return fail(res, 400, 'Nothing to confirm.');
      if (now - user.created_at < 2 * 24 * 3600e3) return fail(res, 403, 'New accounts can confirm treats after 2 days.');
      const t = (await db().execute({ sql: `SELECT id, route_id, champion_id FROM treats WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'pending'`, args: ids })).rows;
      if (!t.length) return fail(res, 400, 'Already settled.');
      if (t.some(x => x.route_id !== user.route_id)) return fail(res, 403, 'Only riders of this route can confirm. Set it as your route in your profile.');
      if (t.some(x => x.champion_id === id)) return fail(res, 400, 'You are the champion: use "I got my treat" instead.');
      const active = Number((await db().execute({ sql: 'SELECT COUNT(*) AS n FROM users WHERE route_id = ? AND seen_at > ?', args: [user.route_id, now - ACTIVE_MS] })).rows[0].n);
      await db().batch([
        ...t.map(x => ({ sql: 'INSERT INTO vouches (treat_id, user_id, at) VALUES (?,?,?) ON CONFLICT DO NOTHING', args: [x.id, id, now] })),
        { sql: `UPDATE treats SET status = 'vouched', settled_at = ? WHERE id IN (${t.map(() => '?').join(',')}) AND status = 'pending'
            AND (SELECT COUNT(*) FROM vouches v WHERE v.treat_id = treats.id) >= ?`, args: [now, ...t.map(x => x.id), neededVotes(active)] },
      ], 'write');
      break;
    }
    case 'report': { // report someone's photo: it goes straight to the admin's review queue
      const target = String(body.userId || '');
      if (!target || target === id) return fail(res, 400, 'Bad request');
      if (!(await hit('report:' + id, 20, 24 * 3600e3))) return fail(res, 429, 'Too many reports today.');
      await db().execute({ sql: 'INSERT INTO reports (target, reporter, at) VALUES (?,?,?) ON CONFLICT DO NOTHING', args: [target, id, now] });
      return res.status(200).json({ ok: true });
    }
    case 'suggestStop': { // a rider suggests a missing stop; the admin approves, edits or rejects it
      const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const lat = num(body.lat, -90, 90), lng = num(body.lng, -180, 180), note = String(body.note || '').trim().slice(0, 300) || null;
      if (name.length < 2) return fail(res, 400, 'Give the stop a name, e.g. "Board Bazar footbridge".');
      if (lat === null || lng === null || metres(lat, lng, CAMPUS.lat, CAMPUS.lng) > 120e3) return fail(res, 400, 'Pick a place on the map (within reach of campus).');
      if (!(await hit('suggest:' + id, 6, 24 * 3600e3)) || !(await hit('suggest-ip:' + ip, 20, 24 * 3600e3))) return fail(res, 429, 'That is enough suggestions for today. Thank you!');
      const [rr, bb] = await db().batch([
        { sql: 'SELECT id, stops, geometry FROM routes WHERE id = ?', args: [String(body.routeId || '')] },
        { sql: 'SELECT depart_start, depart_campus FROM buses WHERE route_id = ? ORDER BY depart_start IS NULL, depart_start LIMIT 1', args: [String(body.routeId || '')] },
      ], 'read');
      const route = rr.rows[0]; if (!route) return fail(res, 400, 'Pick a route.');
      const rt = routeTimes({ stops: JSON.parse(route.stops), geometry: JSON.parse(route.geometry) }, bb.rows[0], CAMPUS);
      if (rt.stops.some(s => !s.campus && metres(s.lat, s.lng, lat, lng) < 120)) return fail(res, 400, 'There is already a stop right there.');
      const e = estimatePoint(rt, lat, lng);
      const dup = (await db().execute({ sql: `SELECT lat, lng FROM stop_suggestions WHERE route_id = ? AND status = 'pending'`, args: [route.id] })).rows;
      if (dup.some(d => metres(d.lat, d.lng, lat, lng) < 120)) return fail(res, 400, 'Someone already suggested a stop there. The transport office will review it.');
      await db().execute({ sql: `INSERT INTO stop_suggestions (route_id, name, lat, lng, note, user_id, s, off_m, km_to_campus, est_am, est_pm, between_stops, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [route.id, name, +lat.toFixed(6), +lng.toFixed(6), note, id, e.s, e.off, e.kmToCampus, e.am, e.pm, JSON.stringify(e.between), now] });
      return res.status(200).json({ ok: true, estimate: e, me: await mine(id) });
    }
    case 'linkStudent': { // reserved: link this account to a university student ID once the student database is available
      // Plan: verifyStudent(id, password) from ./_students.js -> UPDATE users SET student_id, verified_at (+ batch from the ID).
      return fail(res, 501, 'Coming soon: linking your student ID opens when the university student database is connected.');
    }
    case 'delete': // remove the account and everything linked to it
      await db().batch(['contrib', 'avatars', 'reports', 'vouches', 'share_sessions', 'share_fixes'].map(t => ({
        sql: `DELETE FROM ${t} WHERE ${t === 'reports' ? 'target' : t.startsWith('share') ? 'student_id' : 'user_id'} = ?`, args: [id],
      })).concat([{ sql: 'DELETE FROM users WHERE id = ?', args: [id] }]), 'write');
      return res.status(200).json({ ok: true, deleted: true });
    default:
      return fail(res, 400, 'Unknown action.');
  }
  res.status(200).json({ me: await mine(id) });
}
