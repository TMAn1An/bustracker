import { db, adminFrom, buildGeometry, bumpRev, getRev, sha256, num, CAMPUS } from './_lib.js';
import { randomBytes } from 'node:crypto';

const BUS_ID = /^[A-Za-z0-9-]{1,10}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const newToken = () => randomBytes(18).toString('base64url');

function cleanStops(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 60) throw new Error('A route needs at least one stop (the starting point).');
  return list.map((s, i) => {
    const lat = num(s.lat, -90, 90), lng = num(s.lng, -180, 180), name = String(s.name || '').trim().slice(0, 60);
    if (lat === null || lng === null || !name) throw new Error(`Stop ${i + 1} needs a name and a location.`);
    return { name, lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
  });
}

async function state() {
  const [routes, buses, pos] = await Promise.all([
    db().execute('SELECT id, name, color, stops, geometry, updated_at FROM routes ORDER BY name'),
    db().execute('SELECT id, route_id FROM buses ORDER BY CAST(id AS INTEGER), id'),
    db().execute('SELECT bus_id, ts, speed FROM positions'),
  ]);
  const last = Object.fromEntries(pos.rows.map(p => [p.bus_id, p]));
  return {
    now: Date.now(), campus: CAMPUS, rev: await getRev(),
    routes: routes.rows.map(r => ({ id: r.id, name: r.name, color: r.color, stops: JSON.parse(r.stops), geometry: JSON.parse(r.geometry) })),
    buses: buses.rows.map(b => ({ id: b.id, routeId: b.route_id, lastSeen: last[b.id]?.ts ?? null, speed: last[b.id]?.speed ?? null })),
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
    return { id, snapped: g.snapped, km: g.km };
  },
  async deleteRoute({ id }) {
    await db().execute({ sql: 'UPDATE buses SET route_id = NULL WHERE route_id = ?', args: [id] });
    await db().execute({ sql: 'DELETE FROM routes WHERE id = ?', args: [id] });
    return {};
  },
  // Create a bus, or rename it / change its route. `id` = current number (null when creating), `newId` = number to use.
  async saveBus({ id, newId, routeId }) {
    newId = String(newId || '').trim();
    if (!BUS_ID.test(newId)) throw new Error('Bus number: 1-10 letters, digits or dashes.');
    if (routeId) {
      const r = await db().execute({ sql: 'SELECT id FROM routes WHERE id = ?', args: [routeId] });
      if (!r.rows[0]) throw new Error('Route not found.');
    }
    if (!id) {
      const ex = await db().execute({ sql: 'SELECT id FROM buses WHERE id = ?', args: [newId] });
      if (ex.rows[0]) throw new Error(`Bus ${newId} already exists.`);
      const token = newToken();
      await db().execute({ sql: 'INSERT INTO buses (id, route_id, token_hash) VALUES (?,?,?)', args: [newId, routeId || null, sha256(token)] });
      return { token };
    }
    if (id !== newId) {
      const ex = await db().execute({ sql: 'SELECT id FROM buses WHERE id = ?', args: [newId] });
      if (ex.rows[0]) throw new Error(`Bus ${newId} already exists.`);
      await db().batch([
        { sql: 'UPDATE buses SET id = ?, route_id = ? WHERE id = ?', args: [newId, routeId || null, id] },
        { sql: 'UPDATE positions SET bus_id = ? WHERE bus_id = ?', args: [newId, id] },
      ], 'write');
    } else {
      await db().execute({ sql: 'UPDATE buses SET route_id = ? WHERE id = ?', args: [routeId || null, id] });
    }
    return {};
  },
  async deleteBus({ id }) {
    await db().batch([{ sql: 'DELETE FROM positions WHERE bus_id = ?', args: [id] }, { sql: 'DELETE FROM buses WHERE id = ?', args: [id] }], 'write');
    return {};
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
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json(await state());
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const fn = actions[req.body?.action];
  if (!fn) return res.status(400).json({ error: 'Unknown action.' });
  try {
    const out = await fn(req.body);
    await bumpRev();
    res.status(200).json({ ok: true, ...out, state: await state() });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Request failed.' });
  }
}
