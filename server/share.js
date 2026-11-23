// Crowd mode: a signed-in student on the bus shares their phone location for that bus.
// Every fix is checked on the server before it can move the bus on everyone's map:
//   1. GPS accuracy must be usable                              (MAX_ACC)
//   2. the phone must be on this bus's route (the road)           (ON_ROUTE)
//   3. it must travel along the route like a vehicle, not sit at home:
//      at least MIN_PROGRESS metres along the route over at least MIN_WINDOW, at vehicle speed (MIN_KMH)
//   4. no impossible jumps between fixes                          (MAX_KMH)
//   5. sitting still for STALL_MS (e.g. got off the bus) pauses the share
//   6. with several sharers, the one verified first wins; a newcomer far from it is ignored (AGREE_M)
//   7. the official bus phone always has priority while it is live (DEVICE_FRESH_MS)
// Students' identities are never shown to other students; admins can see and block sharers.
import { db, userFrom, num, ensureSchema, getSetting } from './_lib.js';
import { project, metres } from './_geo.js';
import { routeFor, windows, legAt, bdNow, tripOf, tripTick, credit, windowText, END_M, calendar, busRuns, boostToday } from './_social.js';
import { hit } from './_ratelimit.js';
import { SITE } from './_config.js';

const MAX_ACC = 60, ON_ROUTE = 80, MIN_PROGRESS = 400, MIN_WINDOW = 90e3, // ~9 fixes at one every 10 s
      MIN_KMH = 8, MAX_KMH = 120;
const WINDOW = 4 * 60e3, STALL_MS = 6 * 60e3, STALL_M = 60, AGREE_M = 500, PEER_FRESH = 20e3, DEVICE_FRESH_MS = 45e3;
const MIN_GAP = 2500, FULL_RIDE_S = 600, STILL_M = 15; // moved less than this in ~30 s = standing still
// At most SLOTS riders share one bus at a time. A slot is held while the rider keeps sending (SLOT_FRESH);
// riders still being checked hold it for CHECK_HOLD at most, so someone "sharing" from home cannot block real riders.
const SLOTS = 3, SLOT_FRESH = 30e3, CHECK_HOLD = 5 * 60e3;

const MSG = {
  checking: 'Checking: keep sharing while the bus moves along the route.',
  verified: 'Verified: your location is helping others see this bus.',
  backup: 'Verified. The bus phone is live, so yours is on standby as a backup (half XP).',
  disagree: 'Another verified rider is already sharing this bus; your location does not match theirs, so it is not used.',
  paused: 'Paused: you have not moved for a while. Sharing resumes when the bus moves.',
  off_route: 'You are not on this bus route, so your location cannot be used.',
  weak_gps: 'GPS signal is too weak right now. Move near a window.',
  jump: 'Your location jumped impossibly far, so it was ignored.',
  wrong_way: 'This trip goes the other way, so your location cannot be used.',
  arrived: 'The bus reached the end of the route. Sharing stopped. Thank you!',
  full: `${SLOTS} riders are already sharing this bus. Keep the app open: you get the next free slot automatically.`,
};
const hm = ms => new Date(ms + SITE.utcOffsetHours * 3600e3).toISOString().slice(11, 16).replace(/^(\d\d):(\d\d)$/, (_, h, m) => `${(+h % 12) || 12}:${m} ${+h < 12 ? 'AM' : 'PM'}`);

async function stop(sid) {
  await db().batch([{ sql: 'DELETE FROM share_sessions WHERE student_id = ?', args: [sid] }, { sql: 'DELETE FROM share_fixes WHERE student_id = ?', args: [sid] }], 'write');
}

export default async function handler(req, res) {
  const me = userFrom(req);
  if (!me) return res.status(401).json({ error: 'Pick a username first to share location.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  await ensureSchema();
  const r = await crowdFix(me.id, req.body || {});
  res.status(r.http).json(r.json);
}

/** One location fix (or stop / seat report) from a rider: from the web app, or from the Traccar Client app via /api/osmand. */
export async function crowdFix(sid, body) {
  const out = (http, json) => ({ http, json });
  const reply = (status, extra = {}) => out(200, { status, message: MSG[status], ...extra });

  if (body.action === 'stop') { await stop(sid); return out(200, { status: 'stopped' }); }

  if ((await getSetting('crowd_enabled', '1')) !== '1') return out(403, { error: 'Location sharing by students is turned off by the admin.' });
  const acct = (await db().execute({ sql: 'SELECT u.id, (SELECT 1 FROM share_blocks b WHERE b.student_id = u.id) AS blocked FROM users u WHERE u.id = ?', args: [sid] })).rows[0];
  if (!acct) return out(401, { error: 'Your account was not found. Pick a username again.' });
  if (acct.blocked) return out(403, { error: 'Location sharing is not available for your account. Contact the transport office.' });
  // Only during trip times: morning until the bus reaches campus, evening until it reaches the end of its route.
  const win = await windows(), bt = bdNow(), leg = legAt(win, bt.min);
  if (!leg) { await stop(sid); return out(403, { error: 'Sharing is closed right now. ' + windowText(win), closed: true }); }

  // Seat report from a verified rider of this bus: "plenty" / "few" / "full" (+2 XP, up to 3 per trip)
  if (body.action === 'seats') {
    const level = ['plenty', 'few', 'full'].includes(body.level) ? body.level : null;
    const ses = (await db().execute({ sql: 'SELECT bus_id, status, last_ts, last_s FROM share_sessions WHERE student_id = ?', args: [sid] })).rows[0];
    if (!level || !ses || !['verified', 'backup'].includes(ses.status) || Date.now() - ses.last_ts > 60e3)
      return out(403, { error: 'Seat reports come from verified riders who are sharing this bus.' });
    const now = Date.now();
    // the report is valid until the bus reaches its next stop (people get on and off there); the app checks this
    await db().execute({ sql: 'UPDATE trips SET seats = ?, seats_at = ?, seats_s = ? WHERE bus_id = ? AND day = ? AND leg = ?', args: [level, now, ses.last_s ?? null, ses.bus_id, bt.day, leg] });
    if (await hit(`seat:${sid}:${bt.day}:${leg}`, 1, 5 * 60e3)) // XP at most once per 5 minutes
      await db().execute({ sql: 'UPDATE contrib SET seat_reports = seat_reports + 1 WHERE user_id = ? AND bus_id = ? AND day = ? AND leg = ?', args: [sid, ses.bus_id, bt.day, leg] });
    return out(200, { ok: true, seats: level });
  }

  const busId = String(body.busId || ''), lat = num(body.lat, -90, 90), lng = num(body.lng, -180, 180), acc = num(body.acc, 0, 100000);
  if (!busId || lat === null || lng === null) return out(400, { error: 'Bad request' });
  const route = await routeFor(busId);
  if (!route) return out(404, { error: 'This bus has no route yet.' });
  // University calendar: Sat–Wed by default, plus special open days (exams, programs); holidays closed.
  const busDays = (await db().execute({ sql: 'SELECT days FROM buses WHERE id = ?', args: [busId] })).rows[0]?.days;
  const cal = await calendar();
  if (!busRuns(cal, bt.day, busDays)) { await stop(sid); return out(403, { error: `Bus ${busId} does not run today${cal.special[bt.day]?.note ? ` (${cal.special[bt.day].note})` : ''}.`, closed: true }); }
  const trip0 = await tripOf(busId, bt.day, leg);
  if (trip0 && trip0.state === 'arrived') {
    await stop(sid);
    return out(403, { error: `Bus ${busId} already ${leg === 'am' ? 'reached campus' : 'reached the end of its route'} at ${hm(trip0.arrived_at)}. Thanks anyway!`, closed: true });
  }

  const now = Date.now();
  let ses = (await db().execute({ sql: 'SELECT * FROM share_sessions WHERE student_id = ?', args: [sid] })).rows[0];
  if (ses && ses.bus_id !== busId) { await stop(sid); ses = null; }          // switched bus: start over
  if (ses && now - ses.last_ts < MIN_GAP) return reply(ses.status);         // too frequent: ignore quietly
  // Slots: a rider who is not currently holding one may start only if fewer than SLOTS others are sharing this bus.
  if (!(ses && now - ses.last_ts < SLOT_FRESH)) {
    const n = Number((await db().execute({ sql: `SELECT COUNT(*) AS n FROM share_sessions WHERE bus_id = ? AND student_id <> ? AND last_ts > ?
        AND (status IN ('verified','backup') OR (status IN ('checking','weak_gps') AND started_at > ?))`, args: [busId, sid, now - SLOT_FRESH, now - CHECK_HOLD] })).rows[0].n);
    if (n >= SLOTS) { if (ses) await stop(sid); return reply('full', { sharing: n, slots: SLOTS }); }
  }
  if (!ses) {
    await db().execute({ sql: 'INSERT INTO share_sessions (student_id, bus_id, status, started_at, last_ts) VALUES (?,?,?,?,?)', args: [sid, busId, 'checking', now, now] });
    ses = { student_id: sid, bus_id: busId, status: 'checking', started_at: now, verified_at: null, last_ts: now, jumps: 0 };
  }
  const save = async (status, extra = {}) => {
    const f = { verified_at: ses.verified_at, jumps: 0, ...extra }; // a normal fix ends a run of jumps
    await db().execute({ sql: `UPDATE share_sessions SET status=?, last_ts=?, last_lat=?, last_lng=?, last_s=?, verified_at=?, jumps=? WHERE student_id=?`,
      args: [status, now, lat, lng, f.last_s ?? ses.last_s ?? null, f.verified_at ?? null, f.jumps, sid] });
  };

  // 1. accuracy
  if (acc === null || acc > MAX_ACC) { await save('weak_gps'); return reply('weak_gps'); }
  // 4. impossible jump since the previous fix
  if (ses.last_lat != null) {
    const dt = Math.max(1, (now - ses.last_ts) / 1000), d = metres(ses.last_lat, ses.last_lng, lat, lng);
    if (d > 150 && (d / dt) * 3.6 > MAX_KMH) {
      // One jump is usually a GPS glitch or an old fix sent late: ignore that fix but keep a verified rider verified.
      // Three in a row: start over (and forget the old fixes, so re-checking does not get stuck on them).
      const jumps = (ses.jumps || 0) + 1;
      if (jumps >= 3 || !ses.verified_at) {
        await db().execute({ sql: 'DELETE FROM share_fixes WHERE student_id = ?', args: [sid] });
        await save('jump', { jumps: 0, verified_at: null });
      } else await save('jump', { jumps });
      return reply('jump');
    }
  }
  // 2. on the route?
  const p = project(route, lat, lng);
  if (p.dist > ON_ROUTE + Math.min(acc, 40)) {
    await db().execute({ sql: 'DELETE FROM share_fixes WHERE student_id = ?', args: [sid] });
    await save('off_route', { verified_at: null }); return reply('off_route');
  }
  await db().batch([
    { sql: 'INSERT INTO share_fixes (student_id, ts, s, off, lat, lng) VALUES (?,?,?,?,?,?)', args: [sid, now, p.s, p.dist, lat, lng] },
    { sql: 'DELETE FROM share_fixes WHERE student_id = ? AND ts < ?', args: [sid, now - WINDOW - 60e3] },
  ], 'write');
  const fixes = (await db().execute({ sql: 'SELECT ts, s FROM share_fixes WHERE student_id = ? AND ts >= ? ORDER BY ts', args: [sid, now - WINDOW] })).rows;

  // 3. moving along the route like a vehicle?
  const first = fixes[0], last = fixes[fixes.length - 1], span = last.ts - first.ts;
  const progress = last.s - first.s, kmh = span > 0 ? (Math.abs(progress) / (span / 1000)) * 3.6 : 0;
  // standing still (traffic jam, at a stop): no direction from the fixes, so use the trip's direction (to campus in the morning)
  const dir = Math.abs(progress) < 50 ? (leg === 'am' ? 1 : -1) : progress >= 0 ? 1 : -1;
  // backtracking more than 150 m against the travel direction looks like noise or a fake
  let maxBack = 0, peak = first.s;
  for (const f of fixes) { if (dir > 0) { peak = Math.max(peak, f.s); maxBack = Math.max(maxBack, peak - f.s); } else { peak = Math.min(peak, f.s); maxBack = Math.max(maxBack, f.s - peak); } }
  const moving = span >= MIN_WINDOW && Math.abs(progress) >= MIN_PROGRESS && kmh >= MIN_KMH && kmh <= MAX_KMH && maxBack <= 150;

  let verifiedAt = ses.verified_at;
  if (!verifiedAt && moving) verifiedAt = now;
  // Back on the same trip: a rider who already moved this bus today on this trip (and lost verification, e.g. the app
  // was in the background) is trusted again at once when the fix fits where the bus was last seen: on the route, not
  // behind it, and reachable at bus speed. Otherwise a bus stuck in traffic or at campus could never be updated again.
  if (!verifiedAt) {
    const [was, last] = await Promise.all([
      db().execute({ sql: 'SELECT 1 FROM contrib WHERE user_id = ? AND bus_id = ? AND day = ? AND leg = ?', args: [sid, busId, bt.day, leg] }),
      db().execute({ sql: 'SELECT lat, lng, ts FROM positions WHERE bus_id = ?', args: [busId] }),
    ]);
    const lp = last.rows[0];
    if (was.rows[0] && lp && trip0?.state === 'live') {
      const q = project(route, Number(lp.lat), Number(lp.lng)), ahead = (leg === 'am' ? 1 : -1) * (p.s - q.s);
      const secs = Math.max(1, (now - Number(lp.ts)) / 1000);
      if (ahead > -150 && (Math.max(0, ahead) / secs) * 3.6 <= MAX_KMH) verifiedAt = now;
    }
  }
  if (!verifiedAt) { await save('checking', { last_s: p.s }); return reply('checking', { progress: Math.round(Math.abs(progress)) }); }

  // 5. stalled for a long time (e.g. got off the bus)?
  const recent = fixes.filter(f => f.ts >= now - STALL_MS);
  if (span >= STALL_MS - 30e3 && recent.length > 1 && Math.abs(recent[recent.length - 1].s - recent[0].s) < STALL_M) {
    await save('paused', { last_s: p.s, verified_at: verifiedAt }); return reply('paused');
  }
  // The trip direction must match the time of day: to campus in the morning, away from campus in the evening.
  if ((leg === 'am' && dir < 0) || (leg === 'pm' && dir > 0)) { await save('wrong_way', { last_s: p.s, verified_at: verifiedAt }); return reply('wrong_way'); }

  // Contribution: metres moved along the route since the last fix (in the travel direction, at a possible speed).
  const dt = Math.min(30, Math.max(0, (now - ses.last_ts) / 1000));
  const gain = ses.last_s == null ? 0 : Math.max(0, Math.min(dir * (p.s - ses.last_s), (MAX_KMH / 3.6) * dt));
  const earn = async (status, end) => {
    const trip = await tripTick(busId, leg, bt.day, p.s, route.length, now, status === 'verified' ? sid : null);
    const half = status === 'backup' ? 0.5 : 1;
    const c = await credit({ userId: sid, routeId: route.id, busId, day: bt.day, leg, metres: gain * half, secs: dt, first: trip.first_user === sid, full: false, now, mult: await boostToday() });
    if (end && Number(c.secs) >= FULL_RIDE_S) Object.assign(c, await credit({ userId: sid, routeId: route.id, busId, day: bt.day, leg, metres: 0, secs: 0, first: false, full: true, now }));
    return { xp: Number(c.xp) || 0, thanks: Number(trip.thanks) || 0, tripState: trip.state };
  };

  // arrived at the end of the route in the travel direction
  if ((dir > 0 && p.s >= route.length - END_M) || (dir < 0 && p.s <= END_M)) { const e = await earn('verified', true); await stop(sid); return reply('arrived', e); }

  // 7. the official bus phone has priority
  const pos = (await db().execute({ sql: 'SELECT ts, source, lat, lng FROM positions WHERE bus_id = ?', args: [busId] })).rows[0];
  if (pos && pos.source === 'device' && now - pos.ts < DEVICE_FRESH_MS) {
    await save('backup', { last_s: p.s, verified_at: verifiedAt }); return reply('backup', await earn('backup'));
  }

  // 6. other verified sharers on the same bus: the one verified first wins
  const peers = (await db().execute({ sql: `SELECT student_id, verified_at, last_lat, last_lng FROM share_sessions
      WHERE bus_id = ? AND student_id <> ? AND verified_at IS NOT NULL AND status = 'verified' AND last_ts > ?`, args: [busId, sid, now - PEER_FRESH] })).rows;
  const senior = peers.filter(x => x.verified_at < verifiedAt);
  if (senior.some(x => metres(x.last_lat, x.last_lng, lat, lng) > AGREE_M)) { await save('disagree', { last_s: p.s, verified_at: verifiedAt }); return reply('disagree'); }

  // Speed shown to everyone: measured from this rider's last ~30 s of fixes along the route, so a bus stuck in a jam
  // or waiting at a stop shows as stopped (the phone's own speed can be stale, and the 4-minute average never drops to 0).
  const reported = num(body.speed, 0, 60), heading = num(body.heading, 0, 360);
  const near = fixes.filter(x => x.ts >= now - 30e3), n0 = near[0], n1 = near[near.length - 1];
  const measured = n0 && n1.ts - n0.ts >= 8e3 ? (Math.abs(n1.s - n0.s) < STILL_M ? 0 : Math.abs(n1.s - n0.s) / ((n1.ts - n0.ts) / 1000)) : null;
  const speed = measured === 0 ? 0 : measured != null ? (reported != null ? Math.min(reported, measured * 1.5 + 1) : measured) : (reported ?? (kmh / 3.6));
  await db().execute({ sql: `INSERT INTO positions (bus_id, lat, lng, speed, heading, acc, ts, source) VALUES (?,?,?,?,?,?,?,'crowd')
      ON CONFLICT(bus_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, speed=excluded.speed, heading=excluded.heading, acc=excluded.acc, ts=excluded.ts, source='crowd'`,
    args: [busId, lat, lng, speed, heading, acc, now] });
  await save('verified', { last_s: p.s, verified_at: verifiedAt });
  return reply('verified', { ...(await earn('verified')), speed });
}
