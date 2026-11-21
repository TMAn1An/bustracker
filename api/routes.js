import { db, getRev, CAMPUS, ensureSchema, activeNotices, getSetting } from './_lib.js';
import { windows, calendar, boost } from './_social.js';

// Public (open portal): routes, bus->route assignment, schedules, sharing windows and notices. Reloaded only when `rev` changes.
export default async function handler(req, res) {
  await ensureSchema();
  const [routes, buses, rev, notices, crowd] = await Promise.all([
    db().execute('SELECT id, name, color, stops, geometry FROM routes ORDER BY name'),
    db().execute('SELECT id, route_id, depart_start, depart_campus, days FROM buses ORDER BY CAST(id AS INTEGER), id'),
    getRev(), activeNotices(), getSetting('crowd_enabled', '1'),
  ]);
  const [win, cal, xpBoost] = await Promise.all([windows(), calendar(), boost()]);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    campus: CAMPUS, rev,
    routes: routes.rows.map(r => ({ id: r.id, name: r.name, color: r.color, stops: JSON.parse(r.stops), geometry: JSON.parse(r.geometry) })),
    buses: buses.rows.map(b => ({ id: b.id, routeId: b.route_id, departStart: b.depart_start, departCampus: b.depart_campus, days: b.days })),
    notices, now: Date.now(), crowdEnabled: crowd === '1',
    windows: { am: win.am, pm: win.pm },          // minutes after midnight, Bangladesh time
    turnstile: process.env.TURNSTILE_SITEKEY || null, // optional bot check when picking a username
    calendar: cal,                                     // { openDays: [6,0,1,2,3], special: { 'YYYY-MM-DD': { open, note } } }
    boost: xpBoost,                                    // { from, to, mult, label } while a double-XP event is running or coming
  });
}
