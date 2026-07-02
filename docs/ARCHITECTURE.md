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
| `geo.js` | `haversineMeters`, `roughLength`, `formatDistance` — the **instant** JS length (every frame) |
| `rough.js` | `RoughLayer`: ordered rough points, markers, straight-line polyline; tap-place / drag / insert / delete; **contiguous range** select (two anchors); `setPoints`; emits `onChange(points, committed)` |
| `app.js` | creates the map + the read-only "detailed" pane; wires `rough.onChange` → instant length (+ goal ±delta) → `ws.sendPoints` → `undo.record` |
| `ws.js` | WebSocket client: match (debounced on edit-release), export, import; draws the matched route |
| `controls.js` | activity + sub-mode selectors → the match profile; Waymarkedtrails overlay switch |
| `gpx.js` | Export button; Import file input (parses `.gpx` with `DOMParser`) |
| `undo.js` | per-session snapshot history; `Ctrl/Cmd+Z` / `Shift+Z` / `Ctrl+Y`; bulk-delete snackbar |
| `vendor/leaflet/` | Leaflet 1.9.4, vendored (no CDN) |

### Server
- `server/server.loft` — `use server; use web; use routing_kernel`. Single-port HTTP+WS event loop
  (`server::listen` + `srv.poll_event`/`run`), serves the static files with `#cwd`, dispatches WS
  messages. Constants: `PORT=18080`, `CORRIDOR_MARGIN_M=30`, `ROUND_TRIP_RATIO=0.25`,
  `IMPORT_EPSILON_M=8`, `IMPORT_MIN_SEP_M=2`, `OVERPASS` endpoint.

### Kernel — `lib/routing_kernel/` (pure loft, target-agnostic)
The compute surface. Public API:
- **Types:** `GeoPoint{lat,lon}`, `BBox`, `Way{highway,surface,tracktype,coords}`, `Graph`.
- **Geodesic:** `haversine_ll`, `haversine_m`, `path_length_m` (spherical haversine; ellipsoidal is deferred).
- **Corridor:** `bounds(pts, margin_m)`, `overpass_query(bbox)`, `parse_ways(json)`.
- **Match:** `build_graph(ways)`, `match_route(g, trace, profile)`, `match_route_closed(g, trace, profile, ratio)`, `is_round_trip(start, finish, total_m, ratio)`, `way_penalty(profile, hw, surface, tracktype)`.
- **GPX / import:** `gpx_export(points, name)`, `douglas_peucker(points, eps_m)`, `clean_track(points, eps_m, min_sep_m)`.

Tests in `lib/routing_kernel/tests/*.loft` (corridor, matcher, profiles, roundtrip, loop, gpx,
import), all asserted **interpret == native**.

## WebSocket protocol (text frames `<id>:<payload>`)

| Send (client→server) | Reply (server→client) | Purpose |
|---|---|---|
| `4:<profile>\|<lat,lon;…>` | `5:<length_m>\|<lat,lon;…>` | **match** — the matched route + length (drawn under the sketch); sent debounced on edit-release |
| `6:<profile>\|<lat,lon;…>` | `7:<gpx>` | **export** — matched route as a GPX document (JS downloads it) |
| `8:<lat,lon;…>` | `9:<lat,lon;…>` | **import** — clean a raw GPX track into a sparse rough route |
| `1:<lat,lon;…>` | `2:<length_m>` | rough haversine length — a server-side diagnostic; the live client doesn't send it |
| `2:<lat,lon;…>` | `3:<way_count>` | corridor probe — diagnostic |

`<profile>` = `<activity>_<submode>`, e.g. `running_trail`, `cycling_road`.

## The matcher (step 6 + the depth upgrade)

1. `build_graph`: nodes are OSM way vertices **deduped by exact coordinate** (validated on real data:
   shared intersection nodes have identical coords → one connected graph). Edges = way segments in a
   **flat list** (not a nested adjacency — that hit a loft O(n²) perf bug, [loft-lang/loft#475](https://github.com/loft-lang/loft/issues/475); Dijkstra scans the edge list, O(V·E)).
2. `match_route` routes **piecewise through consecutive trace points** — each segment is its own
   least-cost path, `cost = length · (1 + DEV_K·deviation_to_that_segment + way_penalty)`
   (`DEV_K=3`, deviation-dominant so it hugs the drawn line; `way_penalty ∈ [-0.7,+2]` is a bounded
   activity tie-breaker). Piecewise = it **covers the whole trace** (loops, out-and-backs); a 2-point
   trace is a single piece where activity decides between parallel start→finish ways.
3. `match_route_closed` appends a closing segment when `is_round_trip` (start≈finish relative to
   total length, ratio 0.25).

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
```

- Kernel logic is gated deterministically (interpret == native). The **live match/export/import**
  hit the public Overpass API (rate-limited, needs a User-Agent) so they're proven ad hoc but are
  **not** committed CI gates.
- Client behaviour (rough layer, undo, goal) is checked with throwaway headless-Chromium harnesses
  (build one, `--dump-dom`, assert, delete). Snap Chromium only reads non-hidden files under `$HOME`,
  so harnesses must live under the home workspace, not `/tmp`.

## Vendored dependencies — `lib/server`, `lib/web`

`server` (0.2.0) and `web` (0.2.2) are loft registry packages, but their shipped source **doesn't
compile under loft 2026.6.0**: `try_recv`/`next` return `text` with `return null` (must be `text?`).
We vendored both into `lib/` with that one-line fix and resolve them via `--lib`. Proper fix is
upstream — docs/loft-feedback.md Part 2 #6 (and it's why `loft.toml` lists no registry deps).
`native-auto/`, `native/target/`, `*.so` are build artifacts (gitignored).

## Known limitations & deferred work

- **Matcher:** an intermediate point drawn *exactly* between two parallel ways snaps to one (full HMM
  candidate-set Viterbi would let activity decide there too). The corridor is a **bbox+margin**, not
  a tight polyline buffer. No **adaptive widening** on a gap yet (an unreachable piece leaves a gap).
- **Length** is spherical haversine; the WGS84-ellipsoidal upgrade is deferred.
- **Phase 3 remaining:** elevation chart (15 — loft decodes terrain tiles via `imaging`), server
  route store + close-the-browser-safe persistence (16), auto-proposed names (17 — Nominatim).
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
