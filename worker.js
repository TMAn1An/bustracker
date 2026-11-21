// Cloudflare Worker entry: serves the static app (Workers Static Assets) and the /api/* endpoints.
// The API handlers are the same files used on Vercel (api/*.js, Node-style req/res); this file adapts them.
import login from './api/login.js';
import adminLogin from './api/admin-login.js';
import admin from './api/admin.js';
import buses from './api/buses.js';
import routes from './api/routes.js';
import track from './api/track.js';
import osmand from './api/osmand.js';
import share from './api/share.js';
import me from './api/me.js';
import board from './api/board.js';
import avatar from './api/avatar.js';
import push from './api/push.js';
import feedback from './api/feedback.js';
import { tick } from './api/_push.js';
import { ensureSchema } from './api/_lib.js';

const API = { login, 'admin-login': adminLogin, admin, buses, routes, track, osmand, share, me, board, avatar, push, feedback };
// expose string bindings (secrets / vars) the way the handlers expect them
const useEnv = env => { for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v; };

export default {
  // Cron Trigger (wrangler.toml, every minute): departure reminders, weekly announcements, push outbox.
  async scheduled(event, env, ctx) {
    useEnv(env);
    ctx.waitUntil(ensureSchema().then(tick));
  },

  async fetch(request, env, ctx) {
    useEnv(env);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const handler = API[url.pathname.slice(5).replace(/\/+$/, '')];
    if (!handler) return Response.json({ error: 'Not found' }, { status: 404 });

    const headers = {};
    request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    headers['x-forwarded-for'] = request.headers.get('cf-connecting-ip') || headers['x-forwarded-for'] || '';
    let body;
    if (request.method === 'POST' && (headers['content-type'] || '').includes('json')) {
      try { body = await request.json(); } catch { body = undefined; }
    }
    const req = { method: request.method, headers, body, query: Object.fromEntries(url.searchParams), url: url.pathname + url.search,
      waitUntil: p => ctx.waitUntil(p.catch(e => console.error(e))) }; // background work after the response (e.g. sending pushes)

    let status = 200, payload = '';
    const out = new Headers();
    const res = {
      status(c) { status = c; return res; },
      setHeader(k, v) { out.set(k, v); },
      json(o) { out.set('content-type', 'application/json'); payload = JSON.stringify(o); },
      send(s) { payload = s instanceof Uint8Array ? s : String(s); }, // Buffers (photos) stay binary
      end(s) { if (s != null) payload = String(s); },
    };
    try { await handler(req, res); }
    catch (e) { console.error(e); return Response.json({ error: 'Server error' }, { status: 500 }); }
    return new Response(payload, { status, headers: out });
  },
};
