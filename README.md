# Acoustic Dome

A friendly neighborhood **noise monitoring system**. Small, battery-friendly sensor modules
(we call them *domes*) listen for sound levels in different rooms or locations, and a simple
web dashboard shows you which places are quiet, busy, or loud — all live.

Think of it as a colorful "how loud is it right now?" map for your home, workshop, office, or
lab.

---

## What does it do?

Every dome is a tiny electronics board with a microphone and three coloured lights:

| Light | Meaning |
| ----- | ------- |
| Green  | Quiet / normal |
| Yellow | Moderate / getting loud |
| Red    | High noise level |

The dome shares its current noise level wirelessly with the rest of the fleet, and you can watch
every dome from one **live web dashboard**:

- **Sidebar** lists all domes that are currently online, with their latest status.
- **Fleet view** shows a card for each dome — current level, signal strength, and uptime.
- **Focus view** (click any dome) shows the live sound waveform as it happens.
- **Activity log** records things like when a dome came online or left the network.

Only domes that are currently connected are shown. If a dome goes quiet or drops offline it
appears as "offline" and then leaves the list, so what you see is the real, live fleet.

---

## Project layout

| Folder | What's in it |
| ------ | ------------ |
| `src/` | The software that runs on each dome (the "brains"). |
| `dashboard/` | The web server and the dashboard page you open in your browser. |
| `docs/` | A detailed hardware guide for building a dome from scratch. |
| `schema/` | The electronic schematic (the blueprint of the circuit board). |
| `icon.svg` | The little brand icon shown in the browser tab. |

---

## Getting started

The project has two halves that work together:

1. **Hardware →** Domes listen to their surroundings and publish their readings over WiFi.
2. **Software →** The dashboard receives those readings and shows them on screen.

For a *quick taste* without any hardware, you can run the **fake domes**: `fake-device.js`
pretends to be a fleet of domes sending realistic data, so you can explore the dashboard freely.

### Running the dashboard (non-technical quick start)

You'll need **Node.js** installed on the computer that runs the dashboard.

```
cd dashboard
npm install
npm run fake        # start some pretend domes so there is data to look at
npm start           # start the dashboard, then open http://localhost:3000
```

Open your browser to **http://localhost:3000** and you should see the live fleet.

### Building a real dome

If you'd like to assemble a physical dome, the friendly step-by-step build guide lives in
[`docs/HARDWARE.md`](docs/HARDWARE.md). It covers the parts list, exact wiring, and safety notes.
The firmware in `src/` is a PlatformIO project for the ESP8266 — power users can flash it by
editing the WiFi and broker settings near the top of `src/main.cpp`.

---

## A gentle FAQ

**Do I need to be a programmer to use this?**
No. The dashboard runs with a few simple commands, and the hardware guide is written for beginners.

**What if a dome disconnects or loses power?**
The dashboard marks it offline, then removes it from the list. When the dome comes back it
reappears automatically, and the activity log notes what happened.

**Do the domes send sound recordings?**
No. Domes only send a short, tiny snapshot used to measure *loudness* (thousands of times a
second, and mostly in the form of a level value). No audio is recorded or stored.

**Is this private / local?**
Yes. Everything runs on your own network and your own computer. The dashboard talks directly to
your local MQTT broker — your noise data never has to leave your house.

---

## License

This is an open, personal project. Feel free to explore, modify, and build upon it.

*Acoustic Dome — listen to your space.*