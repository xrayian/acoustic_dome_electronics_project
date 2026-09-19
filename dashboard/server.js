const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mqtt = require('mqtt');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';
const HTTP_PORT = process.env.PORT || 3000;
const OFFLINE_MS = 15000;
const REMOVE_MS = 10000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const client = mqtt.connect(MQTT_URL);

const registry = new Map();

const TOPIC_RE = /^acoustic\/([^/]+)\/(level|status|waveform)$/;
const LEGACY_RE = /^noise\/(level|status|waveform)$/;

const SOURCE_TOPICS = [
  'acoustic/+/level',
  'acoustic/+/status',
  'acoustic/+/waveform',
  'noise/level',
  'noise/status',
  'noise/waveform',
];

function stationState(station) {
  if (!registry.has(station)) {
    registry.set(station, {
      station,
      online: true,
      level: 0,
      peak: 0,
      frame: 0,
      rssi: null,
      uptime: null,
      frames: null,
      ip: null,
      fw: null,
      lastSeen: Date.now(),
      offlineSince: null,
    });
  }
  return registry.get(station);
}

function snapshot() {
  return Array.from(registry.values()).map((s) => ({
    station: s.station,
    online: s.online,
    level: s.level,
    peak: s.peak,
    frame: s.frame,
    rssi: s.rssi,
    uptime: s.uptime,
    frames: s.frames,
    ip: s.ip,
    fw: s.fw,
  }));
}

function decodeWaveform(msg) {
  const b = Buffer.from(msg);
  const level = b[0];
  const peak = b.readUInt16BE(1);
  const index = b.readUInt32BE(3);
  const count = b.readUInt16BE(7);
  const samples = [];
  for (let i = 0; i < count; i++) {
    const v = b[9 + i];
    samples.push(v < 128 ? v : v - 256);
  }
  return { level, peak, index, count, samples };
}

function handleLevel(station, json, retained) {
  if (retained && !registry.has(station)) return;
  const st = stationState(station);
  st.level = json.level;
  st.peak = json.peak;
  if (json.frame !== undefined) st.frame = json.frame;
  if (!retained) st.lastSeen = Date.now();
  io.emit('dome', { station, kind: 'level', data: json });
}

function handleStatus(station, json, retained) {
  if (retained && !registry.has(station)) return;
  const st = stationState(station);
  if (json.rssi !== undefined) st.rssi = json.rssi;
  if (json.uptime !== undefined) st.uptime = json.uptime;
  if (json.frames !== undefined) st.frames = json.frames;
  if (json.ip !== undefined) st.ip = json.ip;
  if (json.fw !== undefined) st.fw = json.fw;
  if (!retained) st.lastSeen = Date.now();
  io.emit('dome', { station, kind: 'status', data: json });
}

function handleWaveform(station, msg, retained) {
  if (retained && !registry.has(station)) return;
  const d = decodeWaveform(msg);
  const st = stationState(station);
  st.level = d.level;
  st.peak = d.peak;
  st.frame = d.index;
  if (!retained) st.lastSeen = Date.now();
  io.emit('dome', { station, kind: 'waveform', data: d });
}

client.on('connect', () => {
  console.log(`MQTT connected to ${MQTT_URL}`);
  client.subscribe(SOURCE_TOPICS);
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
  io.emit('mqtt-status', false);
});

client.on('message', (topic, msg, packet) => {
  const retained = !!(packet && packet.retain);
  const m = topic.match(TOPIC_RE);
  if (m) {
    const station = m[1];
    const kind = m[2];
    if (kind === 'level') return handleLevel(station, JSON.parse(msg.toString()), retained);
    if (kind === 'status') return handleStatus(station, JSON.parse(msg.toString()), retained);
    if (kind === 'waveform') return handleWaveform(station, msg, retained);
  }
  const legacy = topic.match(LEGACY_RE);
  if (legacy) {
    const station = 'legacy';
    const kind = legacy[1];
    if (kind === 'level') return handleLevel(station, JSON.parse(msg.toString()), retained);
    if (kind === 'status') return handleStatus(station, JSON.parse(msg.toString()), retained);
    if (kind === 'waveform') return handleWaveform(station, msg, retained);
  }
});

// Offline watchdog: mark stations offline when statuses stop arriving,
// then drop them entirely once they've been offline for a while so the
// dashboard only ever lists live domes.
setInterval(() => {
  const now = Date.now();
  for (const [station, st] of registry) {
    const online = now - st.lastSeen < OFFLINE_MS;
    if (online !== st.online) {
      st.online = online;
      if (online) st.offlineSince = null;
      else st.offlineSince = now;
      io.emit('dome', { station, kind: 'state', data: { online } });
    } else if (!online && st.offlineSince && now - st.offlineSince > REMOVE_MS) {
      registry.delete(station);
      io.emit('station-removed', station);
    }
  }
}, 2000);

// Fresh clients get a full snapshot of known stations on connect.
io.on('connection', (socket) => {
  socket.emit('stations', snapshot());
});

setInterval(() => {
  io.emit('mqtt-status', client.connected);
}, 2000);

server.listen(HTTP_PORT, () => {
  console.log(`Dashboard running at http://localhost:${HTTP_PORT}`);
});