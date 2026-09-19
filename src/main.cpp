#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <I2S.h>

#define LED_GREEN D1
#define LED_YELLOW D2
#define LED_RED D0

#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASS "YOUR_WIFI_PASSWORD"
#define MQTT_SERVER "192.168.1.100"
#define MQTT_PORT 1883

#define FW_VERSION "1.1.0"

// Station ID: override via build flag -DSTATION_ID="kitchen", otherwise a
// stable per-chip ID derived from the ESP8266 chip id (unique per MCU).
// Define STATION_ID_PREFIX to get a readable fleet prefix, e.g.
//   build_flags = -DSTATION_ID_PREFIX="dome-"
// produces  "dome-4f7a2b9c".

#ifndef STATION_ID_PREFIX
#define STATION_ID_PREFIX "dome-"
#endif

#define SAMPLE_RATE 16000
#define DECIMATE 4
#define PUBLISH_MS 250
#define FRAME_SAMPLES ((SAMPLE_RATE * PUBLISH_MS) / 1000 / DECIMATE)

#define LOW_THRESHOLD 4
#define HIGH_THRESHOLD 16

static const uint8_t ledPins[3] = {LED_GREEN, LED_YELLOW, LED_RED};
static const char* ledNames[3] = {"green", "yellow", "red"};

WiFiClient net;
PubSubClient mqtt(net);

static char stationId[32];
static char topicBuf[64];

static uint8_t frameBuf[9 + FRAME_SAMPLES];
static uint32_t frameIndex = 0;
static uint32_t lastStatus = 0;

void initStationId() {
#ifdef STATION_ID
  snprintf(stationId, sizeof(stationId), "%s", STATION_ID);
#else
  snprintf(stationId, sizeof(stationId), STATION_ID_PREFIX "%08x",
           (unsigned)ESP.getChipId());
#endif
}

// Topic names are scoped per station so a fleet shares one broker:
//   acoustic/<station>/waveform   binary frames
//   acoustic/<station>/level      retained classification
//   acoustic/<station>/status     periodic health
void setTopic(const char* kind) {
  snprintf(topicBuf, sizeof(topicBuf), "acoustic/%s/%s", stationId, kind);
}

void setLeds(uint8_t level) {
  for (uint8_t i = 0; i < 3; i++) {
    digitalWrite(ledPins[i], i == level ? HIGH : LOW);
  }
}

bool connectWifi() {
  static uint32_t lastTry = 0;
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }
  if (millis() - lastTry < 3000) {
    return false;
  }
  lastTry = millis();
  Serial.print("connecting wifi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("wifi connected, ip=");
    Serial.println(WiFi.localIP());
    return true;
  }
  Serial.println(" wifi failed");
  return false;
}

bool connectMqtt() {
  static uint32_t lastTry = 0;
  if (mqtt.connected()) {
    return true;
  }
  if (millis() - lastTry < 3000) {
    return false;
  }
  lastTry = millis();
  Serial.print("connecting mqtt as ");
  Serial.println(stationId);
  if (mqtt.connect(stationId)) {
    Serial.println("mqtt connected");
    return true;
  }
  Serial.println("mqtt failed");
  return false;
}

uint8_t classify(uint8_t peak) {
  if (peak >= HIGH_THRESHOLD) {
    return 2;
  }
  if (peak >= LOW_THRESHOLD) {
    return 1;
  }
  return 0;
}

void publishFrame(uint8_t level, uint8_t peak, uint32_t count) {
  frameBuf[0] = level;
  frameBuf[1] = (uint8_t)(peak >> 8);
  frameBuf[2] = (uint8_t)(peak & 0xff);
  frameBuf[3] = (uint8_t)(frameIndex >> 24);
  frameBuf[4] = (uint8_t)(frameIndex >> 16);
  frameBuf[5] = (uint8_t)(frameIndex >> 8);
  frameBuf[6] = (uint8_t)(frameIndex & 0xff);
  frameBuf[7] = (uint8_t)(count >> 8);
  frameBuf[8] = (uint8_t)(count & 0xff);

  setTopic("waveform");
  mqtt.publish(topicBuf, frameBuf, 9 + count, false);

  char msg[64];
  snprintf(msg, sizeof(msg),
           "{\"level\":%u,\"peak\":%u,\"frame\":%lu}",
           level, peak, frameIndex);
  setTopic("level");
  mqtt.publish(topicBuf, msg, true);

  Serial.print(ledNames[level]);
  Serial.print(" peak=");
  Serial.println(peak);

  frameIndex++;
}

void publishStatus() {
  char s[160];
  snprintf(s, sizeof(s),
           "{\"station\":\"%s\",\"ip\":\"%s\",\"fw\":\"%s\",\"rssi\":%d,"
           "\"uptime\":%lu,\"frames\":%lu}",
           stationId, WiFi.localIP().toString().c_str(), FW_VERSION,
           WiFi.RSSI(), millis() / 1000, frameIndex);
  setTopic("status");
  mqtt.publish(topicBuf, s, false);
}

void setup() {
  Serial.begin(115200);
  initStationId();

  for (uint8_t i = 0; i < 3; i++) {
    pinMode(ledPins[i], OUTPUT);
    digitalWrite(ledPins[i], LOW);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setBufferSize(1100);

  i2s_rxtxdrive_begin(true, false, true, false);
  i2s_set_rate(SAMPLE_RATE);

  Serial.print("noise detector starting, station=");
  Serial.println(stationId);
}

void loop() {
  if (!connectWifi()) {
    delay(100);
    return;
  }
  if (!connectMqtt()) {
    delay(100);
    return;
  }
  mqtt.loop();

  static uint32_t count = 0;
  static uint32_t skip = 0;
  static uint8_t peak = 0;

  int16_t l, r;
  while (count < FRAME_SAMPLES && i2s_read_sample(&l, &r, false)) {
    if (++skip % DECIMATE == 0) {
      int8_t s8 = (int8_t)(l >> 8);
      frameBuf[9 + count] = (uint8_t)s8;
      uint8_t mag = (uint8_t)(s8 < 0 ? -s8 : s8);
      if (mag > peak) {
        peak = mag;
      }
      count++;
    }
  }

  if (count >= FRAME_SAMPLES) {
    uint8_t level = classify(peak);
    setLeds(level);
    publishFrame(level, peak, count);
    count = 0;
    peak = 0;
  }

  if (millis() - lastStatus > 5000) {
    lastStatus = millis();
    publishStatus();
  }
}