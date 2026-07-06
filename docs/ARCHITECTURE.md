# routing — architecture & developer reference

A snapshot of how the project is built as of 2026-07-02 (Phases 1–2 complete; Phase 3 steps 12–14
done). DESIGN.md is the *intent*; PLAN.md is the *per-step status*; this is the *current shape* —
components, the wire protocol, the kernel API, and how to build/run/test.

## Topology — server-first

```
┌─ browser (thin) ─────────────┐         ┌─ loft server (native) ───────────────┐
│ Leaflet map + rough points   │  WS     │ server.loft  (lib server: HTTP + WS)  │
│ geo.js  instant JS length    │◄──────► │ web          Overpass HTTP + WS       │
│ ws.js   WebSocket client     │  :18080 │ routing_kernel  geodesic · corridor · │
│ draws the matched route      │  HTTP   │   matcher · GPX · import cleaning     │
└──────────────────────────────┘         └───────────────────────────────────────┘
                                              │  web.http_get → Overpass (OSM)
```

One port serves the static client (HTTP) and the sync channel (WebSocket at `/ws`). The browser runs
**no loft** — it draws pixels and sends/receives text frames. loft runs **native** on the server,
where it has full HTTP/files. (Why not loft-in-the-browser: DESIGN.md §3/§4 + docs/loft-feedback.md.)

## Components

### Client (static files, no build step)
| File | Role |
|---|---|
| `index.html` | shell: map div, HUD readouts, controls, script tags |
| `geo.js` | `geodesicMeters` (WGS84 Vincenty — same algorithm as the kernel, f64-identical), `roughLength`, `formatDistance` — the **instant** JS length (every frame) |
| `rough.js` | `RoughLayer`: ordered rough points, markers, straight-line polyline; tap-place / drag / insert / delete; **contiguous range** select (two anchors, or SHIFT+drag box — spans the boxed points); `setPoints`; emits `onChange(points, committed)` |
| `app.js` | creates the map (initial view: remembered localStorage view → timezone-city locate → Vondelpark default) + the read-only "detailed" pane; wires `rough.onChange` → undo → `ws.sendPoints`; goal length remembered PER ACTIVITY; shared toast |
| `ws.js` | WebSocket client: match (debounced on edit-release), export (phone: native share sheet → Garmin Connect; else download), import; draws the matched route |
| `controls.js` | activity + sub-mode selectors → the match profile (last USER selection remembered per-browser; a restored sketch's profile overrides at runtime without rewriting the preference); Waymarkedtrails overlay switch + a "Paths" hide-toggle (DESIGN §7), remembered too; the MTB sub-mode swaps the BASE map to CyclOSM (mtb:scale grading, unsigned singletrack), also gated by the toggle |
| `gpx.js` | Export button; Import file input (parses `.gpx` with `DOMParser`) |
| `undo.js` | per-session snapshot history; `Ctrl/Cmd+Z` / `Shift+Z` / `Ctrl+Y`; bulk-delete snackbar |
| `elevation.js` | bottom-dock elevation profile (canvas, pointer crosshair with distance·elevation label) + ↑/↓ totals; closed by default, open state remembered per-browser; requests `10:` on open / re-match — the **lag-tolerant** tier |
| `routes.js` | named-route panel (save/list/open/delete, closed by default) + the silent `_working` restore at first connect + the proposed-name prefill (typed text wins) |
| `geolocate.js` | OPT-IN device location, ◎ cycles off→show→follow: SHOW pans only when the device moves out of view; FOLLOW centres the map (drag drops the lock) and runs the progress-anchored route projection ("done · left", walked-part priority, off-route freeze); prompt only on the button, remembered opt-in resumes as SHOW when already granted |
| `vendor/leaflet/` | Leaflet 1.9.4, vendored (no CDN) |

### Server
- `server/server.loft` — `use server; use web; use imaging; use routing_kernel`. Single-port
  HTTP+WS event loop (`server::listen` + `srv.poll_event`/`run`), serves the static files with
  `#cwd`, dispatches WS messages. Constants: `PORT=18080`, `CORRIDOR_MARGIN_M=30`,
  `ROUND_TRIP_RATIO=0.25`, `IMPORT_EPSILON_M=8`, `IMPORT_MIN_SEP_M=2`, `OVERPASS` endpoint;
  elevation: `TERRAIN_URL` (AWS terrarium), `TILE_CACHE_DIR=scratch/tiles`, `ELEV_MAX_ZOOM=13` (default when the client sends no zoom; clamp `ELEV_ZOOM_MIN=9`/`ELEV_ZOOM_MAX=15`),
  `ELEV_MAX_TILES=12`, `ELEV_MAX_SAMPLES=400`, `ELEV_STEP_MIN_M=25`, `ELEV_HYST_M=3`.
- Terrain tiles are fetched with `web::http_get_file` (binary-safe download-to-file; added to the
  vendored web lib — `http_get` mangles binary bodies through UTF-8), disk-cached under
  `scratch/tiles/`, PNG-decoded with `imaging`, and handed to the kernel as plain height grids.
- **Named route store (step 16):** `routes/` holds one file per route (display name / profile /
  points; filename = a safe slug). The **disk is the store** — list scans the dir, save writes,
  delete unlinks — so persistence is write-through by construction and restarts are safe. The
  working sketch autosaves under `_working` on every match request, before the corridor fetch.
- **Live sync (step 19):** the server's only in-memory state — `SyncState{subs: [{cid, name}]}`,
  captured by the `run` lambda (heap-struct field mutation aliases). Opening/saving a non-`_`
  route subscribes that connection; an accepted edit write-through saves the named route and
  fans out msg 23 (with the match) to the other subscribers; a failed send drops the
  subscription. Concurrency is last-writer-wins.

### Kernel — `lib/routing_kernel/` (pure loft, target-agnostic)
The compute surface. Public API:
- **Types:** `GeoPoint{lat,lon}`, `BBox`, `Way{highway,surface,tracktype,coords}`, `Graph`.
- **Geodesic:** `geodesic_ll`, `geodesic_m`, `path_length_m` — WGS84 Vincenty inverse (~0.5 mm; geo.js mirrors it f64-identically).
- **Corridor:** `bounds(pts, margin_m)`, `overpass_query(bbox)`, `parse_ways(json)`.
- **Match:** `build_graph(ways)`, `match_route(g, trace, profile)`, `match_route_closed(g, trace, profile, ratio)`, `is_round_trip(start, finish, total_m, ratio)`, `way_penalty(profile, hw, surface, tracktype)`.
- **GPX / import:** `gpx_export(points, name)`, `douglas_peucker(points, eps_m)`, `clean_track(points, eps_m, min_sep_m)`, `retrace_m(points, eps_m)`.
- **Elevation (step 15):** `TileHeights{tx,ty,heights}`, `ElevProfile{up,down,samples}`,
  `tile_xf/tile_yf/tile_key` (slippy math), `terrarium_h(r,g,b)`, `elev_tiles_for(pts, zoom)`,
  `elev_zoom(pts, max_z, max_tiles)`, `updown(heights, hysteresis_m)`,
  `elev_profile(pts, tiles, zoom, step_m, hysteresis_m)`. The kernel never fetches or decodes —
  it consumes pre-decoded height grids, keyed by INTEGER tile coords (see loft-feedback.md:
  constructed-text args to `float?`-returning fns miscompile under `--native`).

Tests in `lib/routing_kernel/tests/*.loft` (corridor, matcher, profiles, roundtrip, loop, gpx,
import, elevation), all asserted **interpret == native**.

## WebSocket protocol (text frames `<id>:<payload>`)

| Send (client→server) | Reply (server→client) | Purpose |
|---|---|---|
| `4:<profile>\|<lat,lon;…>` | `5:<length_m>\|<lat,lon;…>` | **match** — the matched route + length (drawn under the sketch); sent debounced on edit-release |
| `6:<name>\|<profile>\|<lat,lon;…>` | `7:<gpx>` | **export** — matched route as GPX 1.1 with the route's real name (XML-escaped) and per-point `<ele>` from the terrain tiles (Garmin ClimbPro needs them; offline degrades to a bare track) |
| `8:<lat,lon;…>` | `9:<retrace_m>\|<lat,lon;…>` | **import** — clean a raw GPX track into a sparse rough route; a substantial retrace (`retrace_m`) is flagged with a toast, never silently edited |
| `10:<mapzoom>\|<lat,lon;…>` | `11:<up_m>\|<down_m>\|<d,e;…>` | **elevation** — profile of the DETAILED route the client sends back (no re-match); requested only while the dock is open. The MAP zoom (clamped 9–15) is the terrain-tile zoom ceiling — resolution follows what you're looking at (bare `<points>` form = the z13 default) |
| `12:<name>\|<profile>\|<pts>` | `13:<name>⏎<name>…` | **save** a named route (write-through to disk); reply = the updated list |
| `14:` | `13:<name>⏎…` | **list** saved routes (reserved `_`-names hidden) |
| `16:<name>` | `17:<name>\|<profile>\|<pts>\|<history>` | **open** a saved route (bare `17:` when unknown); `16:_working` restores the autosaved sketch WITH its undo stack (history is empty for named routes) |
| `18:<name>` | `13:<name>⏎…` | **delete** a saved route; reply = the updated list |
| `20:<profile>\|<pts>` | `21:<proposed name>` | **name proposal** — "area · length · type" (area via Nominatim midpoint reverse-geocode; degrades to "length · type" offline); prefills the panel's name input, typed text wins |
| — | `23:<name>\|<profile>\|<rough>\|<len>\|<matched>` | **live sync** (server-pushed): a peer's accepted edit of the shared route you're on (subscribed via open/save). Carries the server's match, so the receiver applies without re-requesting — echo-free |
| `26:<city>` | `27:<lat>\|<lon>` | **locate** — forward-geocode the IANA timezone's city ("Europe/Amsterdam" → "Amsterdam"; Nominatim); requested only for a truly fresh map (no remembered view, no sketch), applied only while the view is untouched |
| `24:<profile>\|<pts>\|<history>` | `25:` | **instant persist** — sent on every COMMITTED edit (and on reconnect), un-debounced: saves `_working` (its SINGLE writer; history = the undo stack, "#"-separated snapshots ≤30, stored as line 4) + the subscribed route (history-free), no match, no fan-out |
| `1:<lat,lon;…>` | `2:<length_m>` | rough geodesic length — a server-side diagnostic; the live client doesn't send it |
| `2:<lat,lon;…>` | `3:<way_count>` | corridor probe — diagnostic |

`<profile>` = `<activity>_<submode>`, e.g. `running_trail`, `cycling_road`.

## The matcher (step 6 → the §10.2 full matcher)

1. `build_graph`: nodes are OSM way vertices **deduped by exact coordinate** (validated on real data:
   shared intersection nodes have identical coords → one connected graph). Edges = way segments in a
   **flat list** (not a nested adjacency — that hit a loft O(n²) perf bug, [loft-lang/loft#475](https://github.com/loft-lang/loft/issues/475); Dijkstra scans the edge list, O(V·E)).
2. `match_route` — **candidate sets + Viterbi**: per tap, every node within tap accuracy
   (`ANCHOR_BAND_M` = 25 m of the nearest, max `VITERBI_K` = 4) is a candidate anchor; the route is
   the globally least-cost assignment over all combinations, where a piece's cost is
   `length · (1 + DEV_K·deviation_to_that_segment + way_penalty)` (`DEV_K=3`, deviation-dominant;
   `way_penalty ∈ [-0.7,+2]` the bounded activity tie-breaker) plus `EMIT_K`·anchor-distance. So a
   tap drawn between two parallel ways resolves by **activity**, not float luck; one candidate
   degenerates to plain nearest-node piecewise matching. Pieces still cover the **whole trace**
   (loops, out-and-backs); an unreachable stage freezes the best prefix and restarts (a gap).
   One `dijkstra_tree` per (stage, source-candidate) serves all next-stage targets.
3. `match_route_closed` appends a closing segment when `is_round_trip` (start≈finish relative to
   total length, ratio 0.25).
4. **Corridor download**: Overpass `around:<margin>` along the Douglas–Peucker-decimated rough
   polyline (`overpass_corridor_query` — a sliver, not a bbox); an empty match **adaptively
   widens** 3× (30→90→270 m), and a non-200 retries (Overpass 504s are routine).

## Build & run

Prereqs: a sibling `../loft` checkout (built), `rustc` + `wasm32-*` targets, `wasm-opt`, `node`,
`chromium`, `wasmtime`. From the repo root:

```bash
loft --native server/server.loft --lib lib     # build + run the server on :18080
```

Deps: `routing_kernel`, `server`, `web` all resolve via **`--lib lib`** (all vendored locally; the
`loft.toml` has no `[dependencies]`). `#cwd` in `server.loft` means it serves the static files from
the launch directory, so run it from the repo root.

## Test

```bash
loft --tests lib/routing_kernel/tests/<name>.loft --lib lib          # unit (add --native for parity)
./tools/kernel_headless_test.sh                                      # geodesic on wasip2 via wasmtime
./tools/server_test.sh                                               # HTTP serve + WS length round-trip
./tools/elevation_test.sh                                            # WS elevation from a SYNTHETIC cached tile (offline)
./tools/client_elev_test.sh                                          # elevation dock in headless Chromium (CDP, offline)
./tools/routes_test.sh                                               # named store + _working autosave over WS (offline)
./tools/client_routes_test.sh                                        # routes panel + reload-restore in headless Chromium (CDP)
./tools/sync_test.sh                                                 # live sync, 3 WS clients: broadcast/no-echo/replay (offline)
./tools/client_sync_test.sh                                          # live sync across two headless-Chromium tabs (CDP)
```

- Kernel logic is gated deterministically (interpret == native). The **live match/export/import**
  hit the public Overpass API (rate-limited, needs a User-Agent) so they're proven ad hoc but are
  **not** committed CI gates. Same for live terrain tiles — the committed elevation gates run from
  a synthetic tile pre-placed in the cache (`tools/make_terrarium_tile.loft`).
- Client behaviour (rough layer, undo, goal) is checked with throwaway headless-Chromium harnesses
  (build one, `--dump-dom`, assert, delete). Snap Chromium only reads non-hidden files under `$HOME`,
  so harnesses must live under the home workspace, not `/tmp`. For flows that must WAIT on a real
  WS round-trip, `--dump-dom` fires too early — drive the page over the DevTools protocol instead
  (`tools/cdp_elev.mjs`: plain node WebSocket + `Runtime.evaluate awaitPromise`, no puppeteer).

## Vendored dependencies — `lib/server`, `lib/web`, `lib/imaging`

`server` (0.2.0) and `web` (0.2.2) are loft registry packages, but their shipped source **doesn't
compile under loft 2026.6.0**: `try_recv`/`next` return `text` with `return null` (must be `text?`).
We vendored both into `lib/` with that one-line fix and resolve them via `--lib`. Proper fix is
upstream — docs/loft-feedback.md Part 2 #6 (and it's why `loft.toml` lists no registry deps).
`imaging` (0.2.0, PNG decode for terrain tiles) is vendored unmodified; `web` additionally carries
our `http_get_file` (binary-safe download-to-file — upstream candidate, see loft-feedback.md).
`native-auto/`, `native/target/`, `*.so` are build artifacts (gitignored).

## Known limitations & deferred work

- **Matcher:** a PARTIAL gap (one unreachable piece inside an otherwise-matched trace) doesn't
  trigger corridor widening — only a fully-empty match does. Candidate anchors are graph NODES;
  a tap far from any vertex of the right way can still anchor elsewhere (edge-projection anchors
  are the next refinement).
- **Length** is the WGS84 geodesic (Vincenty inverse, ~0.5 mm) — validated against the analytic equatorial arc and Karney/geographiclib; kernel and geo.js produce bit-identical f64s.
- **Elevation:** nearest-pixel sampling (no bilinear/tile-seam blend) at z ≤ 13 — fine for ↑/↓
  totals, a touch steppy on a zoomed-in profile.
- **Route store:** every committed edit persists instantly (msg 24 — step 20), so nothing is lost
  to the match debounce. Deleting all points doesn't clear `_working` (a reload restores the last
  real sketch — deliberate: never lose work).
- **Name proposal:** the Nominatim lookup runs on the single-threaded event loop, so a slow
  reverse-geocode briefly delays other replies (fine single-user; queue it when 19 lands).
- **GPX share sheet:** `navigator.share` (the phone→Garmin handoff) needs a SECURE context —
  HTTPS or localhost; a plain-http LAN address falls back to a normal download (then: download
  notification → open with Garmin Connect). Serving TLS would unlock the one-tap path on LAN.
- **Live sync:** last-writer-wins on concurrent edits of the same route (no merge/OT); the sync
  unit is the accepted (debounced) edit, so mid-drag states don't stream.
- **Corridor cache:** Overpass responses are disk-cached forever by query hash
  (`scratch/corridor/`) — editing the same sketch re-fetches nothing, and a 429 gets one polite
  retry. Stale roads only refresh after wiping the cache dir (fine for a personal tool).
- **All 20 plan steps are complete** (18 folded into 4 by the server-first pivot), plus the
  post-v1 sweeps: full candidate-set matcher, tight corridor + widening, draft saves with undo
  history, WGS84 geodesic length, elevation crosshair, GPX retrace flagging, box select. Still
  deferred: offline Mode A and async Nominatim/Overpass (both blocked upstream), a touch lasso
  (see PLAN.md).
- **Offline "Mode A"** (loft in the browser via `--html`) is deferred — blocked on an upstream loft
  browser data-in primitive (docs/loft-feedback.md Part 1).
- **Client:** box/lasso select (tap-first-last works instead); flagging *substantial* GPX retraces
  (auto-collapse of degenerate ones is in).

## Operational notes

- **Kill the server by port:** `loft --native` detaches the compiled binary (`loft_native_bin`), so
  killing the `loft` wrapper leaks the server. Use `fuser -k 18080/tcp`.
- **git identity** is set locally in this repo (`jjstwerff` / `j.stellingwerff@gmail.com`).
- In a sandboxed shell, `gh` and localhost serving/curl need sandbox-off; local file reads are fine.
- loft toolchain facts (what's real vs. what DESIGN.md first assumed) are in docs/loft-feedback.md.
