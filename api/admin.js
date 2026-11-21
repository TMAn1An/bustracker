import { db, adminFrom, buildGeometry, bumpRev, getRev, sha256, num, CAMPUS, ensureSchema, getSetting, setSetting } from './_lib.js';
import { randomBytes } from 'node:crypto';
import { windows, parseWin, resetWindowsCache, PTS, calendar, resetCalendarCache, boost, resetBoostCache, bdNow } from './_social.js';
import { enqueue, drain } from './_push.js';

const BUS_ID = /^[A-Za-z0-9-]{1,10}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = (v, label) => { v = String(v || '').trim(); if (v && !TIME.test(v)) throw new Error(`${label}: use a time like 06:30.`); return v || null; };
const newToken = () => randomBytes(18).toString('base64url');

function cleanStops(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 80) throw new Error('A route needs at least one stop (the starting point).');
  return list.map((s, i) => {
    const lat = num(s.lat, -90, 90), lng = num(s.lng, -180, 180), name = String(s.name || '').trim().slice(0, 60);
    if (!name) throw new Error(`Stop ${i + 1} needs a name.`);
    if (lat === null || lng === null) throw new Error(`Stop ${i + 1} "${name}" has no location yet. Use Place and click the map.`);
    const stop = { name, lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
    if (s.time) stop.time = time(s.time, `Stop ${i + 1} pick-up time`);   // optional "HH:MM" pick-up time
    if (s.approx) stop.approx = true;   // position found automatically; admin has not confirmed it yet
    return stop;
  });
}

async function state(community = false) {
  const [routes, buses, pos] = await Promise.all([
    db().execute('SELECT id, name, color, stops, geometry, updated_at FROM routes ORDER BY name'),
    db().execute('SELECT id, route_id, depart_start, depart_campus, days FROM buses ORDER BY CAST(id AS INTEGER), id'),
    db().execute('SELECT bus_id, ts, speed FROM positions'),
  ]);
  const notices = await db().execute('SELECT id, message, level, created_at, expires_at FROM notices ORDER BY created_at DESC LIMIT 100');
  const sharers = await db().execute({ sql: `SELECT s.student_id, u.username, s.bus_id, s.status, s.started_at, s.verified_at, s.last_ts FROM share_sessions s
      LEFT JOIN users u ON u.id = s.student_id WHERE s.last_ts > ? ORDER BY s.last_ts DESC`, args: [Date.now() - 30 * 60e3] });
  const blocks = await db().execute('SELECT b.student_id, u.username, b.at FROM share_blocks b LEFT JOIN users u ON u.id = b.student_id ORDER BY b.at DESC');
  const [users, photos, treats] = await db().batch([
    `SELECT u.id, u.username, u.emoji, u.route_id, u.batch, u.avatar_v, u.no_photo, u.created_at, u.seen_at,
        (SELECT COALESCE(SUM(${PTS}),0) FROM contrib c WHERE c.user_id = u.id) AS xp,
        (SELECT COUNT(*) FROM reports r WHERE r.target = u.id) AS reports,
        EXISTS (SELECT 1 FROM share_blocks b WHERE b.student_id = u.id) AS blocked
      FROM users u ORDER BY reports DESC, u.seen_at DESC LIMIT 300`,
    // photos that need a look: reported or auto-hidden, plus the newest uploads
    // (only when the Community tab asks: photos are a few KB each)
    community ? `SELECT a.user_id, a.mime, a.data, a.at, a.hidden, u.username, (SELECT COUNT(*) FROM reports r WHERE r.target = a.user_id) AS reports
      FROM avatars a JOIN users u ON u.id = a.user_id ORDER BY a.hidden DESC, reports DESC, a.at DESC LIMIT 40` : 'SELECT 1 WHERE 0',
    `SELECT t.id, t.route_id, t.week, t.status, t.created_at, t.settled_at, c.username AS champion, g.username AS giver,
        (SELECT COUNT(*) FROM vouches v WHERE v.treat_id = t.id) AS votes
      FROM treats t LEFT JOIN users c ON c.id = t.champion_id LEFT JOIN users g ON g.id = t.giver_id ORDER BY t.week DESC, t.id DESC LIMIT 60`,
  ], 'read');
  const win = await windows();
  const [cal, xpBoost, fb, subs] = await Promise.all([calendar(), boost(), db().execute(`SELECT f.*, u.username FROM feedback f LEFT JOIN users u ON u.id = f.user_id
      ORDER BY (f.status = 'new') DESC, f.created_at DESC LIMIT 200`), db().execute('SELECT COUNT(*) AS n, SUM(notices) AS notices FROM push_subs')]);
  const last = Object.fromEntries(pos.rows.map(p => [p.bus_id, p]));
  return {
    now: Date.now(), campus: CAMPUS, rev: await getRev(),
    routes: routes.rows.map(r => ({ id: r.id, name: r.name, color: r.color, stops: JSON.parse(r.stops), geometry: JSON.parse(r.geometry) })),
    buses: buses.rows.map(b => ({ id: b.id, routeId: b.route_id, departStart: b.depart_start, departCampus: b.depart_campus, days: b.days, lastSeen: last[b.id]?.ts ?? null, speed: last[b.id]?.speed ?? null })),
    crowdEnabled: (await getSetting('crowd_enabled', '1')) === '1',
    sharers: sharers.rows.map(x => ({ studentId: x.student_id, username: x.username, busId: x.bus_id, status: x.status, startedAt: x.started_at, verifiedAt: x.verified_at, lastTs: x.last_ts })),
    blocked: blocks.rows.map(x => ({ studentId: x.student_id, username: x.username, at: x.at })),
    windows: win.text,
    calendar: cal, boost: xpBoost, today: bdNow().day,
    push: { subscribers: Number(subs.rows[0].n), notices: Number(subs.rows[0].notices) || 0 },
    feedback: fb.rows.map(f => ({ id: f.id, routeId: f.route_id, busId: f.bus_id, kind: f.kind, message: f.message, username: f.username, contact: f.contact,
      attachments: f.attachments ? JSON.parse(f.attachments) : [], status: f.status, createdAt: f.created_at })),
    users: users.rows.map(u => ({ id: u.id, username: u.username, emoji: u.emoji, routeId: u.route_id, batch: u.batch, hasPhoto: !!u.avatar_v, noPhoto: !!u.no_photo,
      createdAt: u.created_at, seenAt: u.seen_at, xp: Number(u.xp), reports: Number(u.reports), blocked: !!u.blocked })),
    photos: photos.rows.map(a => ({ userId: a.user_id, username: a.username, src: `data:${a.mime};base64,${a.data}`, at: a.at, hidden: !!a.hidden, reports: Number(a.reports) })),
    treats: treats.rows.map(t => ({ id: t.id, routeId: t.route_id, week: t.week, status: t.status, champion: t.champion, giver: t.giver, votes: Number(t.votes), createdAt: t.created_at })),
    notices: notices.rows.map(n => ({ id: n.id, message: n.message, level: n.level, createdAt: n.created_at, expiresAt: n.expires_at })),
  };
}

const actions = {
  async saveRoute({ route }) {
    const name = String(route?.name || '').trim().slice(0, 60);
    if (!name) throw new Error('Enter a route name.');
    const color = COLOR.test(route.color) ? route.color : '#0b6e1c';
    const stops = cleanStops(route.stops);
    const id = route.id || 'r' + Date.now().toString(36);
    const g = await buildGeometry(stops);
    await db().execute({ sql: `INSERT INTO routes (id,name,color,stops,geometry,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, stops=excluded.stops, geometry=excluded.geometry, updated_at=excluded.updated_at`,
      args: [id, name, color, JSON.stringify(stops), JSON.stringify(g.geometry), Date.now()] });
    // Sanity check, leg by leg: if two neighbouring stops are far apart by road but close in a straight line,
    // one of them is probably misplaced (off the road network) or the stops are out of order.
    const pts = [...stops, CAMPUS]; let warn = null;
    const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 102);
    // A stop that forces a big detour between its neighbours is probably misplaced.
    for (let i = 1; i < pts.length - 1 && !warn; i++) {
      const via = dist(pts[i - 1], pts[i]) + dist(pts[i], pts[i + 1]), straight = dist(pts[i - 1], pts[i + 1]);
      if (via - straight > 5 && via > straight * 2.5) warn = `"${pts[i].name}" is far out of the way between "${pts[i - 1].name}" and "${pts[i + 1].name}". It may be in the wrong place or order.`;
    }
    (g.legsKm || []).forEach((km, i) => {
      const a = pts[i], b = pts[i + 1], direct = Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 102);
      if (!warn && km > 3 && km > direct * 3) warn = `"${a.name}" to "${b.name}" is ${km.toFixed(1)} km by road but only ${direct.toFixed(1)} km apart. One of them may be in the wrong place or order.`;
    });
    return { id, snapped: g.snapped, km: g.km, warn };
  },
  async deleteRoute({ id }) {
    await db().execute({ sql: 'UPDATE buses SET route_id = NULL WHERE route_id = ?', args: [id] });
    await db().execute({ sql: 'DELETE FROM routes WHERE id = ?', args: [id] });
    return {};
  },
  // Create a bus, or rename it / change its route. `id` = current number (null when creating), `newId` = number to use.
  async saveBus({ id, newId, routeId, departStart, departCampus, days }) {
    newId = String(newId || '').trim();
    const ds = time(departStart, 'Leaves start'), dc = time(departCampus, 'Leaves campus');
    days = String(days || '').trim().slice(0, 30) || null;
    if (!BUS_ID.test(newId)) throw new Error('Bus number: 1-10 letters, digits or dashes.');
    if (routeId) {
      const r = await db().execute({ sql: 'SELECT id FROM routes WHERE id = ?', args: [routeId] });
      if (!r.rows[0]) throw new Error('Route not found.');
    }
    if (!id) {
      const ex = await db().execute({ sql: 'SELECT id FROM buses WHERE id = ?', args: [newId] });
      if (ex.rows[0]) throw new Error(`Bus ${newId} already exists.`);
      const token = newToken();
      await db().execute({ sql: 'INSERT INTO buses (id, route_id, token_hash, depart_start, depart_campus, days) VALUES (?,?,?,?,?,?)', args: [newId, routeId || null, sha256(token), ds, dc, days] });
      return { token };
    }
    if (id !== newId) {
      const ex = await db().execute({ sql: 'SELECT id FROM buses WHERE id = ?', args: [newId] });
      if (ex.rows[0]) throw new Error(`Bus ${newId} already exists.`);
      await db().batch([
        { sql: 'UPDATE buses SET id = ?, route_id = ?, depart_start = ?, depart_campus = ?, days = ? WHERE id = ?', args: [newId, routeId || null, ds, dc, days, id] },
        { sql: 'UPDATE positions SET bus_id = ? WHERE bus_id = ?', args: [newId, id] },
      ], 'write');
    } else {
      await db().execute({ sql: 'UPDATE buses SET route_id = ?, depart_start = ?, depart_campus = ?, days = ? WHERE id = ?', args: [routeId || null, ds, dc, days, id] });
    }
    return {};
  },
  async deleteBus({ id }) {
    await db().batch([{ sql: 'DELETE FROM positions WHERE bus_id = ?', args: [id] }, { sql: 'DELETE FROM buses WHERE id = ?', args: [id] }], 'write');
    return {};
  },
  async addNotice({ message, level, expiresAt, push }) {
    message = String(message || '').trim();
    if (!message) throw new Error('Write the notice text.');
    if (message.length > 500) throw new Error('Notice is too long (max 500 characters).');
    level = level === 'urgent' ? 'urgent' : 'info';
    const exp = expiresAt ? Number(expiresAt) : null;
    if (exp !== null && (!Number.isFinite(exp) || exp <= Date.now())) throw new Error('Expiry must be in the future.');
    await db().execute({ sql: 'INSERT INTO notices (message, level, created_at, expires_at) VALUES (?,?,?,?)', args: [message, level, Date.now(), exp] });
    if (push) { // also as a push notification to everyone who allowed notices (sent over the next minutes by the cron job)
      const n = await enqueue({ where: 's.notices = 1', title: level === 'urgent' ? '🚨 Transport notice' : '📢 Transport notice', body: message, tag: 'notice', ttl: 6 * 3600 });
      await drain(20);
      return { pushed: n };
    }
    return {};
  },
  async deleteNotice({ id }) {
    await db().execute({ sql: 'DELETE FROM notices WHERE id = ?', args: [Number(id)] });
    return {};
  },
  async setCrowd({ enabled }) { await setSetting('crowd_enabled', enabled ? '1' : '0'); return {}; },
  async blockSharer({ studentId }) {
    studentId = String(studentId || '').trim(); if (!studentId) throw new Error('Student ID missing.');
    await db().batch([
      { sql: 'INSERT INTO share_blocks (student_id, at) VALUES (?,?) ON CONFLICT(student_id) DO NOTHING', args: [studentId, Date.now()] },
      { sql: 'DELETE FROM share_sessions WHERE student_id = ?', args: [studentId] },
      { sql: 'DELETE FROM share_fixes WHERE student_id = ?', args: [studentId] },
    ], 'write');
    return {};
  },
  async unblockSharer({ studentId }) { await db().execute({ sql: 'DELETE FROM share_blocks WHERE student_id = ?', args: [String(studentId)] }); return {}; },
  async setWindows({ am, pm }) {
    const a = parseWin(am), p = parseWin(pm);
    if (!a || !p || a[0] >= a[1] || p[0] >= p[1]) throw new Error('Sharing hours: use times like 06:00 and 12:00 (start before end).');
    await setSetting('win_am', am); await setSetting('win_pm', pm); resetWindowsCache();
    return {};
  },
  // ---- community moderation ----
  async removePhoto({ userId, ban }) {
    await db().batch([
      { sql: 'DELETE FROM avatars WHERE user_id = ?', args: [userId] }, { sql: 'DELETE FROM reports WHERE target = ?', args: [userId] },
      { sql: `UPDATE users SET avatar_v = 0${ban ? ', no_photo = 1' : ''} WHERE id = ?`, args: [userId] },
    ], 'write');
    return {};
  },
  async keepPhoto({ userId }) { // reviewed: the photo is fine
    const a = (await db().execute({ sql: 'SELECT at FROM avatars WHERE user_id = ?', args: [userId] })).rows[0];
    if (!a) throw new Error('No photo.');
    await db().batch([
      { sql: 'UPDATE avatars SET hidden = 0 WHERE user_id = ?', args: [userId] }, { sql: 'DELETE FROM reports WHERE target = ?', args: [userId] },
      { sql: 'UPDATE users SET avatar_v = ? WHERE id = ?', args: [a.at, userId] },
    ], 'write');
    return {};
  },
  async setPhotoBan({ userId, ban }) { await db().execute({ sql: 'UPDATE users SET no_photo = ? WHERE id = ?', args: [ban ? 1 : 0, userId] }); return {}; },
  async renameUser({ userId }) { // replace an offensive username; the rider can pick a new one right away
    const name = 'rider_' + randomBytes(3).toString('hex');
    await db().execute({ sql: 'UPDATE users SET username = ?, renamed_at = NULL WHERE id = ?', args: [name, userId] });
    return { name };
  },
  async settleTreat({ id, status }) {
    if (!['pending', 'paid', 'vouched', 'cancelled'].includes(status)) throw new Error('Bad status.');
    await db().execute({ sql: 'UPDATE treats SET status = ?, settled_at = ? WHERE id = ?', args: [status, status === 'pending' ? null : Date.now(), Number(id)] });
    return {};
  },
  // ---- university calendar ----
  async setOpenDays({ days }) {
    const d = [...new Set((Array.isArray(days) ? days : []).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6))];
    if (!d.length) throw new Error('Pick at least one open day.');
    await setSetting('open_days', d.join(',')); resetCalendarCache(); return {};
  },
  async setSpecialDay({ day, open, note }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error('Pick a date.');
    await db().execute({ sql: 'INSERT INTO calendar (day, open, note) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET open = excluded.open, note = excluded.note',
      args: [day, open ? 1 : 0, String(note || '').trim().slice(0, 60) || null] });
    resetCalendarCache(); return {};
  },
  async deleteSpecialDay({ day }) { await db().execute({ sql: 'DELETE FROM calendar WHERE day = ?', args: [String(day)] }); resetCalendarCache(); return {}; },
  // ---- XP boost (double XP week) ----
  async setBoost({ from, to, mult, label }) {
    const D = /^\d{4}-\d{2}-\d{2}$/;
    if (!D.test(from || '') || !D.test(to || '') || from > to) throw new Error('Boost: pick a start and end date.');
    const m = Number(mult); if (![1.5, 2, 3].includes(m)) throw new Error('Boost: 1.5×, 2× or 3×.');
    await setSetting('xp_boost', JSON.stringify({ from, to, mult: m, label: String(label || '').trim().slice(0, 60) || `${m}× XP` })); resetBoostCache(); return {};
  },
  async clearBoost() { await setSetting('xp_boost', 'null'); resetBoostCache(); return {}; },
  // ---- feedback ----
  async setFeedback({ id, status }) {
    if (!['new', 'seen', 'done'].includes(status)) throw new Error('Bad status.');
    await db().execute({ sql: 'UPDATE feedback SET status = ? WHERE id = ?', args: [status, Number(id)] }); return {};
  },
  async newToken({ id }) {
    const token = newToken();
    const r = await db().execute({ sql: 'UPDATE buses SET token_hash = ? WHERE id = ?', args: [sha256(token), id] });
    if (!r.rowsAffected) throw new Error('Bus not found.');
    return { token };
  },
};

export default async function handler(req, res) {
  if (!adminFrom(req)) return res.status(401).json({ error: 'Admin sign-in required.' });
  await ensureSchema();
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json(await state((req.query || {}).community === '1'));
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const fn = actions[req.body?.action];
  if (!fn) return res.status(400).json({ error: 'Unknown action.' });
  try {
    const out = await fn(req.body);
    await bumpRev();
    res.status(200).json({ ok: true, ...out, state: await state(!!req.body.community) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Request failed.' });
  }
}
