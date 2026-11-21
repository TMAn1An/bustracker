// Every API endpoint, by name (/api/<name>). Used by the Cloudflare Worker (worker.js), by Vercel (api/[name].js: a single
// function, so the free plan's 12-function limit never matters) and by the local dev server.
import login from './login.js';
import adminLogin from './admin-login.js';
import admin from './admin.js';
import buses from './buses.js';
import routes from './routes.js';
import track from './track.js';
import osmand from './osmand.js';
import share from './share.js';
import me from './me.js';
import board from './board.js';
import avatar from './avatar.js';
import push from './push.js';
import feedback from './feedback.js';

export const API = { login, 'admin-login': adminLogin, admin, buses, routes, track, osmand, share, me, board, avatar, push, feedback };
