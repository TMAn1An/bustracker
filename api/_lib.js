// শেয়ার্ড হেলপার: DB, টোকেন, পাসওয়ার্ড হ্যাশ। (আন্ডারস্কোর = Vercel এটাকে এন্ডপয়েন্ট বানায় না)
import { createClient } from '@libsql/client';
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

let _db;
export function db() {
  if (!_db) _db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return _db;
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, name TEXT, pass TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS buses (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL)`,
  // প্রতি বাসে মাত্র একটা সারি — সবসময় সর্বশেষ লোকেশন
  `CREATE TABLE IF NOT EXISTS positions (bus_id TEXT PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL,
     speed REAL, heading REAL, acc REAL, ts INTEGER NOT NULL)`,
];

/* ---------- পাসওয়ার্ড ---------- */
export function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex');
}
export function checkPassword(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const a = scryptSync(pw, Buffer.from(s, 'hex'), 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const sha256 = v => createHash('sha256').update(String(v)).digest('hex');

/* ---------- সেশন টোকেন (stateless, HMAC) ---------- */
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s && process.env.VERCEL) throw new Error('SESSION_SECRET সেট করা নেই');
  return s || 'dev-only-secret';
};
const b64 = b => Buffer.from(b).toString('base64url');
export function signSession(sub, hours = 12) {
  const body = b64(JSON.stringify({ sub, exp: Date.now() + hours * 3600e3 }));
  return body + '.' + createHmac('sha256', secret()).update(body).digest('base64url');
}
export function verifySession(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
}
export const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

/* ---------- ইনপুট ---------- */
export const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

/** বাসের টোকেন যাচাই করে লোকেশন সেভ করে। */
export async function saveFix({ token, lat, lng, speed, heading, acc, ts }) {
  lat = num(lat, -90, 90); lng = num(lng, -180, 180);
  if (lat === null || lng === null || !token) return { status: 400, error: 'bad request' };
  const r = await db().execute({ sql: 'SELECT id FROM buses WHERE token_hash = ?', args: [sha256(token)] });
  if (!r.rows[0]) return { status: 401, error: 'invalid token' };
  const now = Date.now();
  let t = Number(ts); if (!Number.isFinite(t) || Math.abs(t - now) > 5 * 60e3) t = now; // ঘড়ি ভুল হলে সার্ভারের সময়
  await db().execute({
    sql: `INSERT INTO positions (bus_id, lat, lng, speed, heading, acc, ts) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(bus_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, speed=excluded.speed,
          heading=excluded.heading, acc=excluded.acc, ts=excluded.ts WHERE excluded.ts >= positions.ts`,
    args: [r.rows[0].id, lat, lng, num(speed, 0, 80), num(heading, 0, 360), num(acc, 0, 5000), t],
  });
  return { status: 200, bus: r.rows[0].id };
}
