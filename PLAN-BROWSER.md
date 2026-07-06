# Route Planner — Browser-Only (Serverless) Plan

A path to running the whole app **in the browser**: map-data retrieval and route computation happen
client-side, and a server becomes **optional** — used only to *store* routes (and sync individual
edits across devices), never required to compute or draw. Companion to **[PLAN.md](PLAN.md)** (the
server-first build) and **[DESIGN.md](DESIGN.md)** (the *what* and *why*).

**How to use this file.** Same contract as PLAN.md: each step has a **Goal**, a **Build** list, and a
**Check** — an observable pass/fail you run before moving on. A step is done only when its Check
passes. Phase 0 de-risks the unknowns *before* any UI work; do not skip it. `[VERIFIED]` marks a Check
already run during planning, with the command that produced it.

---

## Why this is viable now (the pivot revisited)

PLAN.md moved loft out of the browser on 2026-07-01 because `loft --html` ships no JS→loft data path
and the wasip2 route looked too heavy. Two facts have since changed the calculus:

- **The kernel is I/O-free.** All network/disk lives in `server/server.loft`; `lib/routing_kernel`
  is pure computation — and already includes `overpass_corridor_query` (builds the query), the
  matcher (`build_graph`, `match_closed_ex`, `match_incremental`, `match_state_*`), `gpx_export`,
  `clean_track`, and the elevation math (`terrarium_h`, `elev_profile`). Only *fetching* and *storing*
  are server-bound.
- **The kernel compiles to wasm and runs with identical output.** `--native-wasm` produces a working
  module. So a browser-only build reuses the matcher **with zero rewrite**; the only new code is JS
  glue for fetch + storage + wasm marshalling. The orchestration currently in `match_for`
  (the accumulating 15-min corridor cache, coverage test, widen-on-bridge, incremental `MatchState`)
  must be re-expressed in the browser engine — the kernel supplies the primitives.

**North-star unchanged:** the browser build must not hinder anyone — same instant length, same faithful
match, same tiny primitive set. Serverless is a *deployment*, not a feature the user has to think about.

---

## Phase 0 — De-risk (verify before building anything)

### Step 0.1 — Kernel runs as wasm with identical output  `[VERIFIED]`
- **Goal:** prove the matcher computes correctly as WebAssembly.
- **Build:** a tiny loft entry (`file(arg0)` = Overpass JSON, `arg1` = points) that prints
  `len|matched|bridges`; compile with `loft --native-wasm out.wasm --lib lib entry.loft`.
- **Check:** run in wasmtime and diff against the native binary on the same corridor + trace.
  `[VERIFIED]` — `wasmtime run --dir scratch::/s out.wasm /s/corridor_360.json "$pts"` printed
  `52506|matched 994 pts|2`, byte-identical to `--native-release`.

### Step 0.2 — Decide the wasm invocation model  ← **GATES incremental in-browser**
- **Goal:** determine whether we can keep a **resident** wasm instance with callable exports (needed to
  hold the `MatchState` + graph across edits, preserving the ~0.1 s incremental path), or only a
  **one-shot** wasip2 CLI (each call a fresh process — no persistent state).
- **Build:** (a) inspect exports (`wasm-tools component wit out.wasm`); (b) try `jco transpile` to a
  browser ES module and call an exported function twice from Node, reusing a handle; (c) check whether
  loft can emit chosen `pub fn`s as wasm-bindgen exports (how loft's own playground runs in-browser —
  see `../loft` `make wasm`).
- **Check:** a Node harness builds a graph once, then calls `update(points)` twice **without**
  rebuilding, and the second call is measurably faster (state reused). If impossible, record the
  fallback: rebuild-per-edit from cached corridor JSON (parse+build+match, ~sub-second in wasm) and
  proceed — Phase 4.2 becomes "fast rebuild" instead of "incremental."

### Step 0.3 — Overpass is reachable from the browser (CORS)
- **Goal:** confirm the browser can fetch the corridor directly, no proxy.
- **Build:** a one-line `fetch(OVERPASS, {method:'POST', body: query})` from a `localhost`/`file://`
  page.
- **Check:** DevTools Network shows `200` with `Access-Control-Allow-Origin` present and a ways body.
  Note the public-instance rate limit observed (429/504 handling feeds Phase 4).

### Step 0.4 — Bundle-size budget
- **Goal:** know the download cost before committing.
- **Build:** gzip the wasm (`gzip -9 out.wasm`); measure.
- **Check:** transferred size recorded (target: first load < a few MB, cached thereafter). The 0.1 raw
  module was ~5.8 MB; confirm the gzipped figure and decide if a smaller `--native-release`-style
  reachable-only wasm build is needed.

---

## Phase 1 — Headless compute core

### Step 1.1 — stdin/stdout match entry
- **Goal:** a single wasm entry the browser can drive: input = profile + points + Overpass JSON,
  output = `len|matched-polyline|bridge-segments` (the exact `5:` wire payload today).
- **Build:** `web/engine_entry.loft` importing the kernel; read input, call `match_closed_ex`, print
  the payload.
- **Check:** piping the real fixture through wasmtime yields the same payload the server sends for the
  same points (compare against a captured `5:` frame).

### Step 1.2 — Callable from JS
- **Goal:** the module is loadable and callable from a browser context.
- **Build:** transpile per the Step 0.2 outcome (jco + preview2 shim for wasip2, or wasm-bindgen
  exports); a thin `web/engine.js` wrapping load + `match(profile, points, overpassJson)`.
- **Check:** a Node/Playwright script loads `engine.js`, matches a fixture, and asserts the result
  equals the native output. Runs headless in CI.

---

## Phase 2 — Browser retrieval + draw (no server)

### Step 2.1 — Fetch the corridor in JS
- **Goal:** replace `web::http_post(OVERPASS, …)` with a browser `fetch`.
- **Build:** `engine.js` builds the query via the kernel's `overpass_corridor_query` (exported) or a
  JS mirror, POSTs to Overpass, hands the raw body to the wasm.
- **Check:** with **no server process running**, a scripted page fetches + matches a known route and
  logs a polyline matching the server's.
- **Note:** live Overpass is the *interim* data source — fine for early phases, but it does not scale
  for free (community rate limits) and is the wrong dependency for "widely available." The **target**
  data source is the self-hosted, range-sliced loft-store dataset in **Phase 8**; Overpass then becomes
  an optional fallback for uncovered areas / freshness.
- **Browser HTTP is a loft `web` library extension, not bespoke `engine.js`.** Both the interim Overpass
  fetch and the Phase-8 partial reads should be a fetch bridge inside loft's `web` module
  (`web::read_range` / a browser `http` backend), so loft code is uniform native↔browser and the app
  ships no hand-written transport JS. (See PLAN-TILES Phase D; async bridging ties to Step 0.2.)

### Step 2.2 — End-to-end draw, serverless
- **Goal:** the existing UI works against the local engine.
- **Build:** an engine adapter exposing the same surface `ws.js` expects (`sendPoints(points) →
  matched route`), selected when no server is configured; `app.js`/`rough.js` unchanged.
- **Check:** open the page offline-of-server (only Overpass reachable), sketch points, and the matched
  route + length appear. DevTools shows Overpass requests but **no** WebSocket.

---

## Phase 3 — Client storage (IndexedDB)

### Step 3.1 — Named-route store
- **Goal:** the route store (server `routes/` dir today) lives in the browser.
- **Build:** an IndexedDB-backed store mirroring the `12/14/16/18` (save/list/open/delete) semantics.
- **Check:** save a route, reload the page, list shows it, open restores it. DevTools → Application →
  IndexedDB shows the records.

### Step 3.2 — Instant persist of individual edits
- **Goal:** the "single writer" of `_working` (server msg 24 today) — every committed edit persisted
  immediately, undo history included.
- **Build:** write `_working` + undo stack to IndexedDB on each committed edit.
- **Check:** make an edit, kill the tab mid-session, reopen — the sketch and undo history are intact.

---

## Phase 4 — Session cache + incremental, in the browser

### Step 4.1 — Accumulating 15-min corridor cache
- **Goal:** port `match_for`'s cache: fetched corridors accumulate into one graph, a coverage test
  skips the network for areas already fetched, evicted 15 min after the last edit.
- **Build:** in `engine.js`, keep the accumulated ways + `covs` footprints + `last_use`; feed the union
  to the wasm; use `now()`/`Date.now()` for the TTL.
- **Check:** fetch area A, move to area B (fetch), move **back** to A — Network tab shows **zero**
  Overpass requests for the return to A (mirrors the server result: 15 s → 0.08 s).

### Step 4.2 — Incremental match across edits
- **Goal:** preserve ~0.1 s edits (per Step 0.2 outcome).
- **Build:** if resident instance available, hold the `MatchState` in the wasm instance and call
  `match_incremental`/`match_state_result` per edit; else rebuild from the cached union each edit.
- **Check:** move one in-corridor point; the redraw completes < 200 ms with no network. If on the
  fallback path, record the (higher) rebuild time so the tradeoff is explicit.

---

## Phase 5 — Elevation + GPX, client-side

### Step 5.1 — Elevation from the baked `h` (no runtime terrain fetch)
- **Goal:** the elevation profile without the server *and* without fetching terrain — the matched route's
  nodes already carry `h` (sampled from the DEM at generation, Phase 8 / PLAN-TILES B.4).
- **Build:** read `h` straight off the matched polyline's nodes for the profile; no PNG fetch/decode.
  (Fallback only for points off the tiled network — e.g. a bridged gap — fetch terrarium there.)
- **Check:** the profile (ascent/descent totals + curve) for a known route matches the server's
  terrarium-sourced profile within tile-noise tolerance, with **no terrain tiles fetched**.

### Step 5.2 — GPX export/import
- **Goal:** GPX round-trip in the browser.
- **Build:** call the kernel's `gpx_export` / `clean_track` from JS; download via Blob, import via file
  input.
- **Check:** export a route, re-import it, and the cleaned track matches the server's `9:`/`7:` output.

---

## Phase 6 — Optional sync server

### Step 6.1 — Server as optional mirror
- **Goal:** a server, *if configured*, stores/syncs; absence changes nothing functionally.
- **Build:** if a sync URL is set, forward committed edits over the existing WS protocol (`24`) and
  apply peer broadcasts (`23`); otherwise the app is fully local.
- **Check:** (a) with no server, every feature works offline-of-server; (b) with a server, an edit in
  one browser appears in a second browser on the same route.

---

## Phase 7 — Packaging & offline

### Step 7.1 — Self-contained static bundle
- **Goal:** ship as static files (any static host, or `file://`), working offline after first load.
- **Build:** bundle `index.html` + JS + `engine.wasm`; a service worker caches the wasm, static assets,
  and recently-used map tiles.
- **Check:** load once online, then go fully offline (airplane mode) and re-open — the app loads and can
  match within already-cached corridors; only brand-new ground needs Overpass.

---

## Phase 8 — Serverless data distribution: custom sliced loft-store dataset  *(future)*

The endgame for "widely available at ~zero server cost": stop querying a live API and instead **ship
the routable network as a static, range-sliceable file** the browser reads directly. This makes the
compute *and* the data serverless — a single file on a CDN, users pull KB per corridor, cost is CDN
egress (free/near-free on R2/B2), and regeneration is a periodic **batch job on your own machine**, not
a per-request server.

**The key insight (why this is cheap to build):** the on-disk format *is* loft's in-memory store
layout, so reading a slice needs **no parsing** — you map/load the bytes and the structures are
already there. loft already has the primitives: its data store is **offset-addressed, not
pointer-based** (`src/data_store.rs` — baked `u16`/`u32` field offsets), and it has a **store-persist +
`mmap` capability** (`n_store_persist_bind`, gated on the `mmap` feature). The only missing piece is
linking that store to a **remote** file.

**Verified facts this rests on:**
- HTTP **Range → `206 Partial Content`** is byte-accurate from real CDNs (checked: GitHub raw &
  jsDelivr returned `206` with correct `content-range` and exact bytes). `fetch(url,{headers:{Range}})`
  in the browser; supported by S3 / R2 / B2 and CDNs.
- The kernel already compiles to wasm and matches with byte-identical output (Phase 0.1).

**Linking store memory to a remote file — an in-store index, not a page-fault.** We explicitly reject an
on-demand / page-fault model. wasm memory is a single linear buffer that only grows at the *end*, so you
can't fault an arbitrary page into the middle mid-access, and a synchronous store read cannot `await` an
async fetch. We also do **not** load the whole dataset, nor even the whole corridor's tiles — that is too
much data. Instead:

- **The store carries its own index, and only the index is resident.** A small **spatial hash** lives
  *inside the store* — the very same `hash<>` construct the `Graph.index` already uses today — loaded
  once from a known region of the file. It maps a spatial key → the byte range(s) of the data slice(s)
  holding that area's ways. It is the routing table for the remote link; it is never the bulk data.
- **The bulk data is fetched selectively through that index.** A query is **two-phase**: (1) *plan* —
  walk the resident in-store hash for the (margin-buffered) corridor to enumerate the **exact minimal**
  set of data slices the query touches — hash lookups only, no bulk access; then `await` the Range
  fetches that load just those slices. (2) *execute* — `build_graph` over the loaded slices, then match.
- Slices are **self-contained** (offsets relative to the slice's own base, no cross-slice pointers), so a
  fetched slice is **appended at the current end of linear memory** and used immediately (its base noted
  in the index). Equivalently, written into the wasm virtual FS and `mmap`/loaded — same effect.
- Because phase 1 fully determines phase 2's footprint, **every store access in phase 2 succeeds and none
  triggers a fetch** — the completeness guarantee, without page-faults and without loading everything.
- Generalized as an async `ensure(region)`: walk the in-store hash for `region`, fetch the named slices,
  return once resident. Fetched slices cache in IndexedDB, so offline use and revisits need no network.

**Format requirement:** a **resident index region (the in-store spatial hash) + independent,
self-contained data slices** — not one monolithic store with cross-slice pointers (which would force
page-faulting to resolve). Each slice's offsets are relative to its own base, so any fetched subset
stands alone; boundary-crossing ways are **duplicated into every tile they touch**, so `build_graph`
merges the shared boundary nodes by coordinate with no cross-slice bookkeeping. Slices are ordered by a
space-filling curve (Hilbert / z-order) so a corridor's slices fall in a few *contiguous* Range requests
rather than scattered ones. The index maps spatial key → those slices' byte ranges within the same file.

**Concrete slice layout (a tile = one self-contained loft store):**

```
struct Step { x: u32, y: u32, h: u32 }     // fixed-point deltas from the tile origin; h = elevation (baked)
struct Road { tp: RoadType, flags: u8, steps: u8 }   // flags = 8-bit attrs, meaning keyed by tp:
                                                     //   road    → cycle_infra, unpaved, bridge, on_{hiking,cycling,mtb}_net
                                                     //   transit → service days: weekday, weekend, evening, night, seasonal, school
                                                     //   water   → depth class (shallow/med/deep), hazard, bridge clearance / opening
                                                     // steps = count of points taken from the pool, in order
struct Tile {
  x: u64, y: u64, h: u64,                   // origin in GLOBAL fixed-point units
  roads: vector<Road>,
  steps: vector<Step>,                      // shared point pool; roads slice it sequentially
}
```

- **Fixed-point, not float — for exact identity.** A point's global coordinate is `origin + delta` in
  pure integer arithmetic (origin and delta share one unit, e.g. 1e-7° ≈ 1 cm horizontal, 1 mm
  vertical). A shared node is therefore bit-identical in any tile that contains it, so `build_graph`'s
  index dedups by exact integer key and tile boundaries connect with no rounding drift or snapping
  tolerance. u32 deltas cover a large tile at that unit; the u64 origin keeps global precision.
- **Direction is implicit in step order.** A `*_oneway` class is "traversable only in the stored
  order"; the generator reverses `oneway=-1` ways so stored order is always the legal direction — no
  direction field.
- **Everything is baked at generation, read free at runtime.** `tp` from OSM ways+tags; `flags` from OSM
  route relations (`cycle_infra`; recreational-network membership — the same relations Waymarkedtrails
  renders — as the curated "nice path" bonus); per-point `h` sampled from the DEM (terrarium). So the
  client reads class, curated-network bonus, *and* elevation from one tile — **no runtime terrain fetch,
  no separate overlay lookup, fully offline.**

**`RoadType`** — a `u8` enum, the cost/legality lookup key. Extend by *appending*: a reader that
predates a value only needs its cost-table row, never a format change.

```
highway_oneway, motorway, road80, road60, road50, road50_oneway,
road30, road30_oneway, bicycle, bicycle_oneway, bicycle_lane, path,
footway, pedestrian, stairs, square
   … (extended when needed)
```

- **`bicycle`** = a segregated cycle track (one directional side). **`bicycle_lane`** = an
  **on-carriageway lane**: a single *bidirectional* polyline that carries the cycle-infra cost bonus and
  is **crossable / reversible at any point** — free, because it is one line (no connector edges, no
  node-only side-switch). Modeling a crossable bike road as one `bicycle_lane` line also avoids the
  "follow one side out, the other side back" retrace artifact.
- **`footway` / `pedestrian`** = *dismount*: a bike is allowed but must be **walked**, so a high (but
  finite) cost — a real bike route normally wins, yet it stays passable when it's the only option.
- **`stairs`** = *impassable*: an e-bike can't be carried up, so it's excluded outright (not just
  expensive).
- **`square`** = an open area you cross freely (market square, cycle-allowed plaza) — rideable,
  bidirectional, low cost. It has no linear geometry, so the *generator* renders it as **synthetic roads
  between the square's entrance nodes**, plus a few interior junction points where those crossings meet
  (a small visibility/star graph). The deviation cost then picks the crossing nearest the drawn line.
  Entrance nodes must share exact fixed-point coordinates with the roads that meet the square so
  `build_graph` stitches them.
- **Open water (nautical)** — the same open-area pattern, with a crucial simplification: sailors don't
  free-optimise, they pick from a **small decision set** (pilotage) — *follow the coast*, *follow the
  lane / channel*, *cross to a visible landmark* (steer for the church tower — a transit / leading
  line). So the generator stores a **curated decision graph**, not a dense mesh: nodes are decision
  points (headlands, harbour mouths, channel buoys) and **landmarks** (towers, lighthouses) you steer
  for; `Road`s are the legs a navigator would actually take — class `coast` (hug the shore), `channel`
  (a buoyed lane), `crossing` (a straight inter-visible leg to a landmark / decision point). Shore and
  hazards are impassable classes. **Depth rides both ways** — precise per-node in `h`, and a coarse
  **depth class in `flags`** (shallow/med/deep) for quick draft-gating + the on-map indicator; a
  *sailing* profile gates by draft (deep passable, land impassable) exactly as activity profiles gate
  road classes. **Bridges over water** use the `flags` bridge/clearance bit → a "restricted passage /
  opening bridge" indicator (same rough-not-exact premise as transit availability: shows *that* it's
  restricted, not the opening timetable). The de-noise matcher then cleans a rough sketch ("along the
  coast, then cross to the tower") onto those legs just as it does a road sketch — tiny, human-meaningful
  graph; wind/tacking stays out of scope (timing is weather-dependent).
- **Class → cost/legality is a table, not hardcoded branches**, so adding a class is a data change.

**Generator / loader conventions this relies on:**
- *Generator:* split ways at intersections (so a shared node appears in both roads) and at 255 points
  (the `u8` cap); reverse `oneway=-1`; assign each way its `RoadType`; **split ways at tile borders**
  (see connection below), so each segment lives in exactly one tile; decompose open areas
  (squares / plazas / open water) into synthetic roads between entrances plus interior junctions.
- *Loader:* `build_graph` merges nodes by exact integer coordinate — exact now, thanks to fixed-point;
  co-loaded neighbouring tiles connect through their shared border nodes automatically.
- *Trade-off accepted:* no per-road name/id, so the same-road-vs-canal retrace refinement is dropped
  (exact-node U-turns still fold); the `bicycle_lane` single-line model relieves most of that need.

**Cross-tile connection (boundary nodes).** Tiles are independent — no tile references another by id;
connection is *emergent*. Rather than duplicating a whole way into every tile it touches, the generator
**splits each road/leg at the tile borders**, inserting a boundary node exactly on the border and
**snapped to the global fixed-point grid**. Because borders are grid-aligned and the node is snapped,
both neighbouring tiles emit the **identical integer** for that shared node, so `build_graph` merges
them by exact key whenever both tiles are loaded. The working set (the corridor + a one-tile ring)
always loads both sides of any border the route crosses, so the needed links always materialise — with
no portal table and no fuzzy matching. Two bonuses fall out: every `Step` stays inside its own tile, so
deltas remain within `u32`; and long **open-water legs** aren't duplicated across every tile they span —
each tile holds only its border-to-border piece. *(Optional later, purely as an optimisation: a per-tile
list of its border nodes + coordinates, so a neighbour can be connected via its portal ring without
loading the whole neighbour tile.)*

### Step 8.1 — Native store round-trip (no-parse path works)  ← **foundation; do first**
- **Goal:** prove a loft store of ways can be persisted and re-loaded with no parse, and matches
  identically.
- **Build:** confirm loft exposes persist/load to loft code (or add a thin binding); write ways →
  persist → load → `match_closed_ex`.
- **Check:** the loaded-store match result is byte-identical to matching the same ways directly.

### Step 8.2 — Portability: native-written store loads under wasm
- **Goal:** the persisted layout is identical across the 64-bit writer and wasm32 reader (offset width,
  endianness).
- **Build:** persist on native; load the same bytes in the wasm build.
- **Check:** the wasm match result byte-identical to the native match. *If this fails, the store format
  needs fixed-width offsets / fixed endianness before proceeding — this is the gating unknown.*

### Step 8.3 — The loft writer (Western-Europe dataset)
- **Goal:** a batch tool that turns an OSM extract into the sliced file.
- **Build:** `codec.loft` (write+read of header + directory + per-tile store blob) shared by writer and
  reader; a generator that reads a WE extract (Geofabrik `.osm.pbf`), keeps routable ways + the tags
  the matcher uses (`highway, surface, oneway, bicycle, access, cycleway, cyclestreet, name`), assigns
  each way to the tiles it crosses, and emits the data slices + the in-store spatial hash index
  (spatial key → slice byte ranges), space-filling-ordered.
- **Check:** file size and per-tile counts are sane; `codec` write→read round-trips a tile natively
  (Step 8.1 harness over a real tile).

### Step 8.4 — Browser loader (resolve working set → load → match)
- **Goal:** serverless matching from the static file, no Overpass, with the complete-before-access
  guarantee (no store request ever reaches out mid-match).
- **Build:** JS loader — load the store's **resident index region** once (cached in IndexedDB); walk the
  in-store hash for the margin-buffered corridor to list the **exact minimal** data slices; `await` the
  Range fetches that load just those (append to linear memory / write to the wasm virtual FS);
  `build_graph` over the loaded slices; matcher runs.
- **Check:** for a known area the route matches an Overpass-sourced match of the same points; the match
  completes with **no network request during matching** (all fetches happen in the load phase); DevTools
  shows only static Range requests (no API); a revisit shows **zero** network (IndexedDB hit).

### Step 8.5 — Hosting & refresh
- **Goal:** one static file, cheap at scale, with a freshness cadence.
- **Build:** upload the file to R2/B2/CDN; a documented re-run of the writer on an OSM-extract schedule.
- **Check:** measured egress per corridor (KB-scale); a scripted client in a fresh profile matches
  correctly against the hosted file.

**Relation to off-the-shelf tiles.** This is essentially a *routing-specific PMTiles* — same
range-request-a-single-CDN-file idea, but the slices are loft stores (no parse) carrying the full
routing tags a general basemap would drop. PMTiles/planetiler remain a fallback reference if the
custom format proves not worth its weight.

## Risks & open questions

- **Resident wasm instance (Step 0.2)** is the pivotal unknown: it decides whether in-browser edits stay
  at ~0.1 s (incremental) or fall back to ~sub-second full rebuilds. Resolve first.
- **Store-layout portability (Step 8.2)** is the gating unknown for the no-parse data path: the persisted
  loft store must be byte-identical across the 64-bit native writer and the wasm32 reader (fixed-width
  offsets, fixed endianness). If it isn't, the format needs adjusting before Phase 8 is worth building.
- **Freshness.** The sliced dataset is a snapshot refreshed on the writer's cadence (weekly/monthly),
  not always-live like Overpass — fine for route-matching; keep Overpass as the fallback for new ground.
- **Overpass rate limits.** The public instance throttles; the accumulating cache (Phase 4) is the main
  mitigation. Consider a configurable Overpass endpoint and exponential backoff on 429/504.
- **Bundle size.** ~5.8 MB raw wasm; confirm gzip and whether a reachable-only build trims it (Step 0.4).
- **Accumulated-graph growth.** `nearest_nodes` is O(nodes); a long session covering a wide area grows
  the graph. The 15-min TTL bounds it, but watch match latency on very large sessions.
- **Parity, not divergence.** Keep one engine *interface* so the browser and server paths stay
  interchangeable and the kernel remains the single source of matching truth (tested by the existing
  `lib/routing_kernel/tests`, which the wasm build must also pass).
