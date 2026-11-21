// LOCAL test of Web Push: a fake push service on 127.0.0.1 checks that our pings carry a valid VAPID signature,
// then plays the service worker (fetches the inbox). Run: PUSH_TEST=1 npm run dev, then node scripts/test-push.js
import http from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
const BASE = process.argv[2] || 'http://localhost:3000';
const got = [];
const srv = http.createServer((req, res) => { got.push({ auth: req.headers.authorization, ttl: req.headers.ttl }); res.statusCode = 201; res.end(); }).listen(4999);
const post = async (b, tok) => (await fetch(BASE + '/api/push', { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(b) })).json();
const { key } = await (await fetch(BASE + '/api/push')).json();
const endpoint = 'http://127.0.0.1:4999/push/' + Date.now();
console.log('subscribe', await post({ action: 'subscribe', subscription: { endpoint, keys: {} }, routeId: 'rajendrapur', remind: true }));
console.log('test', await post({ action: 'test', endpoint }));
await new Promise(r => setTimeout(r, 500));
const g = got[0]; if (!g) { console.log('FAIL: no ping received'); process.exit(1); }
const [, t, k] = /vapid t=([^,]+), k=(.+)/.exec(g.auth);
const [h, p, sig] = t.split('.');
const raw = Buffer.from(k, 'base64url'); // 65-byte uncompressed P-256 point -> JWK
const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
const ok = verify('sha256', Buffer.from(h + '.' + p), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
console.log('ping TTL', g.ttl, '| key matches', k === key, '| JWT', JSON.parse(Buffer.from(p, 'base64url')), '| signature valid:', ok);
console.log('inbox', JSON.stringify(await post({ action: 'inbox', endpoint })));
console.log('inbox again (empty)', JSON.stringify(await post({ action: 'inbox', endpoint })));
console.log('unsubscribe', await post({ action: 'unsubscribe', endpoint }));
srv.close();
