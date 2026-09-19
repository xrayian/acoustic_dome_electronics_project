// Fake IoT devices for the Acoustic Dome dashboard.
// Spawns N synthetic domes, each publishing to its own acoustic/<id> topic
// namespace with independent scenarios and signal strength, so the fleet view
// can be tested end-to-end without hardware.
//
//   npm run fake              -> one dome (dome-01)
//   npm run fake -- --domes=4 -> four domes (dome-01 .. dome-04)

const mqtt = require('mqtt');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';

const DOME_COUNT = Math.max(1, parseInt(process.argv.find((a) => a.startsWith('--domes='))?.split('=')[1] || '1', 10));

const BROKER_INTERVAL_MS = 250;
const SAMPLE_RATE = 16000;
const DECIMATE = 4;
const FRAME_SAMPLES = Math.round((SAMPLE_RATE * BROKER_INTERVAL_MS) / 1000 / DECIMATE);

const LOW_THRESHOLD = 4;
const HIGH_THRESHOLD = 16;

const SCENARIOS = [
  { name: 'quiet',  amp: 1, tone: false, sec: 5 },
  { name: 'normal', amp: 4, tone: false, sec: 7 },
  { name: 'speech', amp: 11, tone: true, sec: 6 },
  { name: 'loud',   amp: 45, tone: true, sec: 5 },
  { name: 'quiet',  amp: 2, tone: false, sec: 4 },
  { name: 'normal', amp: 6, tone: false, sec: 6 },
  { name: 'loud',   amp: 70, tone: true, sec: 6 },
  { name: 'speech', amp: 12, tone: true, sec: 6 },
];

function stationId(n) {
  return 'dome-' + String(n).padStart(2, '0');
}

function makeDome(n) {
  const id = stationId(n);
  let scenarioIdx = n % SCENARIOS.length;
  let scenarioElapsed = 0;
  let env = 0;
  let frameIndex = 0;
  let sampleClock = 0;
  const startTime = Date.now();
  const rssiBase = -34 - (n % 5) * 6;

  function currentScenario() {
    if (scenarioElapsed >= SCENARIOS[scenarioIdx].sec) {
      scenarioIdx = (scenarioIdx + 1) % SCENARIOS.length;
      scenarioElapsed = 0;
    }
    return SCENARIOS[scenarioIdx];
  }

  function generateFrame() {
    const scenario = currentScenario();
    const samples = [];
    let peak = 0;

    for (let i = 0; i < FRAME_SAMPLES; i++) {
      sampleClock += DECIMATE;
      scenarioElapsed += DECIMATE / SAMPLE_RATE;

      env += (scenario.amp - env) * 0.002;

      const noise = Math.random() * 2 - 1;
      const tone = scenario.tone
        ? 0.5 * Math.sin(sampleClock * 0.03) + 0.3 * Math.sin(sampleClock * 0.0105)
        : 0.2 * Math.sin(sampleClock * 0.053);

      const v = Math.max(-127, Math.min(127, Math.round(env * (noise + tone))));
      samples.push(v);
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }

    return { samples, peak };
  }

  function buildFrame(samples, peak) {
    const level = peak >= HIGH_THRESHOLD ? 2 : peak >= LOW_THRESHOLD ? 1 : 0;
    const buf = Buffer.alloc(9 + samples.length);
    buf[0] = level;
    buf.writeUInt16BE(peak, 1);
    buf.writeUInt32BE(frameIndex, 3);
    buf.writeUInt16BE(samples.length, 7);
    for (let i = 0; i < samples.length; i++) buf[9 + i] = samples[i];
    return { buf, level };
  }

  const client = mqtt.connect(MQTT_URL);

  client.on('connect', () => {
    console.log(`${id}: connected to ${MQTT_URL} — publishing fake noise data`);

    setInterval(() => {
      const { samples, peak } = generateFrame();
      const { buf, level } = buildFrame(samples, peak);

      client.publish(`acoustic/${id}/waveform`, buf);
      client.publish(`acoustic/${id}/level`, JSON.stringify({ level, peak, frame: frameIndex }), { retain: true });

      if (frameIndex % 10 === 0) {
        const label = ['normal', 'moderate', 'high'][level];
        console.log(`${id} frame ${frameIndex}: ${label} peak=${peak} (${currentScenario().name})`);
      }
      frameIndex++;
    }, BROKER_INTERVAL_MS);

    setInterval(() => {
      const status = JSON.stringify({
        station: id,
        rssi: rssiBase - Math.round(Math.random() * 10),
        uptime: Math.round((Date.now() - startTime) / 1000),
        frames: frameIndex,
        ip: '192.168.1.' + (20 + n),
        fw: '1.1.0',
      });
      client.publish(`acoustic/${id}/status`, status);
    }, 5000);
  });

  client.on('error', (err) => {
    console.error(`${id}: MQTT error:`, err.message);
    client.end();
  });
}

for (let n = 1; n <= DOME_COUNT; n++) {
  makeDome(n);
}

console.log(`starting ${DOME_COUNT} fake dome(s) — e.g. ${stationId(1)} ${DOME_COUNT > 1 ? '… ' + stationId(DOME_COUNT) : '(run with --domes=N for more)'}`);
console.log(`frame: ${FRAME_SAMPLES} samples every ${BROKER_INTERVAL_MS}ms`);