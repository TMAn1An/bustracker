// ডেমো ডেটা তৈরি: node db/seed.js            (লোকাল ফাইল DB)
// প্রোডাকশন:     TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node db/seed.js
// স্টুডেন্ট ইম্পোর্ট: node db/seed.js --students students.csv   (কলাম: id,name,password)
import { readFileSync, writeFileSync } from 'node:fs';
import { db, SCHEMA, hashPassword, sha256 } from '../api/_lib.js';
import { randomBytes } from 'node:crypto';

const c = db();
for (const sql of SCHEMA) await c.execute(sql);
const args = process.argv.slice(2);

const csv = args[args.indexOf('--students') + 1];
if (args.includes('--students') && csv) {
  const rows = readFileSync(csv, 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map(l => l.split(','));
  for (const [id, name, pw] of rows) {
    await c.execute({ sql: 'INSERT INTO students (id,name,pass) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, pass=excluded.pass', args: [id.trim(), (name || '').trim(), hashPassword(pw.trim())] });
  }
  console.log(rows.length + ' জন স্টুডেন্ট ইম্পোর্ট হয়েছে');
  process.exit(0);
}

// ডেমো স্টুডেন্ট
await c.execute({ sql: 'INSERT INTO students (id,name,pass) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING', args: ['2025001', 'ডেমো স্টুডেন্ট', hashPassword('demo1234')] });
// প্রতি বাসের জন্য ট্র্যাকার টোকেন (শুধু একবার দেখানো হয়)
const routes = JSON.parse(readFileSync(new URL('../data/routes.json', import.meta.url))).routes;
const tokens = {};
for (const r of routes) {
  const ex = await c.execute({ sql: 'SELECT id FROM buses WHERE id=?', args: [r.busId] });
  if (ex.rows[0]) continue;
  const t = randomBytes(18).toString('base64url');
  await c.execute({ sql: 'INSERT INTO buses (id, token_hash) VALUES (?,?)', args: [r.busId, sha256(t)] });
  tokens[r.busId] = t;
}
if (Object.keys(tokens).length) {
  writeFileSync(new URL('../.bus-tokens.json', import.meta.url), JSON.stringify(tokens, null, 1));
  console.log('নতুন বাস-টোকেন .bus-tokens.json এ সেভ হয়েছে (গিটে যাবে না)');
}
console.log('ডেমো লগইন: 2025001 / demo1234');
