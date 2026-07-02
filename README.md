# routing

A **phone-first** map tool for quickly sketching a route (running / cycling / walking / driving),
seeing the length **instantly**, having the rough sketch **matched onto real paths** suited to the
activity, and **exporting GPX** with an accurate length.

> **North-star — low friction, high precision: nobody is hindered.** Easy to pick up, a precision
> knife in the hands of an expert. Low floor (tap a few points, zero setup, forgiving imprecise taps,
> good activity defaults), high ceiling (the same tiny primitive set — points, zoom-as-precision,
> sub-mode, live length — gives exact, fast control). The test for every feature: does it hinder
> anyone — the novice via complexity, or the expert via hand-holding? If so, it's a design bug.

## How it works (server-first)

- **The browser is thin JS + [Leaflet](https://leafletjs.com/):** the map (OSM base + Waymarkedtrails
  overlay), the draggable rough points, the instant rough length, drawing the matched route, and a
  plain **WebSocket** to the server. No loft in the browser.
- **loft runs native on a server** ([loft](https://github.com/loft-lang/loft)): it downloads the
  road data (Overpass), **map-matches** the drawn line onto real ways, computes the length, and does
  GPX import/export. The heavy part lives on the server, so the phone downloads almost nothing.
- The match is **faithful, not scenic** — it cleans your sketch onto the nearest sensible ways; it
  never detours for a prettier road. Correct a wrong match by **moving the rough points** (zoom in
  for precision), never by editing the matched line.
- **Activity × sub-mode profiles** (running Fast/Trail, cycling Road/Gravel/MTB, walking Paved/Trail,
  driving Fastest/Avoid-motorways) make the *first* match good by default.

*(This replaced an earlier plan to run loft in the browser via WebAssembly — see DESIGN.md §3/§4 and
[docs/loft-feedback.md](docs/loft-feedback.md) for why. An offline, loft-in-browser "Mode A" is
deferred until loft ships a browser data-in primitive.)*

## Status — all 20 plan steps complete (v1 feature-complete)

Working end to end: **draw or import → activity-aware match that faithfully follows the line
(including loops) → export GPX.** Built + tested:

| Steps | What works |
|---|---|
| 1–3 | Static Leaflet shell · rough-point layer (tap/drag/insert/delete, distinct start/finish) · instant geodesic length |
| 4 | Native loft server, single-port HTTP + WebSocket; thin JS client |
| 5 | Server fetches the Overpass corridor (native `web.http_get`) |
| 6 + upgrade | Pure-loft **map-matcher** — deviation-dominated Dijkstra, routed **piecewise** through the trace so it covers loops/out-and-backs |
| 7 | Matched route + length drawn under the sketch (read-only) |
| 8 | Activity × sub-mode profiles (bounded tag-penalty tie-breaker) + Waymarkedtrails overlay |
| 9 | Round-trip inference (near start≈finish → the loop closes) |
| 10 · 11 | GPX **export** · GPX **import** (Douglas–Peucker + collapse → sparse editable route) |
| 12–14 | Multi-select + bulk delete · undo (Ctrl+Z / phone snackbar) · goal-length ±delta |
| 15 | **Elevation dock** — profile + ↑/↓ totals from AWS terrarium tiles (server fetch + decode, pure-loft sampling); closed by default, lag-tolerant |
| 16 | **Route store** — named save/open/delete (disk-is-the-store, write-through) + the working sketch autosaves and **survives closing the browser** |
| 17 | **Auto-proposed names** — "Benschop · 2.1 km · Trail run": area (Nominatim) · length · type prefills the save field; typing wins |
| 19 | **Live sync** — open the same route in two browsers: an edit in one appears in the other (echo-free); late joiners see the current state |
| 20 | **Gesture-fresh persistence** — every committed edit persists instantly (no debounce window); kill the tab any time, nothing is lost |
| +  | **Post-v1 sweep** — candidate-set Viterbi matcher (a tap between parallel ways resolves by *activity*) · tight `around:` corridor + adaptive widening · draft save (undo history survives a reload) |

**Deferred (post-v1):** offline Mode A (blocked upstream), WGS84-ellipsoidal length, box/lasso
select, GPX retrace flagging, elevation crosshair. See **[PLAN.md](PLAN.md)** for the exact
status of every step. (Step 18 folded into step 4 by the server-first pivot.)

## Run it

Needs the [loft](https://github.com/loft-lang/loft) toolchain at `../loft` (a sibling checkout) and
`rustc`. From the repo root:

```bash
loft --native server/server.loft --lib lib      # build + run the native loft server
# → open http://localhost:18080 and start tapping points
```

The server serves the static client and the WebSocket on one port. (First build compiles the loft
runtime + the vendored `server`/`web` crates — give it a minute. Kill it by **port** —
`fuser -k 18080/tcp` — not the wrapper, since `loft --native` detaches the compiled binary.)

## Test

```bash
loft --tests lib/routing_kernel/tests/<name>.loft --lib lib   # kernel unit tests (add --native for parity)
./tools/kernel_headless_test.sh                               # kernel geodesic on wasip2 via wasmtime
./tools/server_test.sh                                        # server: HTTP serve + WS round-trip
./tools/elevation_test.sh                                     # elevation from a synthetic cached tile (offline)
./tools/client_elev_test.sh                                   # elevation dock in headless Chromium (offline)
./tools/routes_test.sh                                        # named route store + autosave over WS (offline)
./tools/client_routes_test.sh                                 # routes panel + reload-restore in headless Chromium
./tools/sync_test.sh                                          # live sync, 3 WS clients (offline)
./tools/client_sync_test.sh                                   # live sync across two headless-Chromium tabs
```

Kernel tests cover the geodesic, corridor parse, matcher, profiles, round-trip, loop, GPX export,
import cleaning, and the elevation profile — all asserted **interpret == native**. Client behaviour
(rough layer, undo, goal, elevation dock, routes panel) is checked with headless-Chromium harnesses.

## Layout

```
index.html            static client shell
app.js geo.js rough.js ws.js controls.js gpx.js undo.js elevation.js routes.js   client modules (see docs/ARCHITECTURE.md)
vendor/leaflet/       vendored Leaflet (no CDN)
server/server.loft    the native loft server (HTTP + WebSocket + terrain tiles)
lib/routing_kernel/   pure-loft compute (geodesic, corridor, matcher, GPX, cleaning, elevation) + tests
lib/server, lib/web, lib/imaging   vendored loft registry libs (patched/extended — see docs/loft-feedback.md)
tools/                test harnesses
```

## Docs

- **[DESIGN.md](DESIGN.md)** — the design (what & why).
- **[PLAN.md](PLAN.md)** — the 20-step build plan with per-step status.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how it's built: components, the WS protocol, the
  kernel API, build/run/test, and known limitations.
- **[docs/loft-feedback.md](docs/loft-feedback.md)** — gaps found in loft while building (for the loft team).

Sibling consumer of the loft language (expected at `../loft`).
