(function () {
  const $ = s => document.querySelector(s);
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
  };
  const STATUS = { running: 'Running', stopped: 'Stopped', offline: 'Offline' };
  const isMobile = () => matchMedia('(max-width: 860px)').matches;
  const ICON_BUS = '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v2M16 18v2"/><circle cx="8.5" cy="14.5" r=".6" fill="currentColor"/><circle cx="15.5" cy="14.5" r=".6" fill="currentColor"/></svg>';
  const ICON_BACK = '<svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';

  let map = null, selected = null, snap = [], listKey = '';

  /* ================= Sign in ================= */
  const loginEl = $('#login'), appEl = $('#app');
  $('#pwToggle').addEventListener('click', e => {
    const pw = $('#pw'), show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
  });
  const showErr = msg => {
    const err = $('#loginErr'); err.textContent = msg; err.hidden = false;
    err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake');
  };
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const id = $('#sid').value.trim(), pw = $('#pw').value, btn = e.currentTarget.querySelector('button[type=submit]');
    if (!id || !pw) return showErr(!id ? 'Enter your student ID.' : 'Enter your password.');
    $('#loginErr').hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const u = await Feed.login(id, pw);
      store.set('iubat_token', u.token); store.set('iubat_user', u.name || u.id);
      await enter(u.token, u.name || u.id);
    } catch (err) { showErr(err.message); }
    btn.disabled = false; btn.textContent = 'Sign in';
  });
  $('#logout').addEventListener('click', logout);
  function logout() {
    store.del('iubat_token'); store.del('iubat_user'); Feed.stop();
    appEl.hidden = true; loginEl.hidden = false; $('#pw').value = ''; selected = null;
  }

  async function enter(token, name) {
    loginEl.hidden = true; appEl.hidden = false;
    $('#userChip').textContent = name;
    await Feed.load(token);
    if (!map) await boot();
    Feed.start(token);
    map.resize();
  }

  /* ================= App ================= */
  async function boot() {
    Feed.onAuthFail = () => { logout(); showErr('Your session has expired. Please sign in again.'); };
    Feed.onStatus = ok => { $('#conn').hidden = ok; };
    map = new BusMap($('#map'), { routes: Feed.routes, campus: Feed.campus, onSelect: pick });
    Feed.onRoutes = f => { map.setRoutes(f.routes); if (selected && !f.state.has(selected)) pick(null); listKey = ''; refresh(); };
    await map.ready;
    let last = performance.now();
    (function loop(now) {
      const dt = Math.min(0.2, (now - last) / 1000); last = now;
      map.setBuses(Feed.positions(dt));
      requestAnimationFrame(loop);
    })(last);
    refresh(); setInterval(refresh, 1000);

    $('#chips').addEventListener('click', e => {
      const b = e.target.closest('[data-id]'); if (b) pick(b.dataset.id);
    });
    $('#panelBody').addEventListener('click', e => {
      if (e.target.closest('[data-back]')) return pick(null);
      const c = e.target.closest('[data-id]'); if (c) pick(c.dataset.id);
    });
    $('#handle').addEventListener('click', () => { $('#panel').classList.toggle('open'); pad(); });
    addEventListener('resize', pad); pad();

    const tView = $('#tView');
    tView.addEventListener('click', () => {
      const top = map.isTop(); map.setView(top ? '3d' : 'top'); tView.textContent = top ? '3D' : '2D';
    });
    $('#tRotL').addEventListener('click', () => map.rotate(-45));
    $('#tRotR').addEventListener('click', () => map.rotate(45));
    $('#tZin').addEventListener('click', () => map.zoom(0.5));
    $('#tZout').addEventListener('click', () => map.zoom(2));
    $('#tLoc').addEventListener('click', () => map.recenter());
  }

  function pick(id) {
    selected = id;
    if (isMobile()) { $('#panel').classList.toggle('open', !!id); pad(); }
    map.select(id);
    listKey = ''; render();
    $('#panelBody').scrollTop = 0;
  }

  // On mobile the bottom sheet covers the lower part of the map: shift the camera centre up
  function pad() {
    if (!map) return;
    map.setPadding(!isMobile() ? 0 : ($('#panel').classList.contains('open') ? innerHeight * 0.62 : 124));
  }

  function refresh() { snap = Feed.snapshot(); render(); }

  function render() {
    const chips = snap.map(b => {
      const cls = b.status === 'offline' ? 'is-off' : '';
      const pip = b.status === 'stopped' ? 'stop' : '';
      return `<button class="chip ${cls}" role="tab" data-id="${b.id}" aria-selected="${b.id === selected}" title="${b.routeName}"><span class="pip ${pip}"></span>${b.id}</button>`;
    }).join('');
    if (chips !== listKey) { $('#chips').innerHTML = chips; listKey = chips; }

    const body = $('#panelBody'), top = body.scrollTop;
    body.innerHTML = selected ? detail(snap.find(b => b.id === selected)) : list();
    body.scrollTop = top;
  }

  const fmt = m => (m < 1 ? 'Now' : Math.ceil(m) + ' min');
  const short = n => n.replace(/^IUBAT /, '');
  const lastSeen = b => b.lastUpdateSec == null ? 'No data yet' : b.lastUpdateSec < 90 ? b.lastUpdateSec + ' s ago' : Math.round(b.lastUpdateSec / 60) + ' min ago';
  const dirTag = b => (b.noRoute || b.noData) ? '' : `<span class="pill dir">${b.inbound ? 'Inbound · to campus' : 'Outbound · from campus'}</span>`;

  function list() {
    if (!snap.length) return '<p class="section-title">No buses have been set up yet.</p>';
    const running = snap.filter(b => b.status !== 'offline').length;
    return `<div class="section-title">All buses · ${running} active</div>` + snap.map(b => `
      <button class="card ${b.status === 'offline' ? 'is-off' : ''}" data-id="${b.id}">
        <span class="badge ${b.status}">${b.id}</span>
        <span>
          <h3>${b.routeName}</h3>
          <span class="route">${b.noRoute ? '<b>Waiting for admin to assign a route</b>' : `<b>${short(b.from)}</b><span class="arrow">→</span><b>${short(b.to)}</b>`}</span>
          <span class="pill ${b.status}" style="margin-top:6px">${STATUS[b.status]}${b.atStop && b.status === 'stopped' ? ' · ' + b.atStop : ''}</span>
        </span>
        <span class="eta"><strong>${b.destEtaText}</strong><small>${b.status === 'offline' ? (b.noData ? 'No data' : lastSeen(b)) : (b.noRoute ? '' : 'to destination')}</small></span>
      </button>`).join('');
  }

  function detail(b) {
    const back = `<button class="ghost back" data-back>${ICON_BACK} All buses</button>`;
    if (!b) return '';
    const head = `<div class="d-head"><span class="badge ${b.status}">${b.id}</span><div><h2>Bus ${b.id} · ${b.routeName}</h2><span class="pill ${b.status}">${STATUS[b.status]}${b.atStop && b.status === 'stopped' ? ' · ' + b.atStop : ''}</span> ${dirTag(b)}</div></div>`;
    if (b.noData) return back + head + `<p class="section-title">No location received from this bus yet.</p>`;
    if (b.noRoute) return back + head + `<p class="section-title">No route assigned yet. Live position is shown on the map.</p>`;
    const off = b.status === 'offline';
    const next = off ? 'Offline' : (b.nextStop ? b.nextStop.name : 'Arrived');
    return `${back}${head}
      <div class="journey">
        <div class="j-ends">
          <div><small>From</small><b>${b.from}</b></div>
          <div class="to"><small>To</small><b>${b.to}</b></div>
        </div>
        <div class="track" aria-hidden="true">
          <div class="fill" style="width:${(b.progress * 100).toFixed(1)}%"></div>
          <div class="bus" style="left:${(b.progress * 100).toFixed(1)}%">${ICON_BUS}</div>
        </div>
        <div class="j-foot">${off ? '<b>No signal</b> · ' + lastSeen(b) : '<b>' + (b.inbound ? 'Heading to campus' : 'Leaving campus') + '</b>'}</div>
      </div>

      <div class="stats">
        <div class="stat hot"><small>Arrives in</small><strong>${b.destEtaText}</strong></div>
        <div class="stat warm"><small>Next stop</small><strong style="font-size:16px">${next}</strong>${!off && b.nextStop ? `<em> · ${b.nextEtaText}</em>` : ''}</div>
        <div class="stat"><small>Speed</small><strong>${b.speedKmh} <em>km/h</em></strong></div>
        <div class="stat"><small>Last update</small><strong style="font-size:16px">${lastSeen(b)}</strong></div>
      </div>

      <div class="section-title">Route stops</div>
      <ol class="timeline">
        ${b.stops.map(s => `
          <li class="${s.state}">
            <i></i>
            <div class="nm"><span>${s.name}${s.state === 'here' ? ' <span class="tag">Here</span>' : ''}${s.state === 'next' ? ' <span class="tag">Next</span>' : ''}</span>
              <span class="tm">${s.state === 'passed' ? 'Passed' : s.state === 'here' ? 'Now' : off ? '' : fmt(s.etaMin)}</span></div>
          </li>`).join('')}
      </ol>`;
  }

  // Resume an existing session
  const tk = store.get('iubat_token');
  if (tk) enter(tk, store.get('iubat_user') || '').catch(() => { store.del('iubat_token'); loginEl.hidden = false; appEl.hidden = true; });
})();
