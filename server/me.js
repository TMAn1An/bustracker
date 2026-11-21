// Contributor accounts without passwords.
// Joining creates a random secret "device key" that only this phone keeps (localStorage); the server stores only its SHA-256.
// The app signs in with a long-lived session token; the device key doubles as the recovery code for a new phone.
//   POST {action:'join', username, emoji, color, routeId, batch, turnstile}   -> { token, key, me }
//   POST {action:'restore', key}                                             -> { token, key, me }
//   GET  (Bearer token)                                                      -> { me, token? (refreshed) }
//   POST (Bearer token) {action: update | photo | removePhoto | newKey | claimTreat | vouch | report | delete}
import { randomBytes } from 'node:crypto';
import { db, ensureSchema, userFrom, signSession, sha256, num } from './_lib.js';
import { hit, ipOf, checkLock, recordFail, clearFails } from './_ratelimit.js';
import { profile, checkUsername, EMOJIS, COLORS, finalizeWeeks, ACTIVE_MS, neededVotes } from './_social.js';

const SESSION_H = 60 * 24;               // 60 days; refreshed whenever the app opens with less than 30 days left
const RENAME_MS = 7 * 24 * 3600e3;       // a username can change once a week (people confirm treats by username)
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
const batchOk = v => { if (v === '' || v == null) return null; const y = num(v, 2000, new Date().getUTCFullYear()); return y === null ? undefined : Math.round(y); };

/** Private view of the signed-in user: public profile + what only they should see. */
async function mine(id) {
  await finalizeWeeks();
  const p = await profile(id); if (!p) return null;
  const blocked = (await db().execute({ sql: 'SELECT 1 FROM share_blocks WHERE student_id = ?', args: [id] })).rows[0];
  return { ...p.pub, noPhoto: !!p.user.no_photo, photoHidden: p.avatarHidden, shareBlocked: !!blocked,
    renameAfter: p.user.renamed_at ? p.user.renamed_at + RENAME_MS : 0, owed: p.owed };
}

export default async function handler(req, res) {
  await ensureSchema();
  res.setHeader('Cache-Control', 'no-store');
  const body = req.body || {}, ip = ipOf(req), now = Date.now();

  /* ----- not signed in yet ----- */
  if (req.method === 'POST' && body.action === 'join') {
    if (!(await hit('join:' + ip, 30, 3600e3))) return fail(res, 429, 'Too many new accounts from this network. Try again later.');
    if (!(await turnstileOk(body.turnstile, ip))) return fail(res, 400, 'Please complete the "I am human" check.');
    const u = checkUsername(body.username); if (u.error) return fail(res, 400, u.error);
    const batch = batchOk(body.batch); if (batch === undefined) return fail(res, 400, 'Batch: enter the year you were admitted, e.g. 2023.');
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
      if (body.batch !== undefined) { const b = batchOk(body.batch); if (b === undefined) return fail(res, 400, 'Batch: enter the year you were admitted, e.g. 2023.'); sets.push('batch = ?'); args.push(b); }
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
