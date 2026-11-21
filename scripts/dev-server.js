// Local dev: static files + /api/* (with a Vercel-style req/res shim). npm run dev -> http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd(), PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/\/+$/, '');
      const { API } = await import(pathToFileURL(join(ROOT, 'server', 'index.js')));
      const handler = API[name];
      if (!handler) { res.statusCode = 404; return res.end('not found'); }
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      try { req.body = raw && (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : undefined; } catch { req.body = undefined; }
      req.query = Object.fromEntries(url.searchParams);
      req.waitUntil = p => p.catch(e => console.error(e));
      res.status = c => { res.statusCode = c; return res; };
      res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      res.send = s => res.end(s);
      return await handler(req, res);
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    if (/^[/\\](\.|node_modules|db|scripts|api|server)/.test(p) || p.endsWith('.db')) { res.statusCode = 404; return res.end('not found'); }
    const buf = await readFile(join(ROOT, p));
    res.setHeader('Content-Type', MIME[extname(p)] || 'application/octet-stream');
    res.end(buf);
  } catch (e) {
    res.statusCode = e.code === 'ENOENT' || e.code === 'ERR_MODULE_NOT_FOUND' ? 404 : 500;
    res.end(res.statusCode === 404 ? 'not found' : 'error: ' + e.message);
    if (res.statusCode === 500) console.error(e);
  }
}).listen(PORT, () => console.log('http://localhost:' + PORT));

// Same as the Cloudflare Cron Trigger: push reminders and outbox, once a minute (NO_CRON=1 to switch off).
if (!process.env.NO_CRON) setInterval(async () => {
  try { const { tick } = await import('../server/_push.js'); const { ensureSchema } = await import('../server/_lib.js'); await ensureSchema(); await tick(); }
  catch (e) { console.error('cron', e.message); }
}, 60e3);
