// LOCAL test: at most 3 riders share one bus; a 4th waits and gets the slot when one stops. Run: npm run dev, then node scripts/test-slots.js
import { db, ensureSchema } from '../server/_lib.js';
if (process.env.TURSO_DATABASE_URL) { console.error('Refusing to run against a remote database.'); process.exit(1); }
const BASE = process.argv[2] || 'http://localhost:3000';
await ensureSchema();
await db().execute(`DELETE FROM users WHERE username LIKE 'slot_rider_%'`); await db().execute(`DELETE FROM share_sessions`); await db().execute(`DELETE FROM trips WHERE bus_id='11'`);
const oldWin = (await db().execute(`SELECT value FROM settings WHERE key='win_am'`)).rows[0]?.value;
await db().execute(`INSERT INTO settings (key,value) VALUES ('win_am','00:00-23:59') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
const post = (path, body, tok) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) }).then(r => r.json());
const cfg = await (await fetch(BASE + '/api/routes')).json();
const g = cfg.routes.find(r => r.id === 'rajendrapur').geometry, [lng, lat] = g[Math.floor(g.length / 3)];
const tok = []; for (const k of [1, 2, 3, 4]) tok.push((await post('/api/me', { action: 'join', username: 'slot_rider_' + k, routeId: 'rajendrapur' })).token);
await new Promise(r => setTimeout(r, 30000)); // the window cache in the dev server refreshes every 30 s
const send = i => post('/api/share', { busId: '11', lat, lng, acc: 10, speed: 8 }, tok[i]);
for (const i of [0, 1, 2, 3]) console.log(`rider ${i + 1}:`, (await send(i)).status);
console.log('rider 1 stops:', (await post('/api/share', { action: 'stop', busId: '11' }, tok[0])).status);
await new Promise(r => setTimeout(r, 2600));
console.log('rider 4 again:', (await send(3)).status);
console.log('rider 1 back:', (await send(0)).status);
oldWin ? await db().execute({ sql: `UPDATE settings SET value=? WHERE key='win_am'`, args: [oldWin] }) : await db().execute(`DELETE FROM settings WHERE key='win_am'`);
process.exit(0);
