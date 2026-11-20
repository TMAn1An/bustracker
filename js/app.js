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
  $('#loginForm').addEventListener('submit', e => {
    e.preventDefault();
    const id = $('#sid').value.trim(), pw = $('#pw').value;
    const err = $('#loginErr');
    // ডেমো ভ্যালিডেশন — আসল অ্যাপে সার্ভারে /api/login
    if (!id || pw.length < 4) {
      err.textContent = !id ? 'স্টুডেন্ট আইডি দিন।' : 'পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে।';
      err.hidden = false; err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake');
      return;
    }
    err.hidden = true;
    store.set('iubat_user', id);
    enter(id);
  });
  $('#logout').addEventListener('click', () => {
    store.del('iubat_user'); appEl.hidden = true; loginEl.hidden = false; $('#pw').value = '';
  });

  function enter(id) {
    loginEl.hidden = true; appEl.hidden = false;
    $('#userChip').textContent = 'ID ' + id;
    if (!map) boot();
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  /* ================= অ্যাপ ================= */
  function boot() {
    map = new Map3D($('#map'), BusFeed.routes, { onSelect: pick, logo: 'assets/logo.png' });
    // স্মুথ মুভমেন্ট: প্রতি ফ্রেমে সিমুলেশন
    let last = performance.now();
    (function loop(now) {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      BusFeed.tick(dt); map.setBuses(BusFeed.positions());
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
    $('#tRotL').addEventListener('click', () => map.rotate(-0.5));
    $('#tRotR').addEventListener('click', () => map.rotate(0.5));
    $('#tZin').addEventListener('click', () => map.zoom(0.78));
    $('#tZout').addEventListener('click', () => map.zoom(1.28));
    $('#tLoc').addEventListener('click', () => map.recenter());
  }

  function pick(id) {
    selected = id; map.select(id);
    if (id) map.goal.dist = Math.min(map.goal.dist, 760);
    else map.goal.dist = 1250;
    if (isMobile()) { $('#panel').classList.toggle('open', !!id); pad(); }
    listKey = ''; render();
    $('#panelBody').scrollTop = 0;
  }

  // মোবাইলে বটমশিট ম্যাপের নিচের অংশ ঢেকে দেয় — ক্যামেরা সেন্টার উপরে সরাই
  function pad() {
    if (!map) return;
    const h = innerHeight;
    map.padBottom = !isMobile() ? 0 : ($('#panel').classList.contains('open') ? h * 0.62 : 128);
  }

  function refresh() { snap = BusFeed.snapshot(); render(); }

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
        <span class="eta"><strong>${b.destEtaText}</strong><small>${b.status === 'offline' ? lastSeen(b) : 'গন্তব্যে'}</small></span>
      </button>`).join('');
  }

  function detail(b) {
    if (!b) return '';
    const dirText = b.toCampus ? 'ক্যাম্পাসের দিকে আসছে' : 'ক্যাম্পাস থেকে যাচ্ছে';
    const off = b.status === 'offline';
    const next = off ? 'অফলাইন' : (b.nextStop ? b.nextStop.name : 'গন্তব্যে পৌঁছেছে');
    return `
      <button class="ghost back" data-back>← সব বাস</button>
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
          <div class="bus" style="left:${(b.progress * 100).toFixed(1)}%">🚌</div>
        </div>
        <div class="j-foot">${off ? '<b>সংযোগ নেই</b> · ' + lastSeen(b) : '<b>' + dirText + '</b>'}</div>
      </div>

      <div class="stats">
        <div class="stat hot"><small>গন্তব্যে পৌঁছাবে</small><strong>${b.destEtaText}</strong></div>
        <div class="stat warm"><small>পরের স্টপ</small><strong style="font-size:16px">${next}</strong>${!off && b.nextStop ? `<em> · ${b.nextEtaText}</em>` : ''}</div>
        <div class="stat"><small>গতি</small><strong>${b.speedKmh} <em>কিমি/ঘ</em></strong></div>
        <div class="stat"><small>সর্বশেষ আপডেট</small><strong>${off ? lastSeen(b) : b.lastUpdateSec + ' <em>সেকেন্ড আগে</em>'}</strong></div>
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
  const lastSeen = b => Math.round(b.lastUpdateSec / 60) + ' মিনিট আগে';

  // সেশন থাকলে সরাসরি ঢোকো
  const u = store.get('iubat_user');
  if (u) enter(u);
})();
