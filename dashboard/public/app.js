const socket = io();

const canvas = document.getElementById('wave');
const ctx = canvas.getContext('2d');

const RING_LEN = 4096;
const SPARK_LEN = 260;

const LEVEL_TEXT = ['NORMAL', 'MODERATE', 'HIGH'];
const LEVEL_CLASS = ['level-normal', 'level-moderate', 'level-high'];
const LEVEL_FC_CLASS = ['level-normal', 'level-moderate', 'level-high'];
const LEVEL_LV_CLASS = ['lv-normal', 'lv-moderate', 'lv-high'];

const stations = new Map(); // station -> state { level, peak, rssi, uptime, frames, ip, fw, online }
const rings = new Map();
const sparks = new Map();
const feeds = new Map(); // key -> [{ t, text, tone }]  (key = station id, or 'system')

const SYSTEM_KEY = 'system';

let focused = null;

const clampLevel = (l) => Math.max(0, Math.min(2, l | 0));
const isLive = (st) => st && st.online !== false;

function setBadge(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('on', on);
  const state = el.querySelector('.pill-state');
  if (state) state.textContent = on ? 'online' : 'offline';
}

function getFeed(key) {
  if (!feeds.has(key)) feeds.set(key, []);
  return feeds.get(key);
}

function feed(key, text, tone) {
  const arr = getFeed(key);
  arr.unshift({ t: new Date().toLocaleTimeString(), text, tone: tone || '' });
  while (arr.length > 80) arr.pop();
  if (key === SYSTEM_KEY) {
    renderFeed('sys-feed', SYSTEM_KEY);
  } else if (focused === key) {
    renderFeed('feed', key);
  }
}

function renderFeed(ulId, key) {
  const ul = document.getElementById(ulId);
  if (!ul) return;
  ul.innerHTML = '';
  const arr = feeds.get(key);
  if (!arr || arr.length === 0) {
    const li = document.createElement('li');
    li.className = 'feed-empty';
    li.textContent = 'awaiting events…';
    ul.appendChild(li);
    return;
  }
  for (const e of arr) {
    const li = document.createElement('li');
    li.className = e.tone;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = e.t;
    li.appendChild(t);
    li.appendChild(document.createTextNode(e.text));
    ul.appendChild(li);
  }
}

function getRing(station) {
  if (!rings.has(station)) rings.set(station, { buf: new Float32Array(RING_LEN), pos: 0, ready: false });
  return rings.get(station);
}

function getSpark(station) {
  if (!sparks.has(station)) sparks.set(station, { buf: new Float32Array(SPARK_LEN), pos: 0, ready: false });
  return sparks.get(station);
}

function pushSamples(ring, samples) {
  for (let i = 0; i < samples.length; i++) {
    ring.buf[ring.pos] = samples[i] / 128;
    ring.pos = (ring.pos + 1) % ring.buf.length;
    if (ring.pos === 0) ring.ready = true;
    if (ring.pos > 1) ring.ready = true;
  }
}

// ---------------- socket wiring ----------------

let mqttWasOn = null;

socket.on('connect', () => {
  setBadge('ws-badge', true);
});
socket.on('disconnect', () => {
  setBadge('ws-badge', false);
  feed(SYSTEM_KEY, 'uplink disconnected', 'bad');
});
socket.on('mqtt-status', (on) => {
  setBadge('mqtt-badge', on);
  if (mqttWasOn === null) {
    mqttWasOn = on;
    feed(SYSTEM_KEY, 'broker ' + (on ? 'online' : 'offline'), on ? 'ok' : 'bad');
    return;
  }
  if (on !== mqttWasOn) {
    mqttWasOn = on;
    feed(SYSTEM_KEY, 'broker ' + (on ? 'online' : 'offline'), on ? 'ok' : 'bad');
  }
});

socket.on('stations', (list) => {
  for (const s of list) {
    const st = stations.get(s.station) || {};
    const isNew = !stations.has(s.station);
    stations.set(s.station, {
      level: s.level ?? st.level ?? 0,
      peak: s.peak ?? st.peak ?? 0,
      rssi: s.rssi ?? st.rssi ?? null,
      uptime: s.uptime ?? st.uptime ?? null,
      frames: s.frames ?? st.frames ?? null,
      ip: s.ip ?? st.ip ?? null,
      fw: s.fw ?? st.fw ?? null,
      online: s.online ?? true,
      station: s.station,
    });
    if (isNew) {
      const tone = clampLevel(s.level) >= 1 ? 'warn' : 'ok';
      feed(s.station, 'station discovered' + (s.ip ? ' · ' + s.ip : ''), tone);
      feed(SYSTEM_KEY, 'station discovered · ' + s.station + (s.ip ? ' · ' + s.ip : ''), 'ok');
    }
  }
  renderFleet();
  renderFleetKpis();
  needStationList();
});

socket.on('station-removed', (station) => {
  stations.delete(station);
  rings.delete(station);
  sparks.delete(station);
  feeds.delete(station);
  feed(SYSTEM_KEY, station + ' departed · removed from fleet', 'bad');
  if (focused === station) backToFleet();
  renderFleet();
  renderFleetKpis();
  renderStationList();
});

socket.on('dome', ({ station, kind, data }) => {
  const st = stations.get(station) || { station };
  stations.set(station, st);

  if (kind === 'waveform') {
    pushSamples(getRing(station), data.samples);
    pushSamples(getSpark(station), data.samples.slice(0, SPARK_LEN) || data.samples);
    st.level = data.level;
    st.peak = data.peak;
    st.waveReady = true;
    if (focused === station) renderFocus();
  } else if (kind === 'level') {
    const prev = st.level;
    st.level = data.level;
    st.peak = data.peak;
    if (focused === station) renderFocus();
    if (prev !== undefined && prev !== data.level) {
      const name = LEVEL_TEXT[clampLevel(prev)];
      const next = LEVEL_TEXT[clampLevel(data.level)];
      const tone = data.level === 2 ? 'bad' : data.level === 1 ? 'warn' : 'ok';
      feed(station, 'level ' + name + ' → ' + next + ' · peak ' + data.peak, tone);
    } else if (prev === undefined) {
      const tone = data.level >= 1 ? 'warn' : 'ok';
      feed(station, 'first level ' + LEVEL_TEXT[clampLevel(data.level)] + ' · peak ' + data.peak, tone);
    }
  } else if (kind === 'status') {
    st.rssi = data.rssi ?? st.rssi;
    st.uptime = data.uptime ?? st.uptime;
    st.frames = data.frames ?? st.frames;
    st.ip = data.ip ?? st.ip;
    st.fw = data.fw ?? st.fw;
    const tone = clampLevel(st.level) === 2 ? 'bad' : clampLevel(st.level) === 1 ? 'warn' : 'ok';
    feed(station, 'status · rssi ' + (st.rssi ?? '--') + ' · up ' + (st.uptime ?? '--') + 's · fw v' + (st.fw ?? '--'), tone);
    if (focused === station) renderFocus();
  } else if (kind === 'state') {
    const wasOnline = !!st.online;
    st.online = data.online;
    if (data.online && !wasOnline) {
      feed(station, 'station online', 'ok');
      feed(SYSTEM_KEY, station + ' online', 'ok');
    }
    if (!data.online && wasOnline) {
      feed(station, 'station offline', 'bad');
      feed(SYSTEM_KEY, station + ' offline', 'bad');
    }
    if (focused === station) renderFocus();
  }

  if (!isLive(st)) renderFleet();
  else renderFleetCard(station);
  renderFleetKpis();
  needStationList();
});

// ---------------- sidebar ---------------

let lastListTick = 0;

function needStationList() {
  const now = performance.now();
  if (now - lastListTick > 500) {
    lastListTick = now;
    renderStationList();
  }
}

function renderStationList() {
  const box = document.getElementById('station-list');
  if (!box) return;

  const arr = [...stations.values()]
    .filter(isLive)
    .sort((a, b) => a.station.localeCompare(b.station));

  if (arr.length === 0) {
    box.innerHTML = '<div class="side-empty">no live domes</div>';
    return;
  }

  let html = '';
  for (const st of arr) {
    const li = clampLevel(st.level);
    const tone = LEVEL_LV_CLASS[li];
    const label = LEVEL_TEXT[li];
    const active = focused === st.station ? ' active' : '';
    html +=
      `<button class="station-item${active}" type="button" data-station="${st.station}">` +
      `<span class="st-dot online"></span>` +
      `<span class="st-id">${st.station}</span>` +
      `<span class="st-level ${tone}">${label}</span>` +
      `</button>`;
  }
  box.innerHTML = html;

  box.querySelectorAll('.station-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      openFocus(btn.dataset.station);
    });
  });
}

// ---------------- fleet view ----------------

function renderFleetKpis() {
  let online = 0;
  let worstLevel = -1;
  let worstStation = null;
  let rssiSum = 0;
  let rssiN = 0;
  let framesTotal = 0;

  for (const st of stations.values()) {
    if (!isLive(st)) continue;
    online++;
    if (st.level > worstLevel) {
      worstLevel = st.level;
      worstStation = st.station;
    }
    if (typeof st.rssi === 'number') {
      rssiSum += st.rssi;
      rssiN++;
    }
    framesTotal += st.frames || 0;
  }

  const stationsEl = document.getElementById('fleet-stations');
  if (stationsEl) {
    stationsEl.textContent = online ? `${online}` : '--';
  }

  const worstEl = document.getElementById('fleet-worst');
  if (worstEl) {
    if (stations.size === 0) {
      worstEl.textContent = '--';
      worstEl.className = 'kpi-value level-value level-idle';
    } else {
      const li = clampLevel(worstLevel);
      worstEl.textContent = LEVEL_TEXT[li];
      worstEl.className = 'kpi-value level-value ' + LEVEL_CLASS[li];
    }
  }

  const worstSub = document.getElementById('fleet-worst-sub');
  if (worstSub) worstSub.textContent = worstStation ? worstStation + ' reporting' : 'fleet status';

  const rssiEl = document.getElementById('fleet-rssi');
  if (rssiEl) rssiEl.textContent = rssiN ? Math.round(rssiSum / rssiN) : '--';

  const framesEl = document.getElementById('fleet-frames');
  if (framesEl) framesEl.textContent = framesTotal ? framesTotal : '--';
}

function renderFleetCard(station) {
  const st = stations.get(station);
  if (!st || !isLive(st)) return;
  let card = document.getElementById('fleet-card-' + station);
  if (!card) {
    renderFleet();
    card = document.getElementById('fleet-card-' + station);
    if (!card) return;
  }

  const levelEl = card.querySelector('.fc-level');
  const li = clampLevel(st.level);
  levelEl.textContent = LEVEL_TEXT[li];
  levelEl.className = 'fc-level ' + LEVEL_FC_CLASS[li];

  card.querySelector('.fc-state').className = 'fc-state online';
  card.querySelector('.fc-state').textContent = 'LIVE';

  card.querySelector('.m-peak').textContent = st.peak ?? '--';
  card.querySelector('.m-rssi').textContent = st.rssi ?? '--';
  card.querySelector('.m-up').textContent = st.uptime != null ? st.uptime + 's' : '--';

  drawSpark(card, station);
}

function renderFleet() {
  const grid = document.getElementById('fleet-grid');
  if (!grid) return;

  const live = [...stations.values()].filter(isLive);
  const seen = new Set();
  for (const st of live) {
    seen.add(st.station);
    if (!grid.querySelector('#fleet-card-' + st.station)) {
      const card = document.createElement('article');
      card.className = 'fleet-card';
      card.id = 'fleet-card-' + st.station;
      const li = clampLevel(st.level);
      card.innerHTML = `
        <div class="fc-top">
          <span class="fc-id">${st.station}</span>
          <span class="fc-state online">LIVE</span>
        </div>
        <span class="fc-level ${LEVEL_FC_CLASS[li]}">${LEVEL_TEXT[li]}</span>
        <canvas class="fc-spark"></canvas>
        <div class="fc-metrics">
          <div><span class="m-l">peak</span><span class="m-v m-peak">${st.peak ?? '--'}</span></div>
          <div><span class="m-l">rssi</span><span class="m-v m-rssi">${st.rssi ?? '--'}</span></div>
          <div><span class="m-l">up</span><span class="m-v m-up">${st.uptime != null ? st.uptime + 's' : '--'}</span></div>
        </div>`;
      card.addEventListener('click', () => openFocus(st.station));
      grid.appendChild(card);
    }
  }

  for (const card of grid.querySelectorAll('.fleet-card')) {
    const id = card.id.replace('fleet-card-', '');
    if (!seen.has(id)) card.remove();
  }

  if (live.length === 0) {
    if (!grid.querySelector('.fleet-empty')) {
      const empty = document.createElement('div');
      empty.className = 'fleet-empty';
      empty.innerHTML = '<b>no live domes</b>waiting for acoustic/+ topics on the broker';
      grid.appendChild(empty);
    }
  } else {
    grid.querySelector('.fleet-empty')?.remove();
  }
}

// ---------------- focus view ----------------

function setNavActive() {
  const navov = document.getElementById('nav-overview');
  if (navov) navov.classList.toggle('active', focused === null);
}

function openFocus(station) {
  focused = station;
  document.getElementById('fleet-view').hidden = true;
  document.getElementById('focus-view').hidden = false;
  setNavActive();

  const crumbCurrent = document.getElementById('crumb-current');
  const crumbSep = document.getElementById('crumb-sep');
  if (crumbCurrent) {
    crumbCurrent.textContent = station;
    crumbCurrent.hidden = false;
  }
  if (crumbSep) crumbSep.hidden = false;

  const liveEl = document.getElementById('focus-live');
  if (liveEl) liveEl.hidden = false;

  const st = stations.get(station) || {};
  document.getElementById('focus-ip').textContent = st.ip ? 'ip · ' + st.ip : '';
  document.getElementById('focus-fw').textContent = st.fw ? 'fw · v' + st.fw : '';

  renderFocus();
  renderFeed('feed', station);
  renderStationList();
  requestAnimationFrame(() => {
    resizeCanvas();
  });
}

function backToFleet() {
  focused = null;
  document.getElementById('focus-view').hidden = true;
  document.getElementById('fleet-view').hidden = false;
  setNavActive();
  const crumbCurrent = document.getElementById('crumb-current');
  const crumbSep = document.getElementById('crumb-sep');
  if (crumbCurrent) crumbCurrent.hidden = true;
  if (crumbSep) crumbSep.hidden = true;
  const liveEl = document.getElementById('focus-live');
  if (liveEl) liveEl.hidden = true;
  renderFeed('sys-feed', SYSTEM_KEY);
  renderStationList();
}

document.getElementById('nav-overview')?.addEventListener('click', backToFleet);
document.getElementById('crumb-fleet')?.addEventListener('click', backToFleet);

function renderFocus() {
  if (!focused) return;
  const st = stations.get(focused);
  if (!st) return;

  const li = clampLevel(st.level);
  const label = document.getElementById('meter-label');
  label.textContent = LEVEL_TEXT[li];
  label.className = 'kpi-value level-value ' + LEVEL_CLASS[li];

  const peakEl = document.getElementById('meter-peak');
  peakEl.textContent = st.peak ?? '--';

  const pct = Math.min(100, Math.round(((st.peak || 0) / 64) * 100));
  const fill = document.getElementById('meter-fill');
  if (fill) fill.style.width = pct + '%';
  const pctEl = document.getElementById('peak-pct');
  if (pctEl) pctEl.textContent = pct + '%';

  const rssiEl = document.getElementById('stat-rssi');
  rssiEl.textContent = st.rssi ?? '--';

  const bar = document.getElementById('rssi-bar');
  if (bar) {
    bar.classList.toggle('none', typeof st.rssi !== 'number' || st.rssi <= -75);
    bar.classList.toggle('weak', typeof st.rssi === 'number' && st.rssi > -75 && st.rssi <= -60);
    bar.classList.toggle('mid', typeof st.rssi === 'number' && st.rssi > -60 && st.rssi <= -45);
    bar.classList.toggle('strong', typeof st.rssi === 'number' && st.rssi > -45);
  }

  document.getElementById('stat-uptime').textContent = st.uptime ?? '--';
  document.getElementById('stat-frames').textContent = st.frames ?? '--';

  const cells = ['card-normal', 'card-moderate', 'card-high'];
  cells.forEach((id, i) => {
    document.getElementById(id).classList.toggle('active', st.level === i);
  });

  const liveEl = document.getElementById('focus-live');
  if (liveEl) {
    liveEl.textContent = st.online !== false ? 'STREAMING' : 'OFFLINE';
    liveEl.hidden = st.online === false;
  }
}

// ---------------- waveform canvas ----------------

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw() {
  requestAnimationFrame(draw);
  if (!focused) return;

  const st = stations.get(focused);
  const ring = focused ? rings.get(focused) : null;
  if (!st || !ring || !ring.ready) return;

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (let i = 1; i < 12; i++) {
    const x = (w / 12) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.strokeStyle = 'rgba(100, 116, 139, 0.45)';
  ctx.stroke();

  ctx.beginPath();
  for (let i = 0; i < RING_LEN; i++) {
    const x = (i / RING_LEN) * w;
    const v = ring.buf[(ring.pos + i) % RING_LEN];
    const y = h / 2 - v * (h / 2 - 10);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#0f766e';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// ---------------- sparklines ----------------

function drawSpark(card, station) {
  const canv = card.querySelector('.fc-spark');
  if (!canv) return;
  const spark = sparks.get(station);
  if (!spark) return;

  const w = canv.clientWidth || 220;
  const h = canv.clientHeight || 44;
  const dpr = window.devicePixelRatio || 1;
  if (canv.width !== w * dpr) {
    canv.width = w * dpr;
    canv.height = h * dpr;
  }
  const g = canv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const st = stations.get(station);
  const color = st ? ['#16a34a', '#d97706', '#dc2626'][clampLevel(st.level)] : '#94a3b8';

  g.strokeStyle = color;
  g.lineWidth = 1.2;
  g.beginPath();
  const n = spark.buf.length;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const v = spark.buf[(spark.pos + i) % n];
    const y = h / 2 - v * (h / 2 - 3);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

// ---------------- misc ----------------

const clock = document.getElementById('clock');
setInterval(() => {
  clock.textContent = new Date().toLocaleTimeString();
}, 1000);

window.addEventListener('resize', () => {
  resizeCanvas();
  animationTick();
  renderFleetKpis();
});

let lastSparkTick = 0;
function animationTick() {
  const now = performance.now();
  if (now - lastSparkTick > 500) {
    lastSparkTick = now;
    for (const st of stations.values()) {
      const card = document.getElementById('fleet-card-' + st.station);
      if (card) drawSpark(card, st.station);
    }
  }
}

resizeCanvas();
draw();
setInterval(animationTick, 500);
setNavActive();
renderFleet();
renderStationList();
renderFeed('sys-feed', SYSTEM_KEY);