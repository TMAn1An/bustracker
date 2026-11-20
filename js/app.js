(function () {
  const $ = s => document.querySelector(s);
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
  };
  const STATUS = { running: 'চলছে', stopped: 'স্টপে', offline: 'অফলাইন' };
  const isMobile = () => matchMedia('(max-width: 860px)').matches;

  let map = null, selected = null, snap = [], listKey = '';

  /* ================= লগইন ================= */
  const loginEl = $('#login'), appEl = $('#app');
  $('#pwToggle').addEventListener('click', e => {
    const pw = $('#pw'), show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'লুকান' : 'দেখুন';
  });
  const showErr = msg => {
    const err = $('#loginErr'); err.textContent = msg; err.hidden = false;
    err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake');
  };
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const id = $('#sid').value.trim(), pw = $('#pw').value, btn = e.currentTarget.querySelector('button[type=submit]');
    if (!id || !pw) return showErr(!id ? 'স্টুডেন্ট আইডি দিন।' : 'পাসওয়ার্ড দিন।');
    $('#loginErr').hidden = true; btn.disabled = true; btn.textContent = 'যাচাই হচ্ছে…';
    try {
      const u = await Feed.login(id, pw);
      store.set('iubat_token', u.token); store.set('iubat_user', u.name || u.id);
      await enter(u.token, u.name || u.id);
    } catch (err) { showErr(err.message); }
    btn.disabled = false; btn.textContent = 'লগইন করুন';
  });
  $('#logout').addEventListener('click', logout);
  function logout() {
    store.del('iubat_token'); store.del('iubat_user'); Feed.stop();
    appEl.hidden = true; loginEl.hidden = false; $('#pw').value = ''; selected = null;
  }

  async function enter(token, name) {
    loginEl.hidden = true; appEl.hidden = false;
    $('#userChip').textContent = name;
    if (!map) await boot();
    Feed.start(token);
    map.resize();
  }

  /* ================= অ্যাপ ================= */
  async function boot() {
    await Feed.init();
    Feed.onAuthFail = () => { logout(); showErr('সেশন শেষ হয়েছে, আবার লগইন করুন।'); };
    Feed.onStatus = ok => { $('#conn').hidden = ok; };
    map = new BusMap($('#map'), { routes: Feed.routes, campus: Feed.campus, onSelect: pick });
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
      const top = map.isTop(); map.setView(top ? '3d' : 'top'); tView.textContent = top ? '৩D' : '২D';
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

  // মোবাইলে বটমশিট ম্যাপের নিচের অংশ ঢেকে দেয় — ক্যামেরা সেন্টার উপরে সরাই
  function pad() {
    if (!map) return;
    map.setPadding(!isMobile() ? 0 : ($('#panel').classList.contains('open') ? innerHeight * 0.62 : 128));
  }

  function refresh() { snap = Feed.snapshot(); render(); }

  function render() {
    // চিপস
    const chips = snap.map(b => {
      const cls = b.status === 'offline' ? 'is-off' : '';
      const pip = b.status === 'stopped' ? 'stop' : '';
      return `<button class="chip ${cls}" role="tab" data-id="${b.id}" aria-selected="${b.id === selected}" title="${b.routeName}"><span class="pip ${pip}"></span>${b.id}</button>`;
    }).join('');
    const ck = chips; if (ck !== listKey) { $('#chips').innerHTML = chips; listKey = ck; }

    const body = $('#panelBody'), top = body.scrollTop;
    body.innerHTML = selected ? detail(snap.find(b => b.id === selected)) : list();
    body.scrollTop = top;
  }

  function list() {
    const running = snap.filter(b => b.status !== 'offline').length;
    return `<div class="section-title">সব বাস · ${running}টি সক্রিয়</div>` + snap.map(b => `
      <button class="card ${b.status === 'offline' ? 'is-off' : ''}" data-id="${b.id}">
        <span class="badge ${b.status}">${b.id}</span>
        <span>
          <h3>${b.routeName}</h3>
          <span class="route"><b>${short(b.from)}</b><span class="arrow">→</span><b>${short(b.to)}</b></span>
          <span class="pill ${b.status}" style="margin-top:6px">${STATUS[b.status]}${b.atStop && b.status === 'stopped' ? ' · ' + b.atStop : ''}</span>
        </span>
        <span class="eta"><strong>${b.destEtaText}</strong><small>${b.status === 'offline' ? (b.noData ? 'তথ্য নেই' : lastSeen(b)) : 'গন্তব্যে'}</small></span>
      </button>`).join('');
  }

  function detail(b) {
    if (!b) return '';
    if (b.noData) return `<button class="ghost back" data-back><svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg> সব বাস</button><div class="d-head"><span class="badge offline">${b.id}</span><div><h2>বাস ${b.id} · ${b.routeName}</h2><span class="pill offline">অফলাইন</span></div></div><p class="section-title">এই বাস থেকে এখনো লোকেশন আসেনি।</p>`;
    const dirText = b.toCampus ? 'ক্যাম্পাসের দিকে আসছে' : 'ক্যাম্পাস থেকে যাচ্ছে';
    const off = b.status === 'offline';
    const next = off ? 'অফলাইন' : (b.nextStop ? b.nextStop.name : 'গন্তব্যে পৌঁছেছে');
    return `
      <button class="ghost back" data-back><svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg> সব বাস</button>
      <div class="d-head">
        <span class="badge ${b.status}">${b.id}</span>
        <div><h2>বাস ${b.id} · ${b.routeName}</h2><span class="pill ${b.status}">${STATUS[b.status]}${b.atStop && b.status === 'stopped' ? ' · ' + b.atStop : ''}</span></div>
      </div>

      <div class="journey">
        <div class="j-ends">
          <div><small>কোথা থেকে</small><b>${b.from}</b></div>
          <div class="to"><small>কোথায় যাচ্ছে</small><b>${b.to}</b></div>
        </div>
        <div class="track" aria-hidden="true">
          <div class="fill" style="width:${(b.progress * 100).toFixed(1)}%"></div>
          <div class="bus" style="left:${(b.progress * 100).toFixed(1)}%"><svg class="i" viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v2M16 18v2"/><circle cx="8.5" cy="14.5" r=".6" fill="currentColor"/><circle cx="15.5" cy="14.5" r=".6" fill="currentColor"/></svg></div>
        </div>
        <div class="j-foot">${off ? '<b>সংযোগ নেই</b> · ' + lastSeen(b) : '<b>' + dirText + '</b>'}</div>
      </div>

      <div class="stats">
        <div class="stat hot"><small>গন্তব্যে পৌঁছাবে</small><strong>${b.destEtaText}</strong></div>
        <div class="stat warm"><small>পরের স্টপ</small><strong style="font-size:16px">${next}</strong>${!off && b.nextStop ? `<em> · ${b.nextEtaText}</em>` : ''}</div>
        <div class="stat"><small>গতি</small><strong>${b.speedKmh} <em>কিমি/ঘ</em></strong></div>
        <div class="stat"><small>সর্বশেষ আপডেট</small><strong style="font-size:16px">${lastSeen(b)}</strong></div>
      </div>

      <div class="section-title">রুটের স্টপসমূহ</div>
      <ol class="timeline">
        ${b.stops.map(s => `
          <li class="${s.state}">
            <i></i>
            <div class="nm"><span>${s.name}${s.state === 'here' ? ' <span class="tag">● এখানে</span>' : ''}${s.state === 'next' ? ' <span class="tag">পরবর্তী</span>' : ''}</span>
              <span class="tm">${s.state === 'passed' ? 'পার হয়েছে' : s.state === 'here' ? 'এখন' : off ? '' : fmt(s.etaMin)}</span></div>
          </li>`).join('')}
      </ol>`;
  }

  const fmt = m => (m < 1 ? 'এখন' : Math.ceil(m) + ' মি.');
  const short = n => n.replace('IUBAT ', '');
  const lastSeen = b => b.lastUpdateSec == null ? 'এখনো তথ্য আসেনি' : b.lastUpdateSec < 90 ? b.lastUpdateSec + ' সেকেন্ড আগে' : Math.round(b.lastUpdateSec / 60) + ' মিনিট আগে';

  // সেশন থাকলে সরাসরি ঢোকো
  const tk = store.get('iubat_token');
  if (tk) enter(tk, store.get('iubat_user') || '').catch(() => {});
})();
