# xr-experiments

A public catalog of adaptive WebXR experiments — **Meta Quest 3 first**, phone AR and desktop next. Two shelves, two stacks:

- **[`xrblocks/`](xrblocks/)** — built on [Google XR Blocks](https://github.com/google/xrblocks) + three.js. Plain static folders, no build step, import-map CDNs. Depth sensing, hand gestures, spatial UI; each runs in AR on Quest 3 / Android XR and falls back to the desktop simulator elsewhere.
- **[`8thwall/`](8thwall/)** — 8th Wall / A-Frame camera AR for phones, each with its own webpack config.

One push to `main` rebuilds everything and publishes the catalog to GitHub Pages.

## The experiments

| Experience | Stack | What it does | Status |
|---|---|---|---|
| [REALITY//FIELD](xrblocks/reality-field/) | XR Blocks | The room becomes a physical field: impulses hit real geometry, waves ripple through particles; pinch/palm/fist/spread gestures; DEBUG and DREAM reality modes | playable |
| [WEATHER//ROOM](xrblocks/weather-room/) | XR Blocks | Live outside weather rendered inside your room (Open-Meteo, one request); hand-scrubbed −24h…+24h timeline | playable |
| [CITY//ORBIT](xrblocks/city-orbit/) | XR Blocks | Your street from OpenStreetMap as a tabletop hologram or 360° shell; pull POIs up into cards; scale the city between two hands | playable* |
| [SOUND//SPACE](xrblocks/sound-space/) | XR Blocks | Microphone sound sculpted into 3D structures in real time; freeze phrases into glowing sculptures, walk through the history | playable |
| [ECHO//ROOM](xrblocks/echo-room/) | XR Blocks | Every action leaves a 60-second trail; tap an old trace to unfold NOW/−1s…−4s temporal layers around it | playable |
| [Knockdown](8thwall/knockdown/) | 8th Wall | Knock physics towers off your table | playable |
| [Portal](8thwall/portal/) | 8th Wall | Place a portal on a real wall, peek through | playable |
| [Sea Battle](8thwall/sea-battle/) | 8th Wall | Classic naval battle laid out in your room | playable |

## Repository layout

```
xrblocks/               no-build XR Blocks experiences (one folder each)
  <name>/index.html     import map + HUD
  <name>/main.js        the whole experience
  <name>/exp.json       catalog card: title, description, tags
  common/               shared HUD styles
8thwall/               8th Wall apps (webpack, one folder each)
scripts/build-all.js    builds 8th Wall dists, copies xrblocks/, assembles _site/
index.html              the catalog landing page (renders manifest.json)
_site/                  build output served by GitHub Pages (generated)
```

## Adding an experience

- **XR Blocks:** create `xrblocks/<name>/` with `index.html` (import map → `three`, `xrblocks` on jsDelivr) and `main.js`. Add an `exp.json` card. That's it — the catalog picks the folder up on the next build.
- **8th Wall:** create `8thwall/<name>/` with `config/webpack.config.js` emitting `dist/` (see any existing one), then wire `build:<name>` / `serve:<name>` scripts in `package.json`.

## Running locally

```bash
npm ci
npm run build                        # builds everything into _site/
npx http-server _site -c-1 -p 8090   # open http://127.0.0.1:8090
```

XR, camera, microphone and geolocation require HTTPS (or localhost); on a phone use the QR codes on the catalog page of the deployed site. For a single 8th Wall experience during development use `npm run serve:<name>`.

## Deploy

GitHub Actions (`.github/workflows/deploy.yml`) on every push to `main`: `npm ci` → `npm run build` → publish `_site/` to Pages. Nothing manual.

\* CITY//ORBIT works live when the public Overpass mirrors answer; when they throttle, it falls back to an offline demo quarter so the experience never dies.

## Credits

- [XR Blocks](https://github.com/google/xrblocks) by Google — Apache-2.0
- [8th Wall](https://www.8thwall.com/) engine, [A-Frame](https://aframe.io/), [three.js](https://threejs.org/)
- Data: [Open-Meteo](https://open-meteo.com/) and [OpenStreetMap](https://www.openstreetmap.org/) via Overpass (used lightly, with caching and mirror failover)
