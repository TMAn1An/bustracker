// Open portal + contributors: time windows, bus trips, points, weekly champions, treats and route reputation.
// Everything is computed from a few small tables (contrib, trips, champions, treats, vouches); nothing runs on a timer:
// last week's champions are crowned lazily by the first request of the new week.
import { db, getSetting, setSetting } from './_lib.js';
import { prepRoute, project } from './_geo.js';

/* ---------- Bangladesh time (UTC+6, no daylight saving) ---------- */
export function bdNow(ms = Date.now()) {
  const d = new Date(ms + 6 * 3600e3);
  return { day: d.toISOString().slice(0, 10), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
export const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** The university week starts on Saturday. */
export const weekStart = day => addDays(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 1) % 7));
export const ROAST_DOW = 0; // Sunday: overdue treats are announced to the whole route for 24 hours

/* ---------- sharing windows ---------- */
// Morning: from 06:00 until the bus reaches campus (hard stop at 12:00).
// Evening: from 17:00 until the bus reaches the end of its route (hard stop at 22:00). Admin can change both.
export const DEFAULT_WIN = { am: '06:00-12:00', pm: '17:00-22:00' };
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const parseWin = v => { const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(v || ''); return m ? [toMin(m[1]), toMin(m[2])] : null; };
let _win = { at: 0, v: null };
export async function windows() {
  if (Date.now() - _win.at < 30e3 && _win.v) return _win.v;
  const [am, pm] = await Promise.all([getSetting('win_am', DEFAULT_WIN.am), getSetting('win_pm', DEFAULT_WIN.pm)]);
  _win = { at: Date.now(), v: { am: parseWin(am) || parseWin(DEFAULT_WIN.am), pm: parseWin(pm) || parseWin(DEFAULT_WIN.pm), text: { am, pm } } };
  return _win.v;
}
export const resetWindowsCache = () => { _win.at = 0; };
export const legAt = (win, min) => (min >= win.am[0] && min < win.am[1] ? 'am' : min >= win.pm[0] && min < win.pm[1] ? 'pm' : null);
const t12 = m => `${(Math.floor(m / 60) % 12) || 12}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`;
export const windowText = win => `Sharing opens ${t12(win.am[0])} until the bus reaches campus, and ${t12(win.pm[0])} until it reaches the end of its route.`;

/* ---------- routes (projected geometry, cached per isolate) ---------- */
const routeCache = new Map();
export async function routeFor(busId) {
  const r = await db().execute({ sql: 'SELECT r.id, r.geometry FROM buses b JOIN routes r ON r.id = b.route_id WHERE b.id = ?', args: [busId] });
  const row = r.rows[0]; if (!row) return null;
  let c = routeCache.get(row.id);
  if (!c || c.raw !== row.geometry) { c = { id: row.id, raw: row.geometry, ...prepRoute(JSON.parse(row.geometry)) }; routeCache.set(row.id, c); }
  return c;
}

/* ---------- trips: waiting -> live -> arrived ---------- */
export const END_M = 150;
/**
 * Update today's trip of a bus from a position s (metres along the route; 0 = far end, length = campus).
 * am trips end at campus, pm trips end at the far end. A trip becomes live once the bus is clearly away from its
 * destination, and arrives when it then reaches it. Returns the trip row.
 */
export async function tripTick(busId, leg, day, s, length, now, firstUser) {
  const away = Math.min(1000, length * 0.3);
  const far = leg === 'am' ? s < length - away : s > away;
  const atEnd = leg === 'am' ? s >= length - END_M : s <= END_M;
  await db().execute({ sql: `INSERT INTO trips (bus_id, day, leg, state) VALUES (?,?,?,'waiting') ON CONFLICT DO NOTHING`, args: [busId, day, leg] });
  const r = await db().execute({
    sql: `UPDATE trips SET
        state = CASE WHEN state = 'waiting' AND ? THEN 'live' WHEN state = 'live' AND ? THEN 'arrived' ELSE state END,
        started_at = CASE WHEN state = 'waiting' AND ? THEN ? ELSE started_at END,
        arrived_at = CASE WHEN state = 'live' AND ? THEN ? ELSE arrived_at END,
        first_user = COALESCE(first_user, ?)
      WHERE bus_id = ? AND day = ? AND leg = ? RETURNING *`,
    args: [far ? 1 : 0, atEnd ? 1 : 0, far ? 1 : 0, now, atEnd ? 1 : 0, now, firstUser || null, busId, day, leg],
  });
  return r.rows[0];
}
export async function tripOf(busId, day, leg) {
  return (await db().execute({ sql: 'SELECT * FROM trips WHERE bus_id = ? AND day = ? AND leg = ?', args: [busId, day, leg] })).rows[0] || null;
}
/** Official bus phone: keeps the trip state (live / arrived) up to date during the sharing windows. */
export async function deviceTrip(busId, lat, lng) {
  try {
    const win = await windows(), t = bdNow(), leg = legAt(win, t.min);
    if (!leg) return;
    const route = await routeFor(busId); if (!route) return;
    const p = project(route, lat, lng);
    if (p.dist > 300) return;
    await tripTick(busId, leg, t.day, p.s, route.length, Date.now(), null);
  } catch (e) { console.error('deviceTrip', e); }
}

/* ---------- points ---------- */
// 10 XP per km shared, +5 for being the first verified sharer of a trip, +15 for sharing a trip all the way to the end.
export const PTS = '(CAST(metres / 100 AS INTEGER) + first * 5 + full * 15)';
export async function credit({ userId, routeId, busId, day, leg, metres, secs, first, full, now }) {
  const r = await db().execute({
    sql: `INSERT INTO contrib (user_id, route_id, bus_id, day, leg, metres, secs, first, full, first_at, last_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (user_id, bus_id, day, leg) DO UPDATE SET metres = metres + excluded.metres, secs = secs + excluded.secs,
        first = MAX(first, excluded.first), full = MAX(full, excluded.full), last_at = excluded.last_at
      RETURNING ${PTS} AS xp, secs`,
    args: [userId, routeId, busId, day, leg, metres, secs, first ? 1 : 0, full ? 1 : 0, now, now],
  });
  return r.rows[0];
}

/* ---------- leaderboards ---------- */
const NOT_BLOCKED = 'NOT EXISTS (SELECT 1 FROM share_blocks b WHERE b.student_id = c.user_id)';
export const pubUser = u => u && ({ id: u.id, username: u.username, emoji: u.emoji || '🚌', color: u.color || '#0b6e1c', avatarV: Number(u.avatar_v) || 0, routeId: u.route_id || null, batch: u.batch ?? null });
/** Top contributors between two days (inclusive from, exclusive to), optionally on one route. */
export async function top({ from, to = '9999-12-31', routeId = null, limit = 10 }) {
  const r = await db().execute({
    sql: `SELECT c.user_id AS id, SUM(${PTS}) AS p, SUM(metres) AS m, u.username, u.emoji, u.color, u.avatar_v, u.route_id, u.batch,
        (SELECT SUM(${PTS}) FROM contrib c2 WHERE c2.user_id = c.user_id) AS xp
      FROM contrib c JOIN users u ON u.id = c.user_id
      WHERE c.day >= ? AND c.day < ? ${routeId ? 'AND c.route_id = ?' : ''} AND ${NOT_BLOCKED}
      GROUP BY c.user_id HAVING p > 0 ORDER BY p DESC, MIN(c.first_at) LIMIT ?`,
    args: routeId ? [from, to, routeId, limit] : [from, to, limit],
  });
  return r.rows.map(x => ({ ...pubUser(x), pts: Number(x.p), km: +(Number(x.m) / 1000).toFixed(1), xp: Number(x.xp) }));
}

/* ---------- weekly champions -> treats ---------- */
export const MIN_CHAMP_PTS = 20; // at least ~2 km shared in the week
let _finalized = null;
export async function finalizeWeeks() {
  const cur = weekStart(bdNow().day), prev = addDays(cur, -7);
  if (_finalized === prev) return;
  if ((await getSetting('champ_week', '')) >= prev) { _finalized = prev; return; }
  const r = await db().execute({
    sql: `SELECT c.route_id, c.user_id, SUM(${PTS}) AS p FROM contrib c WHERE c.day >= ? AND c.day < ? AND ${NOT_BLOCKED}
      GROUP BY c.route_id, c.user_id ORDER BY c.route_id, p DESC, MIN(c.first_at)`, args: [prev, cur] });
  const now = Date.now(), seen = new Set(), stmts = [];
  for (const x of r.rows) {
    if (seen.has(x.route_id) || Number(x.p) < MIN_CHAMP_PTS) continue;
    seen.add(x.route_id);
    stmts.push({ sql: 'INSERT INTO champions (week, route_id, user_id, pts) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', args: [prev, x.route_id, x.user_id, Number(x.p)] });
    stmts.push({ sql: `INSERT INTO treats (route_id, week, champion_id, status, created_at) VALUES (?,?,?,'pending',?) ON CONFLICT DO NOTHING`, args: [x.route_id, prev, x.user_id, now] });
  }
  if (stmts.length) await db().batch(stmts, 'write');
  await setSetting('champ_week', prev);
  _finalized = prev;
}

/* ---------- route reputation (are the seniors paying for the champion's tea?) ---------- */
export const OVERDUE_MS = 7 * 24 * 3600e3;
export const ACTIVE_MS = 14 * 24 * 3600e3;
/** Votes needed to settle a treat without the champion: a majority of the route's active riders, at least 3. */
export const neededVotes = active => Math.max(3, Math.ceil(active / 2));
export async function reputation() {
  const now = Date.now(), since = addDays(weekStart(bdNow().day), -8 * 7);
  const [treats, active] = await db().batch([
    { sql: `SELECT t.id, t.route_id, t.week, t.champion_id, t.status, t.created_at, t.giver_id, u.username, u.emoji, u.color, u.avatar_v, u.batch,
        g.username AS giver, (SELECT COUNT(*) FROM vouches v WHERE v.treat_id = t.id) AS votes
      FROM treats t JOIN users u ON u.id = t.champion_id LEFT JOIN users g ON g.id = t.giver_id WHERE t.week >= ? ORDER BY t.week`, args: [since] },
    { sql: 'SELECT route_id, COUNT(*) AS n FROM users WHERE route_id IS NOT NULL AND seen_at > ? GROUP BY route_id', args: [now - ACTIVE_MS] },
  ], 'read');
  const act = Object.fromEntries(active.rows.map(x => [x.route_id, Number(x.n)]));
  const out = {};
  for (const t of treats.rows) {
    const R = (out[t.route_id] ||= { good: 0, bad: 0, owed: [], given: [], active: act[t.route_id] || 0 });
    const overdue = t.status === 'pending' && now - t.created_at > OVERDUE_MS;
    if (t.status === 'paid' || t.status === 'vouched') { R.good++; R.given.push({ week: t.week, champion: t.username, giver: t.giver || null, how: t.status }); }
    if (overdue) R.bad++;
    if (t.status === 'pending') {
      let g = R.owed.find(o => o.champion.id === t.champion_id);
      if (!g) R.owed.push(g = { champion: pubUser({ id: t.champion_id, username: t.username, emoji: t.emoji, color: t.color, avatar_v: t.avatar_v, batch: t.batch }), cups: 0, overdue: 0, since: t.created_at, treatIds: [], votes: Infinity });
      g.cups++; g.treatIds.push(Number(t.id)); if (overdue) g.overdue++; g.votes = Math.min(g.votes, Number(t.votes));
    }
  }
  const dow = bdNow().dow;
  for (const [id, R] of Object.entries(out)) {
    R.rating = R.good + R.bad ? +(1 + 4 * R.good / (R.good + R.bad)).toFixed(1) : 5;
    R.needed = neededVotes(R.active);
    R.owed.forEach(o => { if (o.votes === Infinity) o.votes = 0; });
    R.stingy = R.owed.some(o => o.overdue > 0);
    R.roast = R.stingy && dow === ROAST_DOW;
    R.given = R.given.slice(-5).reverse();
    out[id] = R;
  }
  return out;
}

/* ---------- profiles, levels inputs, badges, heatmap ---------- */
const HEAT_WEEKS = 16;
export async function profile(userId) {
  const today = bdNow().day, heatFrom = addDays(weekStart(today), -(HEAT_WEEKS - 1) * 7), wk = weekStart(today);
  const [u, tot, heat, days, champs, given, avatar, owed] = await db().batch([
    { sql: 'SELECT * FROM users WHERE id = ?', args: [userId] },
    { sql: `SELECT COALESCE(SUM(${PTS}),0) AS xp, COALESCE(SUM(metres),0) AS m, COUNT(*) AS trips, COALESCE(SUM(full),0) AS fulls, COALESCE(SUM(first),0) AS firsts,
        COUNT(DISTINCT route_id) AS routes, COALESCE(SUM(leg = 'pm'),0) AS pms,
        COALESCE(SUM(leg = 'am' AND ((first_at / 60000 + 360) % 1440) < 405),0) AS early,
        COALESCE(SUM(CASE WHEN day >= ? THEN ${PTS} ELSE 0 END),0) AS week, COALESCE(SUM(CASE WHEN day = ? THEN ${PTS} ELSE 0 END),0) AS today
      FROM contrib WHERE user_id = ?`, args: [wk, today, userId] },
    { sql: `SELECT day, SUM(${PTS}) AS p FROM contrib WHERE user_id = ? AND day >= ? GROUP BY day`, args: [userId, heatFrom] },
    { sql: `SELECT DISTINCT day FROM contrib WHERE day >= ? ORDER BY day DESC`, args: [addDays(today, -90)] },
    { sql: 'SELECT week, route_id, pts FROM champions WHERE user_id = ? ORDER BY week DESC', args: [userId] },
    { sql: `SELECT COUNT(*) AS n FROM treats WHERE giver_id = ?`, args: [userId] },
    { sql: 'SELECT hidden FROM avatars WHERE user_id = ?', args: [userId] },
    { sql: `SELECT route_id, COUNT(*) AS cups, MIN(created_at) AS since FROM treats WHERE champion_id = ? AND status = 'pending' GROUP BY route_id`, args: [userId] },
  ], 'read');
  const user = u.rows[0]; if (!user) return null;
  const T = tot.rows[0], n = k => Number(T[k]) || 0;
  // Streak: consecutive "bus days" (days on which anyone shared) that this user also shared. Holidays never break it.
  const mine = new Set(heat.rows.map(x => x.day));
  const all = days.rows.map(x => x.day);
  let streak = 0, best = 0, run = 0, counting = true;
  all.forEach((d, i) => {
    if (mine.has(d)) { run++; if (counting) streak++; }
    else { if (!(i === 0 && d === today)) counting = false; best = Math.max(best, run); run = 0; }
  });
  best = Math.max(best, run, streak);
  const badges = [];
  const add = (id, ok) => ok && badges.push(id);
  add('contributor', n('trips') > 0); add('early_bird', n('early') > 0); add('trailblazer', n('firsts') > 0); add('full_ride', n('fulls') > 0);
  add('night_owl', n('pms') > 0); add('streak3', best >= 3); add('streak7', best >= 7); add('km10', n('m') >= 10e3); add('km100', n('m') >= 100e3);
  add('explorer', n('routes') >= 2); add('champion', champs.rows.length > 0); add('generous', Number(given.rows[0].n) > 0);
  return {
    user, avatarHidden: !!(avatar.rows[0] && avatar.rows[0].hidden),
    pub: {
      ...pubUser(user), xp: n('xp'), km: +(n('m') / 1000).toFixed(1), trips: n('trips'), week: n('week'), today: n('today'), streak, bestStreak: best,
      badges, heat: Object.fromEntries(heat.rows.map(x => [x.day, Number(x.p)])), heatFrom,
      champion: champs.rows.map(x => ({ week: x.week, routeId: x.route_id, pts: Number(x.pts) })), treatsGiven: Number(given.rows[0].n), joined: user.created_at,
    },
    owed: owed.rows.map(x => ({ routeId: x.route_id, cups: Number(x.cups), since: x.since })),
  };
}

/* ---------- usernames ---------- */
// Like a variable name: starts with a letter or _, then letters, digits or _; 3-20 characters; must contain a letter.
export const USERNAME = /^[A-Za-z_][A-Za-z0-9_]{2,19}$/;
const RESERVED = /^(admin|administrator|iubat|transport|moderator|mod|support|system|null|undefined|root|official|driver)$/i;
const RUDE = /(fuck|shit|bitch|porn|pussy|dick|asshole|nigg|rape|khanki|madarchod|chod|chud|bokachoda|haramjada|magir|banchod)/i;
export function checkUsername(v) {
  v = String(v || '').trim();
  if (!USERNAME.test(v)) return { error: 'Username: 3–20 characters, start with a letter or _, then letters, numbers or _ (no spaces).' };
  if (!/[A-Za-z]/.test(v)) return { error: 'Username must contain at least one letter.' };
  if (RESERVED.test(v)) return { error: 'That username is reserved. Pick another.' };
  if (RUDE.test(v)) return { error: 'Please pick a friendlier username.' };
  return { value: v };
}
export const EMOJIS = ['🚌', '🐯', '🦊', '🐼', '🐸', '🦉', '🐧', '🐨', '🦁', '🐵', '🐱', '🐶', '🦄', '🐲', '🐻', '🐰', '🐙', '🦖', '🐝', '🦜'];
export const COLORS = ['#0b6e1c', '#1d6fe0', '#8a3ffc', '#d92d20', '#f08a00', '#00a3a3', '#c2188a', '#5b6b00'];
