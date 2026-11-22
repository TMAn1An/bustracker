/*
 * Social: the contributor side of the open portal.
 * - Account without password: the server gives this phone a secret device key (kept in localStorage) and a session token.
 *   The same key is the recovery code for moving to a new phone.
 * - Profile (username, emoji avatar or small photo) is cached on the phone so the app shows it instantly, even offline.
 * - Levels, badges, avatars and the GitHub-style contribution graph are drawn here.
 */
(function () {
  const KEY = 'iubat_me';
  const local = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} },
    del() { try { localStorage.removeItem(KEY); } catch {} },
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LEVELS = [[0, 'Rookie Rider'], [30, 'Window Seat Scout'], [100, 'Stop Spotter'], [300, 'Route Captain'], [700, 'Highway Hero'], [1500, 'Bus Legend'], [3000, 'GOAT of the Road']];
  const BADGES = {
    contributor: ['🤝', 'Contributor', 'Shared a bus location that helped others'],
    early_bird: ['🐓', 'Early Bird', 'Shared a morning trip before 6:45 AM'],
    trailblazer: ['🚩', 'Trailblazer', 'First rider to share a trip'],
    full_ride: ['🏁', 'Full Ride', 'Shared a trip all the way to the end'],
    night_owl: ['🌙', 'Evening Guardian', 'Shared an evening trip home'],
    streak3: ['🔥', 'On Fire', 'Shared on 3 bus days in a row'],
    streak7: ['☄️', 'Unstoppable', 'Shared on 7 bus days in a row'],
    km10: ['🛣️', '10 km Club', 'Shared 10 km in total'],
    km100: ['🚀', 'Century Rider', 'Shared 100 km in total'],
    explorer: ['🗺️', 'Explorer', 'Helped on 2 different routes'],
    champion: ['👑', 'Weekly Champion', 'Top contributor of a route for a week'],
    generous: ['🫖', 'Generous Senior', 'Treated a champion to tea or coffee'],
    seat_scout: ['💺', 'Seat Scout', 'Reported free seats 5 times'],
    route_war: ['⚔️', 'Route Warrior', 'Helped your route win a monthly route battle'],
    mapper: ['📍', 'Map Maker', 'Suggested a stop the transport office added'],
  };
  // shown first on leaderboards (rarest / most fun first)
  const BADGE_ORDER = ['champion', 'route_war', 'generous', 'mapper', 'streak7', 'km100', 'trailblazer', 'streak3', 'full_ride', 'seat_scout', 'explorer', 'early_bird', 'night_owl', 'km10', 'contributor'];
  const badgeRow = (ids, max = 4) => { const l = BADGE_ORDER.filter(b => (ids || []).includes(b)).slice(0, max);
    return l.length ? `<span class="brow">${l.map(b => `<i title="${esc(BADGES[b][1])}">${BADGES[b][0]}</i>`).join('')}${(ids || []).length > max ? `<em>+${ids.length - max}</em>` : ''}</span>` : ''; };
  const EMOJIS = ['🚌', '🐯', '🦊', '🐼', '🐸', '🦉', '🐧', '🐨', '🦁', '🐵', '🐱', '🐶', '🦄', '🐲', '🐻', '🐰', '🐙', '🦖', '🐝', '🦜'];
  const COLORS = ['#0b6e1c', '#1d6fe0', '#8a3ffc', '#d92d20', '#f08a00', '#00a3a3', '#c2188a', '#5b6b00'];
  const USERNAME = /^[A-Za-z_][A-Za-z0-9_]{2,19}$/;

  function level(xp) {
    let i = 0; while (i < LEVELS.length - 1 && xp >= LEVELS[i + 1][0]) i++;
    const from = LEVELS[i][0], to = LEVELS[i + 1] ? LEVELS[i + 1][0] : null;
    return { n: i + 1, name: LEVELS[i][1], from, to, pct: to ? Math.min(100, Math.round((xp - from) / (to - from) * 100)) : 100, next: LEVELS[i + 1]?.[1] || null };
  }
  function checkName(v) {
    v = String(v || '').trim();
    if (!v) return 'Pick a username.';
    if (/^\d/.test(v)) return 'Start with a letter or _ (not a number).';
    if (/\s/.test(v)) return 'No spaces. Use _ instead, e.g. rafi_21.';
    if (!USERNAME.test(v)) return v.length < 3 ? 'At least 3 characters.' : v.length > 20 ? 'At most 20 characters.' : 'Only letters, numbers and _.';
    if (!/[A-Za-z]/.test(v)) return 'Include at least one letter.';
    return null;
  }
  // photos this phone reported: hidden here at once (the admin decides for everyone)
  const hiddenAv = new Set((() => { try { return JSON.parse(localStorage.getItem('iubat_hidden_av') || '[]'); } catch { return []; } })());
  function hideAvatar(id) { hiddenAv.add(id); try { localStorage.setItem('iubat_hidden_av', JSON.stringify([...hiddenAv].slice(-100))); } catch {} }
  /** Avatar: the uploaded photo if any, else the emoji on its colour. */
  function avatar(u, size = 36, cls = '') {
    if (!u) return '';
    if (hiddenAv.has(u.id)) u = { ...u, avatarV: 0 };
    const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.56)}px`;
    if (u.avatarV) return `<span class="av ${cls}" style="${st};--c:${esc(u.color)}"><img src="api/avatar?id=${encodeURIComponent(u.id)}&v=${u.avatarV}" alt="" loading="lazy" onerror="this.remove()">${esc(u.emoji || '🚌')}</span>`;
    return `<span class="av ${cls}" style="${st};--c:${esc(u.color || '#0b6e1c')}">${esc(u.emoji || '🚌')}</span>`;
  }
  /** GitHub-style contribution graph: weeks as columns (Saturday at the top), darker = more XP that day. */
  function heatmap(heat, from) {
    const days = [], start = new Date(from + 'T00:00:00Z'), today = new Date(Date.now() + (window.Feed ? Feed.tz : 6) * 3600e3).toISOString().slice(0, 10);
    for (let d = new Date(start); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
    const max = Math.max(1, ...Object.values(heat || {}));
    const lvl = p => (!p ? 0 : p >= max * 0.75 ? 4 : p >= max * 0.5 ? 3 : p >= max * 0.25 ? 2 : 1);
    const cols = []; for (let i = 0; i < days.length; i += 7) cols.push(days.slice(i, i + 7));
    const months = cols.map((c, i) => { const m = new Date(c[0] + 'T00:00:00Z').toLocaleString('en', { month: 'short', timeZone: 'UTC' });
      const prev = i && new Date(cols[i - 1][0] + 'T00:00:00Z').toLocaleString('en', { month: 'short', timeZone: 'UTC' }); return m !== prev ? m : ''; });
    const total = Object.values(heat || {}).reduce((a, b) => a + b, 0), active = Object.keys(heat || {}).length;
    return `<div class="heat"><div class="heat-m">${months.map(m => `<span>${m}</span>`).join('')}</div>
      <div class="heat-g">${cols.map(c => `<div>${c.map(d => `<i class="h${lvl(heat?.[d])}${d === today ? ' today' : ''}" title="${d}: ${heat?.[d] || 0} XP"></i>`).join('')}</div>`).join('')}</div>
      <div class="heat-f"><span>${total} XP on ${active} day${active === 1 ? '' : 's'}</span><span class="heat-k">Less <i class="h0"></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i> More</span></div></div>`;
  }

  /** Resize a picked photo to a 128x128 centre square (WebP, JPEG fallback): a few KB. */
  async function makePhoto(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('Choose an image file.');
    let img;
    try { img = await createImageBitmap(file); }
    catch { img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Cannot read this image.')); i.src = URL.createObjectURL(file); }); }
    const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
    const w = img.width, h = img.height, side = Math.min(w, h);
    c.getContext('2d').drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, S, S);
    let url = c.toDataURL('image/webp', 0.82);
    if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', 0.85);
    return url;
  }

  const saved = local.get() || {};
  const Social = {
    token: saved.token || null, key: saved.key || null, me: saved.me || null, onChange: () => {},
    LEVELS, BADGES, EMOJIS, COLORS, level, checkName, avatar, hideAvatar, heatmap, makePhoto, esc, badgeRow,
    get joined() { return !!this.token; },

    _save() { local.set({ token: this.token, key: this.key, me: this.me }); this.onChange(this); },
    async _api(path, body, auth = true) {
      let res;
      const headers = { 'content-type': 'application/json' };
      if (auth && this.token) headers.Authorization = 'Bearer ' + this.token;
      try { res = await fetch('api/' + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers, cache: 'no-store' }); }
      catch { throw new Error('Cannot reach the server. Check your internet connection.'); }
      const j = await res.json().catch(() => ({}));
      if (res.status === 401 && auth && this.token) { this._lost(); throw new Error(j.error || 'Please pick a username again.'); }
      if (!res.ok) throw new Error(j.error || 'Something went wrong.');
      return j;
    },
    _lost() { this.token = null; this.me = null; this._save(); }, // account deleted or token invalid: keep the recovery key

    /** Refresh the cached profile (and the token when it is getting old). */
    async refresh() {
      if (!this.token) return;
      try { const j = await this._api('me'); if (j.token) this.token = j.token; this.me = j.me; this._save(); } catch {}
    },
    async join(data) { const j = await this._api('me', { action: 'join', ...data }, false); Object.assign(this, { token: j.token, key: j.key, me: j.me }); this._save(); return j; },
    async restore(key) { const j = await this._api('me', { action: 'restore', key: String(key || '').trim() }, false); Object.assign(this, { token: j.token, key: j.key, me: j.me }); this._save(); return j; },
    async act(action, data = {}) { const j = await this._api('me', { action, ...data }); if (j.key) this.key = j.key; if (j.me) this.me = j.me; this._save(); this._board = {}; return j; },
    async remove() { await this.act('delete'); this.token = null; this.key = null; this.me = null; local.del(); this.onChange(this); },
    signOut() { this.token = null; this.me = null; local.del(); this.key = null; this.onChange(this); },

    _board: {}, _users: {},
    /** Leaderboards (cached 60 s; pass force to reload). */
    async board(routeId, force) {
      const k = routeId || '*', c = this._board[k];
      if (c && !force && Date.now() - c.at < 60e3) return c.v;
      const v = await this._api('board' + (routeId ? '?route=' + encodeURIComponent(routeId) : ''), null, false);
      this._board[k] = { at: Date.now(), v }; return v;
    },
    cachedBoard(routeId) { return this._board[routeId || '*']?.v || null; },
    async user(id) {
      const c = this._users[id];
      if (c && Date.now() - c.at < 60e3) return c.v;
      const v = (await this._api('board?u=' + encodeURIComponent(id), null, false)).profile;
      this._users[id] = { at: Date.now(), v }; return v;
    },
    cachedUser(id) { return this._users[id]?.v || null; },
    async thank(busId) { return this._api('board', { action: 'thank', busId }, false); },
  };
  /* ---------- Web Push: works without an account (reminders for my route) ---------- */
  const PKEY = 'iubat_push';
  const b64ToBytes = b => { const s = atob((b + '='.repeat((4 - b.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, c => c.charCodeAt(0)); };
  const Push = {
    prefs: (() => { try { return JSON.parse(localStorage.getItem(PKEY) || 'null'); } catch { return null; } })() || { on: false, remind: true, remindPm: false, treat: false, notices: true },
    supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    /** iPhone/iPad: push works only after "Add to Home Screen" (iOS 16.4+) */
    needsInstall: () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !(matchMedia('(display-mode: standalone)').matches || navigator.standalone),
    _save() { try { localStorage.setItem(PKEY, JSON.stringify(this.prefs)); } catch {} },
    async _sub(create) {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub && create) {
        const { key } = await Social._api('push', null, false);
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      }
      return sub;
    },
    /** Turn on (asks permission) or update: route + stop decide which departure reminder you get. */
    async enable(extra = {}) {
      if (!this.supported()) throw new Error('This browser cannot show notifications.');
      if (this.needsInstall()) throw new Error('On iPhone: tap Share → Add to Home Screen, open the app from there, then turn notifications on.');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings for this site.');
      Object.assign(this.prefs, extra, { on: true }); this._save();
      return this.sync(true);
    },
    async sync(create, routeId = this.route, stop = this.stop) {
      if (!this.prefs.on || !this.supported() || Notification.permission !== 'granted') return;
      const sub = await this._sub(create); if (!sub) return;
      await Social._api('push', { action: 'subscribe', subscription: sub.toJSON(), routeId, stop, remind: !!this.prefs.remind, remindPm: !!this.prefs.remindPm, treat: !!this.prefs.treat, notices: !!this.prefs.notices });
    },
    async disable() {
      this.prefs.on = false; this._save();
      try { const sub = await this._sub(false); if (sub) { await Social._api('push', { action: 'unsubscribe', endpoint: sub.endpoint }, false).catch(() => {}); await sub.unsubscribe(); } } catch {}
    },
    async test() { const sub = await this._sub(false); if (!sub) throw new Error('Turn notifications on first.'); return Social._api('push', { action: 'test', endpoint: sub.endpoint }, false); },
    route: null, stop: null, // set by the app (my route / my stop)
  };
  Social.Push = Push;
  window.Social = Social;
})();
