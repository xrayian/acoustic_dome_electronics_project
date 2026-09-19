# Hardware Spec — Noise Level Detection Kit

ESP8266 (NodeMCU V3 / LoLin) + I2S MEMS microphone + 3 status LEDs.
Detects ambient noise level and lights **Green** (normal), **Yellow** (moderate), or **Red** (high).

**IMPORTANT SAFETY NOTE:** The ESP8266 is a **3.3 V logic** device and its GPIOs are **NOT 5 V tolerant**.
Never feed 5 V into any GPIO. The I2S mic is a 3.3 V device, so no level shifting is needed.

---

## 1. Bill of Materials

| Qty | Part | Notes |
| --- | --- | --- |
| 1 | NodeMCU V3 (LoLin) dev board | ESP-12E module, CH340G USB-serial |
| 1 | I2S MEMS microphone | **INMP441 recommended** (no MCLK required; cheap, common) |
| 1 | Green LED | ~2.0–2.2 Vf indicator |
| 1 | Yellow LED | ~2.0–2.2 Vf indicator |
| 1 | Red LED | ~1.8–2.1 Vf indicator |
| 3 | Resistor 220 Ω (±; 150–330 Ω OK) | 1/4 W or smaller — one per LED |
| 1 | Micro USB cable | Programming + 5 V power |

If you only have higher-value resistors (e.g. 470 Ω–1 kΩ) the LEDs will still work, just dimmer.
Do not use less than ~100 Ω (overdrives the LED/GPIO).

---

## 2. NodeMCU V3 Pinout Reference

Board silkscreen labels do **not** match GPIO numbers. Use this table:

| Board Label | GPIO | Function | Notes |
| ----------- | ---- | -------- | ----- |
| D0 | 16 | Digital I/O | No PWM/interrupt. LED usage OK |
| D1 | 5 | Digital I/O (I²C SCL) | Safe general purpose |
| D2 | 4 | Digital I/O (I²C SDA) | Safe general purpose |
| D3 | 0 | Strapping pin | Must be HIGH at boot — avoid |
| D4 | 2 | Onboard LED, strapping | Must be HIGH at boot — avoid |
| D5 | 14 | **I²S input WS** | Reserved for mic |
| D6 | 12 | **I²S input DATA** | Reserved for mic |
| D7 | 13 | **I²S input BCK** | Reserved for mic |
| D8 | 15 | Strapping pin | Must be LOW at boot — avoid |
| RX | 3 | UART RX | Serial monitor |
| TX | 1 | UART TX | Serial monitor |
| A0 | ADC0 | 10-bit analog in | 0–3.3 V |

Power: **3V3** = regulated 3.3 V output, **VU/VIN** = 5 V in (via USB), **GND** = ground.

Overview of connections:

```
                    NodeMCU V3 (LoLin)
   +---------------------------------------------+
   |                                             |
   |  D5/GPIO14 (I2S WS)  <---- INMP441 WS   ___|
   |  D6/GPIO12 (I2S DATA) <--- INMP441 SD  |   |
   |  D7/GPIO13 (I2S BCK) <---- INMP441 SCK |   |
   |  D1/GPIO5  ---[220]---|>|--- Green LED      |
   |  D2/GPIO4  ---[220]---|>|--- Yellow LED     |
   |  D0/GPIO16 ---[220]---|>|--- Red LED        |
   |  3V3 -----------------> INMP441 VDD         |
   |  GND -----------------> INMP441 GND + LEDs  |
   +---------------------------------------------+
```

---

## 3. I2S Microphone Wiring (INMP441)

The ESP8266's I2S **input** interface is hardwired to three fixed GPIOs (BCK=GPIO13, WS=GPIO14,
DATA=GPIO12). These pins cannot be reassigned, so the mic must be wired like this:

| INMP441 pin | Connect to | Notes |
| ----------- | ---------- | ----- |
| VDD | NodeMCU **3V3** | 1.8–3.3 V tolerant; use 3.3 V rail |
| GND | NodeMCU **GND** | Shared ground |
| SCK / BCLK | NodeMCU **GPIO13 (D7)** | I²S bit clock (from ESP8266) |
| WS / LRCLK | NodeMCU **GPIO14 (D5)** | I²S word-select (from ESP8266) |
| SD / DOUT | NodeMCU **GPIO12 (D6)** | I²S serial mic data (into ESP8266) |
| L/R | NodeMCU **GND** | GND = left channel (required) |

Do **not** leave the L/R pin floating — tie it to GND (left) or 3V3 (right).

### Firmware notes
- ESP8266 Arduino core: use `#include <I2S.h>` (`I2S.setPins(13, 14, 12)` or rely on the
  fixed defaults, then `I2S.begin(...)` in receive mode). No MCLK is produced — this is why an
  INMP441 (slave, no MCLK needed) is the right mic choice. SPH0645/Adafruit breakouts that require
  MCLK may not work on ESP8266.
- Sample format: INMP441 clocks 24-bit data into 32-bit slots; enable 32-bit RX and right-shift
  the lower bits.
- Because GPIO13/14/12 are consumed, D5/D6/D7 are unavailable for anything else.

---

## 4. LED Wiring (Green / Yellow / Red)

Each LED is connected from a GPIO through a current-limiting resistor to GND.
LEDs are wired **anode → resistor → GPIO**, **cathode → GND** (sink configuration).

| LED | GPIO | Board Label | Series Resistor | Meaning |
| --- | ---- | ----------- | --------------- | ------- |
| Green | 5 | D1 | 220 Ω | Normal noise |
| Yellow | 4 | D2 | 220 Ω | Moderate noise |
| Red | 16 | D0 | 220 Ω | High noise |

Resistor math: with a ~3.3 V GPIO high and a ~2.0 V LED forward drop, 220 Ω limits current to
~6 mA, well below the ESP8266's ~12–15 mA max per GPIO. 150–330 Ω all work; keep at least 100 Ω.

With a 3-lead **common-cathode RGB** module instead, the three anodes map to GPIO5 / GPIO4 / GPIO16
and the shared cathode goes to GND (resistors already on module).

Only one LED lights at a time (exclusive states), as described below.

---

## 5. Power

| Rail | Use |
| ---- | --- |
| USB 5 V (or VU/VIN) | Board supply. Mic + LEDs together draw < 50 mA extra, fine off the onboard 3.3 V regulator |
| 3V3 | Mic VDD and LED references |
| GND | Common ground for everything |

Mic orientation: place it away from the WiFi ceramic antenna on the ESP-12E module to reduce RF
interference pickup.

---

## 6. Behavior Specification

Firmware reads I2S samples, computes a level metric (e.g. average absolute amplitude or RMS over
~100 ms frames), then drives exactly one LED:

| Metric | State | LED |
| ------ | ----- | --- |
| below LOW_THRESHOLD | Normal | Green (GPIO5) |
| between thresholds | Moderate | Yellow (GPIO4) |
| above HIGH_THRESHOLD | High | Red (GPIO16) |

- Green/Yellow/Red are **exclusive** — turn the other two off when a state changes.
- Thresholds depend on mic gain, distance to source, and ambient SPL. Calibrate in software:
  - measure the value during a quiet period → baseline / LOW threshold ≈ 2–3× baseline
  - measure during a loud speech/noise period → HIGH threshold ≈ 5–10× baseline
- Debounce the state for ~200–500 ms to avoid flicker around the thresholds.
- Serial `Serial.begin(115200)` (UART TX = GPIO1) can print live levels for calibration.
  Note: UART RX (GPIO3) is not needed, so the USB serial monitor still works.

---

## 7. Do / Don't

- DO wire the mic to the exact I2S pins: SCK→GPIO13, WS→GPIO14, SD→GPIO12.
- DO tie INMP441 L/R to GND.
- DO use a resistor ≥100 Ω per LED.
- DO keep all wiring at 3.3 V.
- DON'T use D3 (GPIO0), D4 (GPIO2), D8 (GPIO15) for peripherals — they affect boot mode.
- DON'T put 5 V on any GPIO or on the mic.