(function () {
  const $ = s => document.querySelector(s);
  const local = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = Social;
  const STATUS = { running: 'Running', stopped: 'Stopped', offline: 'Offline', estimated: 'Estimated' };
  const isMobile = () => matchMedia('(max-width: 860px)').matches;
  const ICON_BUS = '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v2M16 18v2"/><circle cx="8.5" cy="14.5" r=".6" fill="currentColor"/><circle cx="15.5" cy="14.5" r=".6" fill="currentColor"/></svg>';
  const ICON_BACK = '<svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';
  const ICON_CHEV = '<svg class="i" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
  const ICON_CLOCK = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const REMIND_MIN = 20;

  // view: home | route {routeId, busId} | notices | board | me | user {userId}
  let map = null, view = { name: 'home' }, snap = [], seenNotices = new Set(local.get('iubat_seen_notices') || []), knownNotices = null;
  let myRoute = S.me?.routeId || local.get('iubat_myroute') || null;
  const myStops = local.get('iubat_mystop') || {};           // routeId -> stop name (for the morning reminder)
  let remind = !!local.get('iubat_remind');
  let boardTab = 'week', boardRoute = null;

  /* ================= start: no sign-in, the app opens straight away ================= */
  async function start() {
    renderMe();
    try { await Feed.load(); }
    catch { $('#panelBody').innerHTML = '<p class="muted-p">Cannot reach the server. Check your internet connection; retrying…</p>'; return setTimeout(start, 5000); }
    boot(); Feed.start(); map.resize();
    S.refresh(); loadBoard();
    const m = /#restore=([\w-]+)/.exec(location.hash);
    if (m) { history.replaceState(null, '', location.pathname); openRestore(m[1]); }
  }

  function boot() {
    Feed.onStatus = ok => { $('#conn').hidden = ok; };
    map = createMap();
    Feed.onRoutes = f => {
      map.setRoutes(f.routes);
      if (view.name === 'route' && view.routeId && !f.routes.some(r => r.id === view.routeId)) go({ name: 'home' });
      checkNewNotices(); refresh();
    };
    checkNewNotices();
    Share.onChange = () => render();
    Share.onXp = gain => pop(`+${gain} XP`);
    S.onChange = () => { if (S.me?.routeId) setMyRoute(S.me.routeId, true); renderMe(); celebrateNew(); if (!LIVE.has(view.name)) render(); };
    let last = performance.now();
    (function loop(now) {
      const dt = Math.min(0.2, (now - last) / 1000); last = now;
      map.setBuses(Feed.positions(dt));
      requestAnimationFrame(loop);
    })(last);
    refresh(); setInterval(refresh, 1000);
    setInterval(() => { if (!document.hidden) loadBoard(); }, 90e3);

    $('#panelBody').addEventListener('click', onClick);
    $('#panelBody').addEventListener('change', onChange);
    $('#panelBody').addEventListener('submit', onSubmit);
    $('#notices').addEventListener('click', e => {
      if (e.target.closest('[data-all]')) return go({ name: 'notices' });
      const x = e.target.closest('[data-dismiss]'); if (x) { markSeen([+x.dataset.dismiss]); renderNotices(); }
    });
    $('#bell').addEventListener('click', () => go(view.name === 'notices' ? { name: 'home' } : { name: 'notices' }));
    $('#trophy').addEventListener('click', () => go(view.name === 'board' ? { name: 'home' } : { name: 'board' }));
    $('#meBtn').addEventListener('click', () => (S.joined ? go(view.name === 'me' ? { name: 'home' } : { name: 'me' }) : openJoin()));
    $('#handle').addEventListener('click', () => setSheet(!$('#panel').classList.contains('open')));
    setSheet(true);
    addEventListener('resize', pad); pad();

    const tView = $('#tView');
    tView.addEventListener('click', () => { const top = map.isTop(); map.setView(top ? '3d' : 'top'); tView.textContent = top ? '3D' : '2D'; });
    $('#tRotL').addEventListener('click', () => map.rotate(-45));
    $('#tRotR').addEventListener('click', () => map.rotate(45));
    $('#tZin').addEventListener('click', () => map.zoom(0.5));
    $('#tZout').addEventListener('click', () => map.zoom(2));
    $('#tLoc').addEventListener('click', () => map.recenter());
  }

  /* ---------- map (loads in the background) ---------- */
  function createMap() {
    const msg = $('#mapMsg');
    const show = (text, isErr) => { msg.textContent = text; msg.className = 'map-msg' + (isErr ? ' err' : ''); msg.hidden = false; };
    show('Loading map…');
    let m;
    try { m = new BusMap($('#map'), { routes: Feed.routes, campus: Feed.campus, onSelect: openBus }); }
    catch (e) {
      show('This browser cannot show the map. Live bus times in the list still work.', true);
      const noop = () => {};
      return { setRoutes: noop, setBuses: noop, select: noop, selectRoute: noop, setPadding: noop, isTop: () => false, setView: noop, rotate: noop, zoom: noop, recenter: noop, resize: noop };
    }
    const slow = setTimeout(() => show('The map is slow to load on this connection. Live bus info in the list works meanwhile.', true), 15000);
    m.ready.then(() => { clearTimeout(slow); msg.hidden = true; });
    return m;
  }

  /* ---------- navigation ---------- */
  const LIVE = new Set(['home', 'route']); // views redrawn every second (the others only when their data changes)
  function go(v) {
    const prev = view; view = v;
    if (v.name !== 'route' && prev.name === 'route') map.select(null);
    if (v.name === 'notices') markSeen(Feed.activeNotices().map(n => n.id));
    if (v.name === 'board') loadBoard(boardRoute, true);
    if (v.name === 'me') S.refresh();
    if (v.name === 'user') S.user(v.userId).then(() => view === v && render()).catch(e => toast(e.message));
    if (isMobile()) setSheet(true);
    $('#trophy').classList.toggle('on', v.name === 'board'); $('#meBtn').classList.toggle('on', v.name === 'me');
    render(); $('#panelBody').scrollTop = 0;
  }
  function busesOn(routeId) { return snap.filter(b => b.routeId === routeId); }
  function bestBus(list) {
    const rank = b => ({ running: 0, stopped: 1, estimated: 2 }[b.status] ?? 3);
    return list.slice().sort((a, b) => rank(a) - rank(b) || (a.lastUpdateSec ?? 1e9) - (b.lastUpdateSec ?? 1e9))[0];
  }
  function openRoute(routeId, busId) {
    snap = Feed.snapshot();
    const bus = busId ? snap.find(b => b.id === busId) : bestBus(busesOn(routeId));
    go({ name: 'route', routeId, busId: bus ? bus.id : null });
    map.selectRoute(routeId, bus ? bus.id : null);
    loadBoard(routeId);
  }
  function openBus(busId) {
    snap = Feed.snapshot();
    const b = snap.find(x => x.id === busId); if (!b) return;
    if (b.routeId) return openRoute(b.routeId, busId);
    go({ name: 'route', routeId: null, busId }); map.select(busId);
  }
  function setSheet(open) {
    $('#panel').classList.toggle('open', open);
    $('#handle').setAttribute('aria-expanded', open);
    $('#handleLabel').textContent = open ? 'Show map' : (view.name === 'route' ? 'Show bus details' : 'Show routes');
    pad();
  }
  function pad() { if (map) map.setPadding(!isMobile() ? 0 : ($('#panel').classList.contains('open') ? innerHeight * 0.62 : 64)); }

  function refresh() {
    snap = Feed.snapshot();
    if (LIVE.has(view.name)) render(); else renderNotices();
    checkReminder();
  }
  function render() {
    renderNotices();
    const body = $('#panelBody'), top = body.scrollTop;
    const html = shareBar() + ({ route: routeView, notices: noticesView, board: boardView, me: meView, user: userView }[view.name] || homeView)();
    if (body._html !== html) { body.innerHTML = html; body._html = html; }
    body.scrollTop = top;
  }
  async function loadBoard(routeId, force) {
    try { await S.board(null, force); if (routeId) await S.board(routeId, force); if (!LIVE.has(view.name) || view.name === 'home') render(); }
    catch { /* offline: keep the cached board */ }
  }

  /* ---------- clicks, changes, forms inside the panel ---------- */
  async function onClick(e) {
    const t = e.target, q = s => t.closest(s);
    if (q('[data-back]')) return go(view.from || { name: 'home' });
    if (q('[data-user]')) return go({ name: 'user', userId: q('[data-user]').dataset.user, from: { ...view } });
    if (q('[data-route]')) return openRoute(q('[data-route]').dataset.route);
    if (q('[data-bus]')) return openBus(q('[data-bus]').dataset.bus);
    if (q('[data-share]')) return askShare(q('[data-share]').dataset.share);
    if (q('[data-unshare]')) return Share.stop();
    if (q('[data-gosh]')) return openBus(Share.busId);
    if (q('[data-board]')) { boardTab = q('[data-board]').dataset.board; return go({ name: 'board' }); }
    if (q('[data-tab]')) { boardTab = q('[data-tab]').dataset.tab; return render(); }
    if (q('[data-star]')) return setMyRoute(myRoute === q('[data-star]').dataset.star ? null : q('[data-star]').dataset.star);
    if (q('[data-remind]')) return toggleRemind();
    if (q('[data-join]')) return openJoin();
    if (q('[data-me]')) return go({ name: 'me' });
    if (q('[data-thank]')) return thank(q('[data-thank]').dataset.thank);
    if (q('[data-vouch]')) return run(() => S.act('vouch', { treatIds: q('[data-vouch]').dataset.vouch.split(',').map(Number) }), 'Thanks! Your confirmation is counted. ✋', true);
    if (q('[data-report]')) { if (confirm('Report this photo as inappropriate? Photos reported by several riders are hidden until the transport office reviews them.')) run(() => S.act('report', { userId: q('[data-report]').dataset.report }), 'Reported. Thank you for keeping it friendly.'); return; }
    if (q('[data-showkey]')) return showKey();
    if (q('[data-newkey]')) { if (confirm('Make a new recovery code? The old one stops working.')) run(async () => { await S.act('newKey'); showKey(); }); return; }
    if (q('[data-restore]')) return openRestore();
    if (q('[data-removephoto]')) return run(() => S.act('removePhoto'), 'Photo removed');
    if (q('[data-signout]')) { if (confirm('Sign out on this phone? You need your recovery code to get this account back.')) { S.signOut(); go({ name: 'home' }); } return; }
    if (q('[data-delete]')) { if (confirm('Delete your account, XP and badges for good? This cannot be undone.')) run(async () => { await S.remove(); go({ name: 'home' }); }, 'Account deleted'); return; }
    const em = q('[data-emoji]'); if (em) { em.closest('.emojis').querySelectorAll('[data-emoji]').forEach(x => x.setAttribute('aria-checked', x === em)); return; }
  }
  function onChange(e) {
    const t = e.target;
    if (t.matches('[data-myroute]')) return setMyRoute(t.value || null);
    if (t.matches('[data-mystop]')) { myStops[t.dataset.mystop] = t.value || undefined; local.set('iubat_mystop', myStops); return render(); }
    if (t.matches('[data-boardroute]')) { boardRoute = t.value || null; loadBoard(boardRoute); return render(); }
    if (t.matches('#photoIn')) {
      const f = t.files[0]; t.value = '';
      return run(async () => S.act('photo', { data: await S.makePhoto(f) }), 'Photo updated 📸');
    }
  }
  function onSubmit(e) {
    e.preventDefault();
    const f = e.target, v = n => f.elements[n]?.value;
    if (f.dataset.form === 'profile') {
      const name = v('username').trim(), bad = S.checkName(name);
      if (bad) return toast(bad);
      const emoji = f.querySelector('[data-emoji][aria-checked="true"]')?.dataset.emoji;
      return run(() => S.act('update', { username: name, emoji, routeId: v('route') || null, batch: v('batch').trim() }), 'Profile saved');
    }
    if (f.dataset.form === 'claim') {
      return run(() => S.act('claimTreat', { routeId: f.dataset.route, giver: v('giver') }), 'Enjoy! ☕ The route\'s reputation goes up.', true);
    }
  }
  async function run(fn, ok, reloadBoard) {
    try { await fn(); if (ok) toast(ok); if (reloadBoard) loadBoard(view.routeId || null, true); render(); }
    catch (e) { toast(e.message, true); }
  }

  /* ---------- my route + departure reminder ---------- */
  function setMyRoute(id, quiet) {
    if (myRoute === id) return;
    myRoute = id; local.set('iubat_myroute', id);
    if (!quiet && S.joined) S.act('update', { routeId: id }).catch(() => {});
    if (!quiet) toast(id ? '⭐ Saved as your route' : 'Route removed from your home');
    render();
  }
  async function toggleRemind() {
    remind = !remind; local.set('iubat_remind', remind);
    if (remind && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
    toast(remind ? `🔔 We'll remind you ${REMIND_MIN} min before your bus leaves (keep the app installed / open)` : 'Reminder off');
    render();
  }
  function checkReminder() {
    if (!remind || !myRoute) return;
    const r = Feed.routes.find(x => x.id === myRoute), b = r && bestBus(busesOn(r.id));
    const st = b && tripStatus(b, r);
    if (!st || st.kind !== 'soon') return;
    const key = 'iubat_rem_' + Feed.now().day + st.leg + new Date().toDateString(), done = local.get('iubat_reminded') || {};
    if (done[key]) return;
    done[key] = 1; local.set('iubat_reminded', Object.fromEntries(Object.entries(done).slice(-20)));
    const text = `Bus ${b.id} leaves ${st.where} in ${st.mins} min (${st.at}).`;
    flash({ level: 'info', message: '⏰ ' + text });
    if ('Notification' in window && Notification.permission === 'granted') {
      navigator.serviceWorker?.ready.then(reg => reg.showNotification('⏰ Your bus leaves soon', { body: text, icon: '/assets/icons/icon-192.png', tag: key }))
        .catch(() => { try { new Notification('⏰ Your bus leaves soon', { body: text }); } catch {} });
    }
  }
  const t12 = v => { if (!v) return null; const [h, m] = v.split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const m12 = min => t12(`${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`);
  const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Dhaka' });
  const short = n => n.replace(/^IUBAT /, '');

  /** What is this bus doing today? live / soon (leaves within 20 min) / next / due / done (arrived) / off */
  function tripStatus(b, r) {
    if (!b) return { kind: 'none', title: 'No bus assigned yet' };
    const t = Feed.now(), sc = b.schedule || {}, days = Feed.parseDays(sc.days), runs = !days || days.has(t.day);
    const am = Feed.trip(b.id, 'am'), pm = Feed.trip(b.id, 'pm'), first = r ? short(r.stops[0].name) : 'the first stop';
    const stopName = r && myStops[r.id], stop = stopName && r.stops.find(s => s.name === stopName && s.time);
    const pmDep = Feed.hm(sc.departCampus);
    if (b.status === 'running' || b.status === 'stopped')
      return { kind: 'live', title: b.inbound ? `🟢 On the way to campus · ${b.destEtaText}` : `🟢 Heading to ${short(b.to)} · ${b.destEtaText}`, sub: b.nextStop ? `Next stop ${b.nextStop.name} · ${b.nextEtaText}` : '' };
    if (pm?.state === 'arrived') return { kind: 'done', title: `✅ Reached ${first} at ${clock(pm.arrivedAt)}`, sub: 'Evening trip done. See you tomorrow!' };
    if (am?.state === 'arrived' && !(pmDep != null && t.min >= pmDep - REMIND_MIN))
      return { kind: 'done', title: `✅ Reached campus at ${clock(am.arrivedAt)}`, sub: sc.departCampus ? `Leaves campus at ${t12(sc.departCampus)}` : '' };
    if (!runs) return { kind: 'off', title: '😴 No bus today', sub: sc.days ? `Runs ${sc.days}` : '' };
    const legs = [
      { leg: 'am', dep: stop ? Feed.hm(stop.time) : Feed.hm(sc.departStart), where: stop ? stop.name : first, trip: am },
      { leg: 'pm', dep: pmDep, where: 'campus', trip: pm },
    ];
    for (const L of legs) {
      if (L.dep == null || L.trip?.state === 'arrived') continue;
      const mins = L.dep - t.min, at = m12(L.dep);
      if (mins > REMIND_MIN) return { kind: 'next', leg: L.leg, title: `Next: leaves ${L.where} at ${at}`, sub: L.leg === 'am' ? 'Morning trip to campus' : 'Evening trip home' };
      if (mins > 0) return { kind: 'soon', leg: L.leg, mins: Math.ceil(mins), where: L.where, at, title: `⏰ Leaves ${L.where} in ${Math.ceil(mins)} min`, sub: `at ${at} · ${L.leg === 'am' ? 'to campus' : 'from campus'}` };
      if (mins > -100) return { kind: 'due', leg: L.leg, title: b.status === 'estimated' ? `On the way (estimated) · ${b.destEtaText}` : `Should have left ${L.where} at ${at}`, sub: 'No live signal yet. On the bus? Share its location!' };
    }
    return { kind: 'off', title: 'No more trips today', sub: sc.departStart ? `Next: leaves ${first} at ${t12(sc.departStart)}` : '' };
  }

  /* ---------- notices ---------- */
  function markSeen(ids) { ids.forEach(i => seenNotices.add(i)); local.set('iubat_seen_notices', [...seenNotices].slice(-200)); }
  function checkNewNotices() {
    const list = Feed.activeNotices(), ids = new Set(list.map(n => n.id));
    if (knownNotices) { const fresh = list.filter(n => !knownNotices.has(n.id)); if (fresh.length) flash(fresh[0]); }
    knownNotices = ids;
  }
  let flashT;
  function flash(n) {
    const t = $('#ntoast');
    t.className = 'ntoast ' + n.level; const title = n.title ?? (n.level === 'urgent' ? 'Urgent notice' : 'New notice');
    t.innerHTML = `${title ? `<b>${esc(title)}</b>` : ''}${esc(n.message)}`;
    t.hidden = false; clearTimeout(flashT); flashT = setTimeout(() => (t.hidden = true), 8000);
  }
  const toast = (message, bad) => flash({ level: bad ? 'urgent' : 'info', title: bad ? 'Oops' : '', message });
  function renderNotices() {
    const list = Feed.activeNotices(), unread = list.filter(n => !seenNotices.has(n.id));
    const cnt = $('#bellCount'); cnt.hidden = !unread.length; cnt.textContent = unread.length;
    $('#bell').classList.toggle('on', view.name === 'notices');
    const n = unread[0];
    const html = (!n || view.name === 'notices') ? '' :
      `<div class="notice ${n.level}"><div><b>${n.level === 'urgent' ? 'Urgent' : 'Notice'}</b><p>${esc(n.message)}</p>${list.length > 1 ? `<button class="link" data-all>View all ${list.length} notices</button>` : ''}</div><button class="x" data-dismiss="${n.id}" aria-label="Dismiss notice">&times;</button></div>`;
    const el = $('#notices'); if (el.innerHTML !== html) el.innerHTML = html;
  }
  function noticesView() {
    const list = Feed.activeNotices();
    return `<button class="ghost back" data-back>${ICON_BACK} Home</button><div class="section-title">Notices</div>` +
      (list.length ? list.map(n => `<article class="nitem ${n.level}"><span class="pill ${n.level === 'urgent' ? 'urgent' : 'info'}">${n.level === 'urgent' ? 'Urgent' : 'Notice'}</span><p>${esc(n.message)}</p><time>${when(n.createdAt)}</time></article>`).join('')
        : '<p class="muted-p">No notices right now.</p>');
  }
  const when = ts => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

  /* ---------- formatting ---------- */
  const fmt = m => (m < 1 ? 'Now' : Math.ceil(m) + ' min');
  const lastSeen = b => b.lastUpdateSec == null ? 'No data yet' : b.lastUpdateSec < 90 ? b.lastUpdateSec + ' s ago' : Math.round(b.lastUpdateSec / 60) + ' min ago';
  function schedLine(b) {
    const s = b.schedule || {}, parts = [];
    if (s.departStart) parts.push(`Leaves ${esc(short(b.from === Feed.campus.name ? b.to : b.from))} ${t12(s.departStart)}`);
    if (s.departCampus) parts.push(`Leaves campus ${t12(s.departCampus)}`);
    if (!parts.length) return '';
    return parts.join(' · ') + (s.days ? ` · ${esc(s.days)}` : '');
  }
  const dirText = b => (b.inbound ? 'Inbound · to campus' : 'Outbound · from campus');
  const routeName = id => Feed.routes.find(r => r.id === id)?.name || '';
  const at = u => `<b class="uname">@${esc(u.username)}</b>`;

  /* ---------- crowd sharing ---------- */
  function askShare(busId) {
    if (!S.joined) return openJoin(() => askShare(busId));
    const dlg = $('#shareDlg');
    dlg.returnValue = '';
    dlg.onclose = () => { if (dlg.returnValue === 'yes') Share.start(busId, S.token); };
    dlg.showModal();
  }
  const SH_CLASS = { verified: 'ok', backup: 'ok', checking: 'wait', starting: 'wait', weak_gps: 'wait', paused: 'wait', off_route: 'bad', jump: 'bad', disagree: 'bad', wrong_way: 'bad' };
  function shareBar() {
    if (!Share.active && !Share.message) return '';
    if (!Share.active) return `<div class="sharebar ${Share.error ? 'bad' : 'ok'}"><p>${esc(Share.message)}</p></div>`;
    const cls = SH_CLASS[Share.status] || 'wait';
    const fun = Share.xp || Share.thanks ? `<span class="sb-fun">${Share.xp ? `⚡ ${Share.xp} XP this ride` : ''}${Share.thanks ? ` · 🙏 ${Share.thanks} thanks` : ''}</span>` : '';
    return `<div class="sharebar ${cls}"><div><b>Sharing for Bus ${esc(Share.busId)}</b><p>${esc(Share.message)}</p>${fun}</div>
      <span class="sb-act">${view.name !== 'route' || view.busId !== Share.busId ? '<button class="link" data-gosh>View</button>' : ''}<button class="btn-stop" data-unshare>Stop</button></span></div>`;
  }
  function shareCta(b) {
    if (!Feed.crowdEnabled || b.noRoute || Share.active) return '';
    const leg = Feed.legNow(), w = Feed.windows;
    if (!leg) return `<div class="sharecta off"><p>📍 Riders can share this bus from <b>${m12(w.am[0])}</b> until it reaches campus, and from <b>${m12(w.pm[0])}</b> until it reaches the end of its route.</p></div>`;
    const tr = Feed.trip(b.id, leg);
    if (tr?.state === 'arrived') return `<div class="sharecta off"><p>✅ This trip is done (${leg === 'am' ? 'reached campus' : 'reached the end of the route'} at ${clock(tr.arrivedAt)}). Sharing opens again ${leg === 'am' ? `at ${m12(w.pm[0])}` : 'tomorrow morning'}.</p></div>`;
    const riders = Feed.riders[b.id] || 0;
    return `<div class="sharecta"><div><b>On this bus? Be the hero 🦸</b><p>${riders ? `${riders} rider${riders > 1 ? 's are' : ' is'} sharing. Join as backup and earn XP.` : `Share your location so everyone can see where Bus ${esc(b.id)} is${b.status === 'offline' || b.status === 'estimated' ? ' (no live signal right now)' : ''}. Earn XP!`}</p></div><button class="btn primary sm" data-share="${esc(b.id)}">Share location</button></div>`;
  }
  function thankBtn(b) {
    const leg = Feed.legNow(), tr = leg && Feed.trip(b.id, leg);
    if (!tr || !(Feed.riders[b.id] > 0) || Share.busId === b.id) return '';
    const mine = (local.get('iubat_thanked') || {})[`${b.id}:${Feed.now().day}:${leg}`];
    return `<button class="thank ${mine ? 'done' : ''}" data-thank="${esc(b.id)}" ${mine ? 'disabled' : ''}>🙏 ${mine ? 'Thanked' : 'Thank the rider sharing'} <b>${tr.thanks || 0}</b></button>`;
  }
  async function thank(busId) {
    const k = `${busId}:${Feed.now().day}:${Feed.legNow()}`, t = local.get('iubat_thanked') || {};
    if (t[k]) return;
    t[k] = 1; local.set('iubat_thanked', Object.fromEntries(Object.entries(t).slice(-30)));
    try { const j = await S.thank(busId); const tr = Feed.trip(busId, Feed.legNow()); if (tr && j.thanks) tr.thanks = j.thanks; pop('🙏'); } catch (e) { toast(e.message, true); }
    render();
  }
  const srcText = b => (b.source === 'crowd' ? 'via a rider on board' : b.source === 'schedule' ? 'estimated from the timetable' : 'via bus GPS');

  /* ================= Home ================= */
  function homeView() {
    return myRouteCard() + leadersStrip() + (myRoute ? treatBanner(myRoute) : '') + routesList();
  }
  function myRouteCard() {
    const r = myRoute && Feed.routes.find(x => x.id === myRoute);
    if (!r) return `<label class="pickroute"><span>⭐ <b>Pick your route</b> for a reminder ${REMIND_MIN} min before your bus leaves</span>
      <select data-myroute aria-label="My route"><option value="">Choose…</option>${Feed.routes.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>`;
    const b = bestBus(busesOn(r.id)), st = tripStatus(b, r);
    return `<div class="mycard ${st.kind}" style="--route:${esc(r.color)}">
      <button class="mc-main" data-route="${esc(r.id)}"><small>⭐ My route · ${esc(r.name)}${b ? ` · Bus ${esc(b.id)}` : ''}</small>
        <strong>${esc(st.title)}</strong>${st.sub ? `<span>${esc(st.sub)}</span>` : ''}${st.kind === 'soon' ? `<i class="mc-bar" style="--p:${(1 - st.mins / REMIND_MIN) * 100}%"></i>` : ''}</button>
      <button class="mc-bell ${remind ? 'on' : ''}" data-remind aria-pressed="${remind}" title="Remind me ${REMIND_MIN} min before">${remind ? '🔔' : '🔕'}</button></div>`;
  }
  function leadersStrip() {
    const B = S.cachedBoard(null);
    const card = (u, label, tab, empty) => `<button class="lcard" data-board="${tab}">${u ? S.avatar(u, 40) : '<span class="av ghosty">?</span>'}
      <span><small>${label}</small><b>${u ? '@' + esc(u.username) : esc(empty)}</b><em>${u ? `${u.pts} XP · ${esc(routeName(u.routeId) || 'any route')}` : 'Share your bus to get here'}</em></span></button>`;
    return `<div class="leaders">${card(B?.today[0], "🏆 Today's top", 'today', 'Could be you!')}${card(B?.weekTop[0], "👑 This week's best", 'week', 'Still open!')}</div>`;
  }
  function routesList() {
    const routes = Feed.routes;
    if (!routes.length && !snap.length) return '<p class="section-title">No routes have been set up yet.</p>';
    const live = snap.filter(b => b.status === 'running' || b.status === 'stopped').length;
    const rep = S.cachedBoard(null)?.reputation || {};
    let html = `<div class="section-title">Routes · ${live} bus${live === 1 ? '' : 'es'} live</div>`;
    html += routes.map(r => {
      const list = busesOn(r.id), b = bestBus(list), st = b && tripStatus(b, r), riders = list.reduce((n, x) => n + (Feed.riders[x.id] || 0), 0);
      const origin = r.stops[0]?.name || r.name, R = rep[r.id];
      let liveLine = !b ? '<span class="muted-s">No bus assigned yet</span>'
        : st.kind === 'done' ? `<span class="pill done">${esc(st.title)}</span>`
        : st.kind === 'soon' ? `<span class="pill soon">${esc(st.title)}</span>`
        : b.status === 'offline' ? `<span class="pill offline">Bus ${esc(b.id)} · Offline</span>`
        : b.status === 'estimated' ? `<span class="pill estimated">Bus ${esc(b.id)} · Estimated</span><span class="muted-s">${dirText(b)} · ${b.destEtaText}</span>`
        : `<span class="pill ${b.status}">Bus ${esc(b.id)} · ${STATUS[b.status]}</span><span class="muted-s">${dirText(b)}${b.destEtaText !== '—' ? ' · ' + b.destEtaText : ''}</span>`;
      if (riders) liveLine += `<span class="pill riders">👥 ${riders} sharing</span>`;
      const sched = b ? schedLine(b) : '';
      return `<button class="rcard${r.id === myRoute ? ' mine' : ''}" data-route="${esc(r.id)}" style="--route:${esc(r.color)}">
        <span class="rbar"></span>
        <span class="rmain">
          <h3>${r.id === myRoute ? '⭐ ' : ''}${esc(r.name)}${R && R.stingy ? ' <span class="kipta" title="Treat overdue">🥲</span>' : ''}</h3>
          <span class="rsub">${esc(short(origin))} <span class="arrow">⇄</span> Campus${list.length ? ` · Bus ${list.map(x => esc(x.id)).join(', ')}` : ''}</span>
          ${sched ? `<span class="rsched">${ICON_CLOCK}${sched}</span>` : ''}
          <span class="rlive">${liveLine}</span>
        </span>
        <span class="chev">${ICON_CHEV}</span>
      </button>`;
    }).join('');
    const loose = snap.filter(b => !b.routeId);
    if (loose.length) html += `<div class="section-title">Other buses</div>` + loose.map(b => `
      <button class="rcard" data-bus="${esc(b.id)}" style="--route:#9aa29b"><span class="rbar"></span>
        <span class="rmain"><h3>Bus ${esc(b.id)}</h3><span class="rsub">No route assigned yet</span><span class="rlive"><span class="pill ${b.status}">${STATUS[b.status]}</span></span></span>
        <span class="chev">${ICON_CHEV}</span></button>`).join('');
    return html;
  }

  /* ---------- treats: champion's tea/coffee, route reputation ---------- */
  const stars = n => `<span class="stars" style="--p:${(n / 5) * 100}%" aria-label="${n} out of 5">★★★★★</span>`;
  const repLabel = n => (n >= 4.5 ? 'Royal seniors 👑' : n >= 3.5 ? 'Decent seniors 🙂' : n >= 2.5 ? 'Hmm… 🤨' : 'Kipta alert 🥲');
  function treatBanner(routeId) {
    const B = S.cachedBoard(null), R = B?.reputation?.[routeId];
    if (!R || !R.owed.length) return '';
    const r = Feed.routes.find(x => x.id === routeId), me = S.me;
    const member = me && me.routeId === routeId;
    return R.owed.map(o => {
      // invited: the most senior riders of the route, senior to the champion when the champion's batch is known
      const seniors = (B.seniors[routeId] || []).filter(s => s.id !== o.champion.id && (o.champion.batch == null || s.batch < o.champion.batch)).slice(0, 3);
      const days = Math.floor((Date.now() - o.since) / 864e5), mine = me && me.id === o.champion.id;
      const vote = member && !mine ? `<button class="btn ghost-b sm" data-vouch="${o.treatIds.join(',')}">✋ I saw the treat happen <b>${o.votes}/${R.needed}</b></button>` : '';
      if (mine) return `<div class="treat me"><span class="tbig">👑</span><div><b>You're the champion of ${esc(r?.name || '')}!</b>
        <p>☕×${o.cups} invitation waiting from the most senior riders. Got treated? Confirm it in your profile.</p><button class="btn primary sm" data-me>Claim my treat</button></div></div>`;
      if (o.overdue && (R.roast || member))
        return `<div class="treat roast"><span class="tbig">📣</span><div><b>Weekly treat report · ${esc(r?.name || '')}</b>
          <p>Seniors of this route are kipta (stingy) 🥲 holding a junior's treat hostage: ${at(o.champion)} still waits for ☕×${o.cups} after ${days} days.
          Generosity ${stars(R.rating)} <b>${R.rating.toFixed(1)}</b></p>${seniors.length ? `<p class="small">Seniors on duty: ${seniors.map(s => `${at(s)} <span class="muted-s">(Batch ${s.batch})</span>`).join(', ')}</p>` : ''}${vote}</div></div>`;
      return `<div class="treat"><span class="tbig">☕</span><div><b>${at(o.champion)} is ${esc(r?.name || '')}'s champion!</b>
        <p>Invitation: tea or coffee ×${o.cups} from the most senior rider on the bus${seniors.length ? `, e.g. ${seniors.map(s => `${at(s)} <span class="muted-s">(Batch ${s.batch})</span>`).join(', ')}` : ''}. Seniors, it's cha time!</p>${vote}</div></div>`;
    }).join('');
  }
  function reputationLine(routeId) {
    const R = S.cachedBoard(null)?.reputation?.[routeId];
    if (!R) return `<div class="repline">${stars(5)} <span>Generosity 5.0 · no treats due yet</span></div>`;
    return `<div class="repline ${R.stingy ? 'bad' : ''}">${stars(R.rating)} <span>Generosity ${R.rating.toFixed(1)} · ${repLabel(R.rating)}${R.good ? ` · ${R.good} treat${R.good > 1 ? 's' : ''} given` : ''}</span></div>`;
  }

  /* ================= One route ================= */
  function routeView() {
    const back = `<button class="ghost back" data-back>${ICON_BACK} Home</button>`;
    const r = view.routeId && Feed.routes.find(x => x.id === view.routeId);
    const list = r ? busesOn(r.id) : snap.filter(b => b.id === view.busId);
    const b = list.find(x => x.id === view.busId) || bestBus(list);
    const title = r ? esc(r.name) : `Bus ${esc(view.busId)}`;
    let html = back + `<div class="r-head" style="--route:${r ? esc(r.color) : '#9aa29b'}"><span class="rbar"></span><div class="grow1"><h2>${title}</h2>
      <span class="rsub">${r ? `${esc(short(r.stops[0].name))} <span class="arrow">⇄</span> IUBAT Campus` : 'No route assigned yet'}</span></div>
      ${r ? `<button class="star ${myRoute === r.id ? 'on' : ''}" data-star="${esc(r.id)}" aria-pressed="${myRoute === r.id}">${myRoute === r.id ? '★ My route' : '☆ My route'}</button>` : ''}</div>`;
    if (r) html += reputationLine(r.id) + treatBanner(r.id);
    if (list.length > 1) html += `<div class="seg" role="tablist">${list.map(x => `<button role="tab" data-bus="${esc(x.id)}" aria-selected="${x.id === b.id}"><i class="dot ${({ running: 'run', stopped: 'stop', estimated: 'est' })[x.status] || 'off'}"></i>Bus ${esc(x.id)}</button>`).join('')}</div>`;
    if (!b) return html + `<p class="muted-p">No bus is assigned to this route yet.</p>` + (r ? stopsOnly(r) : '');
    const sched = schedLine(b), st = tripStatus(b, r);
    if (sched) html += `<div class="sched">${ICON_CLOCK}<span>${sched}</span></div>`;
    if (st.kind === 'soon' || st.kind === 'done') html += `<div class="tripchip ${st.kind}"><b>${esc(st.title)}</b>${st.sub ? `<span>${esc(st.sub)}</span>` : ''}</div>`;
    if (r && myRoute === r.id) html += remindRow(r);
    return html + busDetail(b, r) + (r ? routeTop(r.id) : '');
  }
  function remindRow(r) {
    const timed = r.stops.filter(s => s.time);
    return `<div class="remindrow"><button class="mc-bell ${remind ? 'on' : ''}" data-remind aria-pressed="${remind}">${remind ? '🔔' : '🔕'}</button>
      <span>${remind ? `Reminder ${REMIND_MIN} min before it leaves` : `Remind me ${REMIND_MIN} min before it leaves`}</span>
      ${timed.length ? `<select data-mystop="${esc(r.id)}" aria-label="My stop"><option value="">from the first stop</option>${timed.map(s => `<option ${myStops[r.id] === s.name ? 'selected' : ''} value="${esc(s.name)}">at ${esc(s.name)} (${t12(s.time)})</option>`).join('')}</select>` : ''}</div>`;
  }
  function routeTop(routeId) {
    const B = S.cachedBoard(routeId); if (!B) return '';
    const list = B.weekTop.slice(0, 3);
    return `<div class="section-title">This week on this route</div>` + (list.length ? `<ol class="mini">${list.map((u, i) => `<li><button data-user="${esc(u.id)}">${['🥇', '🥈', '🥉'][i]} ${S.avatar(u, 28)} ${at(u)}<span>${u.pts} XP</span></button></li>`).join('')}</ol>`
      : '<p class="muted-p">Nobody has shared this week yet. First come, first crowned 👑</p>') + `<button class="link more" data-board="week">Full leaderboard ›</button>`;
  }
  const stopsOnly = r => `<div class="section-title">Route stops</div><ol class="timeline">${r.stops.map(s => `<li class="upcoming"><i></i><div class="nm"><span>${esc(s.name)}</span><span class="tm">${s.time ? t12(s.time) : ''}</span></div></li>`).join('')}</ol>`;

  function busDetail(b, r) {
    const head = `<div class="d-head"><span class="badge ${b.status}">${esc(b.id)}</span><div><h2>Bus ${esc(b.id)}</h2><span class="pill ${b.status}">${STATUS[b.status]}${b.atStop && b.status === 'stopped' ? ' · ' + esc(b.atStop) : ''}</span>${(b.noRoute || b.noData) ? '' : ` <span class="pill dir">${dirText(b)}</span>`}</div></div>`;
    if (b.noData) return head + shareCta(b) + `<p class="muted-p">No live location yet. It appears as soon as the bus phone or a rider on board shares.</p>` + (r ? stopsOnly(r) : '');
    if (b.noRoute) return head + `<p class="muted-p">No route assigned yet. Live position is shown on the map.</p>`;
    const off = b.status === 'offline', est = b.status === 'estimated';
    const next = off ? 'Offline' : (b.nextStop ? esc(b.nextStop.name) : 'Arrived');
    const estNote = est ? `<div class="estnote"><b>No live signal right now.</b> This position is estimated from the timetable (left ${esc(short(b.from))} at ${t12(b.estDepart)}${b.estByStops ? ', following the stop pick-up times' : ', assuming about 22 km/h'}). The real bus may be ahead or behind.</div>` : '';
    return `${head}${estNote}
      <div class="journey">
        <div class="j-ends"><div><small>From</small><b>${esc(b.from)}</b></div><div class="to"><small>To</small><b>${esc(b.to)}</b></div></div>
        <div class="track" aria-hidden="true"><div class="fill" style="width:${(b.progress * 100).toFixed(1)}%"></div><div class="bus" style="left:${(b.progress * 100).toFixed(1)}%">${ICON_BUS}</div></div>
        <div class="j-foot">${off ? '<b>No signal</b> · last seen ' + lastSeen(b) : '<b>' + (b.inbound ? 'Heading to campus' : 'Leaving campus') + '</b> · ' + srcText(b)}</div>
      </div>
      ${thankBtn(b)}${shareCta(b)}
      <div class="stats">
        <div class="stat hot"><small>Arrives in</small><strong>${b.destEtaText}</strong></div>
        <div class="stat warm"><small>Next stop</small><strong style="font-size:16px">${next}</strong>${!off && b.nextStop ? `<em> · ${b.nextEtaText}</em>` : ''}</div>
        <div class="stat"><small>Speed</small><strong>${est ? '—' : `${b.speedKmh} <em>km/h</em>`}</strong></div>
        <div class="stat"><small>${est ? 'Last live signal' : 'Last update'}</small><strong style="font-size:16px">${lastSeen(b)}</strong></div>
      </div>
      <div class="section-title">Route stops</div>
      <ol class="timeline">
        ${b.stops.map(s => `
          <li class="${s.state}"><i></i>
            <div class="nm"><span>${esc(s.name)}${s.state === 'here' ? ' <span class="tag">Here</span>' : ''}${s.state === 'next' ? ' <span class="tag">Next</span>' : ''}${r && myStops[r.id] === s.name ? ' <span class="tag mine">My stop</span>' : ''}${s.time && b.inbound ? `<small class="sched-t">${t12(s.time)}</small>` : ''}</span>
              <span class="tm">${s.state === 'passed' ? 'Passed' : s.state === 'here' ? 'Now' : off ? '' : fmt(s.etaMin)}</span></div>
          </li>`).join('')}
      </ol>`;
  }

  /* ================= Leaderboard ================= */
  function boardView() {
    const B = S.cachedBoard(boardRoute);
    const tabs = [['today', 'Today'], ['week', 'This week'], ['all', 'All time']];
    let html = `<button class="ghost back" data-back>${ICON_BACK} Home</button>
      <div class="bhead"><h2>🏆 Leaderboard</h2><select data-boardroute aria-label="Route"><option value="">All routes</option>${Feed.routes.map(r => `<option value="${esc(r.id)}" ${boardRoute === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
      <div class="seg tabs3" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${boardTab === k}">${l}</button>`).join('')}</div>`;
    if (!B) return html + '<p class="muted-p">Loading…</p>';
    const list = { today: B.today, week: B.weekTop, all: B.allTime }[boardTab] || [];
    html += list.length ? `<ol class="board">${list.map((u, i) => {
      const L = S.level(u.xp), me = S.me && S.me.id === u.id;
      return `<li class="${me ? 'me' : ''} ${i < 3 ? 'top' + (i + 1) : ''}"><button data-user="${esc(u.id)}">
        <span class="rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span>${S.avatar(u, 40)}
        <span class="who"><b>@${esc(u.username)}${me ? ' <em>you</em>' : ''}</b><small>Lv ${L.n} ${esc(L.name)}${!boardRoute && u.routeId ? ' · ' + esc(routeName(u.routeId)) : ''}</small></span>
        <span class="pts"><b>${u.pts}</b><small>XP · ${u.km} km</small></span></button></li>`;
    }).join('')}</ol>` : `<div class="emptyboard"><span>🏁</span><p>${boardTab === 'today' ? 'Nobody has shared today yet.' : 'No contributions yet.'} Share your bus location to take the #1 spot!</p></div>`;
    if (!S.joined) html += `<div class="joincta"><div><b>Want your name here?</b><p>Pick a username, share your bus, earn XP. No password needed.</p></div><button class="btn primary sm" data-join>Join</button></div>`;
    html += `<details class="howto"><summary>How do I earn XP?</summary><ul>
      <li>⚡ <b>10 XP per km</b> you share while the bus moves (checked automatically).</li>
      <li>🚩 <b>+5</b> for being the first rider to share a trip; 🏁 <b>+15</b> for sharing it to the end.</li>
      <li>🛟 Half XP while you are a backup (bus phone or another rider is already live).</li>
      <li>👑 The weekly #1 of each route (Sat–Fri) wins a badge and a ☕ invitation from the most senior riders.</li></ul></details>`;
    if (B.champions.length) html += `<div class="section-title">👑 Hall of champions</div><ol class="mini">${B.champions.slice(0, 8).map(c => `<li><button data-user="${esc(c.user.id)}">${S.avatar(c.user, 28)} ${at(c.user)}<span>${esc(routeName(c.routeId))} · week of ${new Date(c.week + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</span></button></li>`).join('')}</ol>`;
    const reps = Feed.routes.map(r => [r, B.reputation?.[r.id]]).filter(([r]) => !boardRoute || r.id === boardRoute);
    html += `<div class="section-title">☕ Treat tracker · route reputation</div>` + reps.map(([r, R]) => `<div class="repcard" style="--route:${esc(r.color)}"><b>${esc(r.name)}</b>
      ${stars(R ? R.rating : 5)} <span class="muted-s">${R ? `${R.rating.toFixed(1)} · ${repLabel(R.rating)}` : '5.0 · no treats due yet'}</span>
      ${R && R.owed.length ? `<p>${R.owed.map(o => `${at(o.champion)} waits for ☕×${o.cups}${o.overdue ? ' <span class="late">overdue</span>' : ''}`).join(' · ')}</p>` : ''}
      ${R && R.given.length ? `<p class="muted-s">Last treat: ${esc(R.given[0].giver ? '@' + R.given[0].giver : 'confirmed by riders')} → @${esc(R.given[0].champion)}</p>` : ''}</div>`).join('');
    return html;
  }

  /* ================= Profiles ================= */
  function profileCard(p, self) {
    const L = S.level(p.xp);
    const owned = new Set(p.badges);
    const badges = Object.entries(S.BADGES).map(([id, [e, n, d]]) => `<li class="${owned.has(id) ? 'got' : ''}" title="${esc(d)}"><span>${e}</span><b>${esc(n)}</b><small>${esc(d)}</small></li>`).join('');
    return `<div class="pcard" style="--c:${esc(p.color)}">${S.avatar(p, 76, 'big')}
        <div><h2>@${esc(p.username)}</h2>
          <div class="chips2">${owned.has('contributor') ? '<span class="chip2 contrib">🤝 Contributor</span>' : '<span class="chip2">New rider</span>'}${p.champion.length ? `<span class="chip2 gold">👑 Champion ×${p.champion.length}</span>` : ''}${p.batch ? `<span class="chip2">Batch ${p.batch}</span>` : ''}${p.routeId ? `<span class="chip2">${esc(routeName(p.routeId))}</span>` : ''}</div></div></div>
      <div class="lvl"><div class="lvl-top"><b>Lv ${L.n} · ${esc(L.name)}</b><span>${p.xp}${L.to ? ` / ${L.to}` : ''} XP</span></div><div class="lvl-bar"><i style="width:${L.pct}%"></i></div>
        <small>${L.next ? `${L.to - p.xp} XP to ${esc(L.next)}` : 'Max level. Absolute legend.'}</small></div>
      <div class="stats s4"><div class="stat"><small>This week</small><strong>${p.week}</strong></div><div class="stat"><small>Shared</small><strong>${p.km}<em> km</em></strong></div>
        <div class="stat"><small>Trips</small><strong>${p.trips}</strong></div><div class="stat"><small>Streak</small><strong>${p.streak ? '🔥' + p.streak : '0'}</strong></div></div>
      <div class="section-title">Contributions</div>${S.heatmap(p.heat, p.heatFrom)}
      <div class="section-title">Badges · ${owned.size}/${Object.keys(S.BADGES).length}</div><ul class="badges">${badges}</ul>`;
  }
  function userView() {
    const p = S.cachedUser(view.userId);
    const back = `<button class="ghost back" data-back>${ICON_BACK} Back</button>`;
    if (!p) return back + '<p class="muted-p">Loading…</p>';
    const self = S.me && S.me.id === p.id;
    return back + profileCard(p, self) + (p.avatarV && S.joined && !self ? `<button class="link report" data-report="${esc(p.id)}">Report photo</button>` : '');
  }
  function meView() {
    const back = `<button class="ghost back" data-back>${ICON_BACK} Home</button>`;
    const p = S.me;
    if (!p) return back + `<div class="joincta"><div><b>You haven't joined yet</b><p>Pick a username to share your bus and earn XP.</p></div><button class="btn primary sm" data-join>Join</button></div>`;
    let html = back + profileCard(p, true);
    html += (p.owed || []).map(o => `<form class="claim" data-form="claim" data-route="${esc(o.routeId)}"><span class="tbig">☕</span><div>
      <b>You're owed ☕×${o.cups} on ${esc(routeName(o.routeId))}!</b><p>Got your tea/coffee from a senior? Enter their username to confirm. The route's reputation goes up.</p>
      <div class="inrow"><input name="giver" placeholder="senior's username" autocapitalize="off" spellcheck="false" required><button class="btn primary sm">I got my treat</button></div></div></form>`).join('');
    if (p.shareBlocked) html += `<p class="estnote">Location sharing is turned off for your account by the transport office.</p>`;
    if (p.photoHidden) html += `<p class="estnote">Your photo is hidden until the transport office reviews it.</p>`;
    html += `<details class="edit" open><summary>Edit profile</summary><form data-form="profile" class="pform">
      <label class="field"><span>Username</span><input name="username" value="${esc(p.username)}" maxlength="20" autocapitalize="off" spellcheck="false">
        <small class="fhint">${p.renameAfter > Date.now() ? `Next change possible on ${new Date(p.renameAfter).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'Letters, numbers and _; must start with a letter or _. You can change it once a week.'}</small></label>
      <div class="field"><span>Avatar</span><div class="emojis">${emojiGrid(p.emoji)}</div></div>
      <div class="row2"><label class="field"><span>My route</span><select name="route"><option value="">—</option>${Feed.routes.map(r => `<option value="${esc(r.id)}" ${p.routeId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Batch</span><input name="batch" value="${esc(p.batch ?? '')}" inputmode="numeric" maxlength="4" placeholder="e.g. 2023"></label></div>
      <div class="photo-row">${p.noPhoto ? '<span class="muted-s">Photo uploads are turned off for your account.</span>'
        : `<label class="btn ghost-b sm">📸 ${p.avatarV ? 'Change photo' : 'Add a small photo'}<input type="file" id="photoIn" accept="image/*" hidden></label>${p.avatarV ? '<button type="button" class="link" data-removephoto>Remove photo</button>' : ''}`}</div>
      <small class="fhint">Photos are cut to a small square and shown on the leaderboard. Keep it friendly: rude photos get removed and uploads disabled.</small>
      <button class="btn primary">Save</button></form></details>
    <details class="edit"><summary>🔑 Recovery code & this phone</summary><div class="pform">
      <p class="small">No password: your account lives on this phone. Save the recovery code to use it on another phone.</p>
      <div class="inrow"><button class="btn ghost-b sm" data-showkey>Show recovery code</button><button class="btn ghost-b sm" data-newkey>Make a new code</button></div>
      <div class="inrow"><button class="link" data-signout>Sign out on this phone</button><button class="link danger" data-delete>Delete account</button></div></div></details>`;
    return html;
  }
  const emojiGrid = sel => S.EMOJIS.map(e => `<button type="button" role="radio" data-emoji="${e}" aria-checked="${e === sel}">${e}</button>`).join('');

  /* ---------- top bar profile button, celebrations ---------- */
  function renderMe() {
    const b = $('#meBtn');
    b.innerHTML = S.me ? S.avatar(S.me, 30) : '<span>Join</span>';
    b.classList.toggle('joined', !!S.me);
    b.setAttribute('aria-label', S.me ? `My profile (@${S.me.username})` : 'Join as contributor');
  }
  function celebrateNew() {
    const p = S.me; if (!p) return;
    const prev = local.get('iubat_prog') || { lvl: S.level(p.xp).n, badges: p.badges };
    const L = S.level(p.xp), fresh = p.badges.filter(x => !prev.badges.includes(x));
    if (L.n > prev.lvl) celebrate(`Level up! Lv ${L.n} · ${L.name}`);
    else if (fresh.length) celebrate(`New badge: ${S.BADGES[fresh[0]][0]} ${S.BADGES[fresh[0]][1]}`);
    local.set('iubat_prog', { lvl: L.n, badges: p.badges });
  }
  function celebrate(text) {
    const fx = $('#xpfx');
    fx.innerHTML = `<div class="burst">${Array.from({ length: 16 }, (_, i) => `<i style="--a:${i * 22.5}deg;--d:${60 + (i % 3) * 30}px">${['🎉', '⭐', '✨', '🚌', '🔥', '☕'][i % 6]}</i>`).join('')}</div><div class="cele">${esc(text)}</div>`;
    fx.className = 'xpfx show'; clearTimeout(fx._t); fx._t = setTimeout(() => (fx.className = 'xpfx'), 3200);
  }
  function pop(text) {
    const el = document.createElement('div'); el.className = 'xppop'; el.textContent = text;
    document.body.appendChild(el); setTimeout(() => el.remove(), 1600);
  }

  /* ---------- join / recovery dialogs ---------- */
  let afterJoin = null, tsToken = null, tsLoaded = false;
  function openJoin(then) {
    afterJoin = then || null;
    const dlg = $('#joinDlg');
    $('#jEmoji').innerHTML = emojiGrid(S.EMOJIS[Math.floor(Math.random() * S.EMOJIS.length)]);
    $('#jRoute').innerHTML = `<option value="">—</option>` + Feed.routes.map(r => `<option value="${esc(r.id)}" ${(view.routeId || myRoute) === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    $('#jErr').hidden = true;
    if (Feed.turnstile) loadTurnstile();
    dlg.showModal(); setTimeout(() => $('#jName').focus(), 50);
  }
  function loadTurnstile() {
    const render = () => { $('#jTs').innerHTML = ''; window.turnstile.render('#jTs', { sitekey: Feed.turnstile, callback: t => (tsToken = t) }); };
    if (window.turnstile) return render();
    if (tsLoaded) return; tsLoaded = true;
    const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true; s.onload = render; document.head.appendChild(s);
  }
  $('#jEmoji').addEventListener('click', e => { const b = e.target.closest('[data-emoji]'); if (b) $('#jEmoji').querySelectorAll('[data-emoji]').forEach(x => x.setAttribute('aria-checked', x === b)); });
  $('#jName').addEventListener('input', e => {
    const bad = S.checkName(e.target.value), h = $('#jNameHint');
    h.textContent = !e.target.value ? 'Like a variable name: starts with a letter or _, then letters, numbers or _.' : bad || '✓ Looks good';
    h.className = 'fhint ' + (!e.target.value ? '' : bad ? 'bad' : 'ok');
  });
  $('#jLater').addEventListener('click', () => $('#joinDlg').close());
  $('#jRestore').addEventListener('click', () => { $('#joinDlg').close(); openRestore(); });
  $('#joinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#jErr'), name = $('#jName').value.trim(), bad = S.checkName(name), btn = $('#jGo');
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await S.join({ username: name, emoji: $('#jEmoji [aria-checked="true"]')?.dataset.emoji, routeId: $('#jRoute').value || null, batch: $('#jBatch').value.trim(), turnstile: tsToken });
      if (S.me.routeId) setMyRoute(S.me.routeId, true);
      $('#joinDlg').close(); celebrate(`Welcome aboard, @${S.me.username}!`);
      showKey(() => { const f = afterJoin; afterJoin = null; f ? f() : go({ name: 'me' }); });
    } catch (x) { err.textContent = x.message; err.hidden = false; if (window.turnstile) try { window.turnstile.reset(); } catch {} }
    btn.disabled = false; btn.textContent = "Let's go";
  });
  function showKey(then) {
    const dlg = $('#keyDlg');
    $('#keyVal').value = S.key || '(not available on this phone: make a new code)';
    dlg.onclose = () => then && then();
    dlg.showModal();
  }
  const copy = async (text, ok) => { try { await navigator.clipboard.writeText(text); toast(ok); } catch { $('#keyVal').select(); toast('Select and copy the code'); } };
  $('#keyCopy').addEventListener('click', () => copy(S.key, 'Recovery code copied. Keep it private!'));
  $('#keyLink').addEventListener('click', () => copy(`${location.origin}/#restore=${S.key}`, 'Restore link copied. Send it only to yourself.'));
  function openRestore(code) {
    $('#restoreVal').value = code || ''; $('#restoreErr').hidden = true;
    $('#restoreDlg').showModal();
  }
  $('#restoreCancel').addEventListener('click', () => $('#restoreDlg').close());
  $('#restoreForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await S.restore($('#restoreVal').value); $('#restoreDlg').close(); celebrate(`Welcome back, @${S.me.username}!`); go({ name: 'me' }); }
    catch (x) { $('#restoreErr').textContent = x.message; $('#restoreErr').hidden = false; }
  });

  /* ---------- installable app (PWA) ---------- */
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  let installEvt = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
  addEventListener('appinstalled', () => { installEvt = null; $('#installBtn').hidden = true; });
  $('#installBtn').addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').hidden = true;
  });

  start();
})();
