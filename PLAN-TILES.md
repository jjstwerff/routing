# First Tiles — Netherlands (+100 km), from Open Data to a Range-Read Client

The concrete first slice of **[PLAN-BROWSER.md](PLAN-BROWSER.md) Phase 8**: generate a real tiled
routable dataset for the Netherlands plus a ~100 km buffer, host it on GitHub *for now*, and read it
from a client that fetches **only the parts it needs**, with transport and caching **hidden behind one
abstraction**. Same verifiable **Goal / Build / Check** contract as `PLAN.md`.

## Decisions fixed up front (so steps don't wobble)
- **Use loft's durable mmap store — no hand codec.** loft lays out structs as a flat, offset-addressed
  record buffer whose layout is *schema-derived* (`ir_schema_gen`), and ships a durable, mmap-backed
  store (`store_persist_bind` / `durable_seal` — the `@PLAN38` feature). So `Tile`/`Road`/`Step` persist
  and read back **directly via the schema — no parse, no byte codec**. The only thing to verify is that
  the schema layout is **identical across native and wasm** (both little-endian; loft already computes a
  `type_layout_fingerprint`) — see B.2. If that check ever fails, fall back to an explicit codec.
- **The tile file *is* a loft store, by design.** loft's in-memory database was built to double as the
  on-disk model, so there is no serialize/deserialize seam — the struct definition is the schema is the
  file layout. The only conversion anywhere in the pipeline is the one-time *foreign* OSM ingest
  (`.pbf` → loft structures); our own format is never encoded or parsed.
- **Global-angular fixed-point** coordinates (1e-7° units): identity/stitch is exact-integer, curvature
  never enters the merge (see PLAN-BROWSER Phase 8).
- **`RoadType` → cost is a table** (data, not code); the mapping from OSM tags → `RoadType` lives in the
  generator only.
- **Multiple files + a top-level index (the 4 GB cap).** A loft store addresses within u32 offsets, so
  one file is capped at **4 GB**. The dataset is therefore **N data files** (each a loft store ≤4 GB of
  self-contained tiles) plus a small **top-level index** store mapping spatial key → `(fileId, offset,
  length)`. Cross-tile stitching is unaffected — border-node identity is a *global* integer, so
  neighbours in *different files* still merge on load. (NL+100 km likely fits one data file; the top
  index is there so scaling to Western Europe just adds files.)
- **Block reads are a loft `web` library extension, not bespoke app JS — and the store model is never
  reimplemented in JS.** Partial-file read over HTTP Range (`web::read_range`, + caching) lives in loft's
  `web` library and carries its own browser shim; the app is loft calling it. All knowledge of the store
  layout, the index, tiles, and coordinates stays in **loft (wasm)**: loft *plans* which blocks it needs
  (walking the top index + per-file layout), `web::read_range` fetches exactly those, and loft reads them
  via the schema and matches. Two-phase so sync wasm never awaits an async fetch —
  **loft plans → read → loft matches** (complete-before-access, no page-fault); see Phase D.

---

## Phase A — Source data (the NL +100 km rectangle)

### A.1 — Define the rectangle
- **Goal:** a bbox covering NL plus ~100 km outward.
- **Build:** NL is ≈ lon 3.2–7.2, lat 50.75–53.7; +100 km ≈ +1.4° lon, +0.9° lat → working rectangle
  **lon 1.8–8.6, lat 49.9–54.6** (refine later). Record it as the canonical bbox constant.
- **Check:** the rectangle plotted/printed contains Amsterdam, a Belgian and a German border town, and
  open North Sea to the west.

### A.2 — Extract OSM for the bbox
- **Goal:** raw OSM for the rectangle (crosses NL/BE/DE, so a single-country extract won't do).
- **Build:** `osmium extract --bbox 1.8,49.9,8.6,54.6 europe-latest.osm.pbf -o nl-buf.osm.pbf`
  (Geofabrik `europe-latest`, or merge NL+BE+relevant DE regions then bbox-clip).
- **Check:** `osmium fileinfo nl-buf.osm.pbf` shows sane node/way counts and the bbox; a spot node in
  Utrecht and one near Antwerp both present.

### A.3 — Filter to routable ways + needed tags
- **Goal:** drop everything the matcher doesn't use.
- **Build:** `osmium tags-filter nl-buf.osm.pbf w/highway -o nl-roads.osm.pbf` (keep `highway`, plus
  `oneway, bicycle, access, cycleway, surface, foot`; add pedestrian-area polygons for `square`).
- **Check:** filtered file is much smaller; `osmium fileinfo` shows only highway-bearing ways; a known
  cycleway and a pedestrian square survive.

---

## Phase B — The tile generator (loft, native batch)

### B.1 — Intermediate the generator can read
- **Goal:** hand geometry+tags to loft without a `.pbf` reader in loft.
- **Build:** `osmium export` / pyosmium → NDJSON, one way per line: `{tags, coords:[[lon,lat],…]}`
  (nodes resolved to coordinates).
- **Check:** line count ≈ way count; a named street parses with expected tags and a plausible polyline.

### B.2 — Persist/read a tile via loft's durable store (+ native↔wasm portability)  ← **the gate**
- **Goal:** prove `Tile`/`Road`/`Step` (with the in-store spatial hash) round-trips through loft's
  durable store with **no hand codec**, and reads identically under wasm.
- **Build:** define the structs (`Tile` u64 origin, `Step{x,y,h:u32}`, `Road{tp,flags,steps:u8}`, index);
  `store_persist_bind`/`durable_seal` a synthetic tile to a file; read it back via the schema.
- **Check:** *(native)* persist → reopen → structurally identical, and `build_graph` + `match_closed_ex`
  on it matches the same ways built directly. *(portability)* the file written natively reads correctly
  under the wasm build, and `type_layout_fingerprint` for the `Tile` schema matches on both targets.
  **If the fingerprint differs, switch to an explicit codec before continuing.**
- **Byte breakdown:** loft packs tightly (pads only when alignment forces it), so `Road{u8,u8,u8}` = 3 B
  with no slack — `flags` is a real +1 byte, but the `Step` pool (12 B × ~7/road) dominates, so it's
  ~1% of a tile. Report the split Road vs Step-pool vs index to confirm geometry is ~95%+.

### B.3 — OSM tags → `RoadType` + cost table
- **Goal:** the classifier and its cost/legality table.
- **Build:** a pure mapping `tags → RoadType`; the `RoadType → (cost, passable-by-profile)` table.
- **Grounded on real data:** classifying a central-Enschede sample (240 ways) mapped ~93% and left only
  two unmapped values — `busway` (13) and `platform` (5). Both are **mode-aware blockers**: passable on
  **foot** (a walker can cross when no bus is in sight) but **never routed for a bike** (you can't safely
  stop-look-wait while mounted). So each becomes a class (`Busway`, `Platform`) whose cost-table row is
  **impassable for cycling (`bike_never`) yet passable for walking/running** — the same mode-aware
  legality the matcher already applies to bus lanes/motorways. Not dropped; foot routing uses them.
- **Check:** table-driven test — sample tag sets map to the expected class (`Motorway`, `Road50Oneway`,
  `BicycleLane`, `Footway`, `Stairs`, `Square`, `Busway`, `Platform`…) with the right per-profile
  passability (`Busway`/`Platform`: foot yes, bike no); the existing profile/cost tests still pass on the
  mapped classes.

### B.4 — Generate the data files + top-level index
- **Goal:** produce the `data-*.tiles` files (≤4 GB each) and the `index.tiles` top-level index.
- **Build (bake everything in one pass):** read NDJSON → classify `tp` → set `flags` from OSM **route
  relations** (`cycle_infra`; recreational-network membership) → sample the **DEM/terrarium** for each
  node's `h` → **split** at intersections, at tile borders (grid-snapped boundary nodes), and at 255
  points → assign to tiles → decompose pedestrian squares into synthetic `square` roads → build each tile
  as a **self-contained durable-store region**; pack tiles (Hilbert/z-ordered)
  into data files, starting a new file before 4 GB; emit the **top-level index** store mapping spatial
  key → `(fileId, offset, length)`.
- **Store isolation (validated recipe):** `store_persist_bind` serializes the *entire* store the bound
  hash lives in — so if the OSM parse and the tile hash share the default store, the file balloons (an
  8 km Enschede build persisted **264 MB**, almost all parse scratch). The fix, confirmed: **build the
  tiles inside a function that returns the final hash-struct** (`fn build(osm) -> Final { ways = parse…;
  f = Final { idx: [] }; …populate f.idx…; f }`). `ways` is a local, dropped at the return boundary, so
  the returned `Final` owns a store holding *only* the tiles; `store_persist_bind(f.idx, path)` then
  writes just those. (This is why keyed collections have no standalone `::new()` — the *function return*
  is the own-store boundary.) loft packs tightly (pads only for alignment).
- **Check (acceptance for the data):** pick a handful of real NL routes; **matching each from the
  generated files equals matching it from a live Overpass fetch** of the same points (same polyline
  within tolerance). Border-crossing routes connect — including a pair whose tiles land in **different
  data files**; a route across a square and one along a cycleway look right; per-file sizes (each ≤4 GB)
  + tile count recorded.
- **First build — validated (Enschede + 8 km):** 39,603 ways → **109 tiles / 230,601 steps**, persisted
  to a **3.5 MB** durable store (~1.2× the raw data) via the function-return recipe; a fresh process
  reloads it by mmap with **no parse**, exact counts, and fixed-point reconstructs to the correct lon/lat
  (6.759–7.030). Deferred in this first cut: per-node `h` (DEM, currently 0), tile-border splitting
  (deltas are `i32` pre-split → `u32` once split), multi-file/top-index, and reading tiles into the
  *matcher* (vs raw ways).

---

## Phase C — Host on GitHub (for now)

### C.1 — Publish the files with Range + CORS
- **Goal:** the data files + index reachable by a browser with partial reads.
- **Build:** upload `index.tiles` and each `data-*.tiles` as **GitHub Release assets** (Pages/raw have
  tight size limits; releases allow large files). Note their URLs (a stable `fileId → URL` map).
- **Check:** `curl -r 0-31 -D - <data-url>` returns **`206`** with correct `content-range` and carries
  **`access-control-allow-origin`** (browser fetch needs it). If either fails at our file size, take the
  Risks fallback (jsDelivr proxy, many small files, or move to R2 early).

### C.2 — Bootstrap the top index
- **Goal:** the client can pull the top index, then let loft resolve blocks.
- **Build:** `index.tiles` at a known URL, small enough to fetch whole (or ranged); it maps spatial key
  → `(fileId, offset, length)`.
- **Check:** a script fetches `index.tiles`, and for a corridor **loft** returns the exact
  `(fileId, offset, length)` block list — with no data block downloaded yet.

---

## Phase D — Block reads via a loft `web` extension; loft drives

The client reimplements **none** of the store model, and the block reader isn't bespoke app JS — it's a
**loft `web` library extension** for partial-file reads that carries its own browser shim. The app is
loft calling it; the only JavaScript in existence is that library's fetch bridge.

### D.1 — `web` partial-read extension (this *is* the JS abstraction)
- **Goal:** a uniform loft primitive `web::read_range(url, offset, length) → bytes`, backed by
  `fetch()`+Range in the wasm build and by an HTTP range GET / file-at-offset natively — so the *same*
  loft code reads blocks in the browser and in native tests.
- **Design note:** a partial read is async in the browser, but loft calls look synchronous. Bridge it
  through loft's **event-loop/callback** model (the same one the server's `srv.run` uses) *between* the
  plan and match phases, so loft never blocks mid-match (ties to PLAN-BROWSER Step 0.2). Sync-bridge
  (worker + `SharedArrayBuffer`/`Atomics.wait`) is the fallback if a synchronous-looking call is needed.
- **Check:** from loft (native *and* wasm), `web::read_range` on a hosted `data-*.tiles` returns the
  exact bytes a local read returns.

### D.2 — loft plans → `web::read_range` → loft matches (two-phase)
- **Goal:** the flow that keeps synchronous wasm from ever awaiting a fetch.
- **Build:** all in loft: (1) `web::read_range` pulls `index.tiles`; (2) given the index + the corridor,
  loft returns the exact `(fileId, offset, length)` block list; (3) `web::read_range` fetches those
  blocks; (4) loft reads them via the schema and matches. All spatial/index logic stays in loft.
- **Check:** for a known corridor loft requests only the expected blocks; the match equals the offline
  generator’s route.

### D.3 — Caching (inside the extension)
- **Goal:** revisits and offline need no network — invisibly to the app.
- **Build:** an IndexedDB (browser) / on-disk (native) cache *inside* the `web` extension: the index and
  each fetched block cached on first use.
- **Check:** first request fetches (network observed); an overlapping second makes **zero** network
  calls; results identical, with no change to the loft app.

### D.4 — Serverless match, end-to-end
- **Goal:** match an NL route with no server.
- **Build:** wire the two-phase flow to `build_graph` + `match_closed_ex`. (Verify natively first — no
  wasm dependency; browser wiring follows PLAN-BROWSER Phases 1–2/4.)
- **Check:** for drawn NL points the matched route equals the Overpass-backed server’s; only static Range
  requests occur; a repeat is fully cache-served.

---

## Done (milestone acceptance)
Given NL points: loft plans the blocks, a dumb HTTP block reader Range-fetches them from the
`data-*.tiles` on GitHub (resolved through `index.tiles`, transparently cached), and loft reads them via
the schema so `build_graph`+`match_closed_ex` produce a route **identical to the Overpass-backed server**
— with **no server, no full-dataset download, and no store logic in the client.** Browser execution
(wasm) is the follow-on in PLAN-BROWSER; the same block-reader + loft flow serves native tests and the
browser unchanged.

## Follow-on optimisation — persist the *built* graph (skip `build_graph`)
Because the store *is* the file, a tile can hold not just geometry but the **built graph** the matcher
runs on (`GNode`s + CSR adjacency). The client then mmaps a ready-to-search graph and skips
`build_graph` entirely; the only work left per load is stitching boundary nodes across separately-loaded
tiles — splicing adjacency where an edge crosses a tile border. Do this **only after** single-tile read
(B.2 / D.4) works.
- **Build:** the generator persists per-tile `GNode`/CSR adjacency alongside (or instead of) `Road`s;
  the loader unions the loaded tiles and merges their exact-integer border nodes, splicing adjacency.
- **Check:** a corridor spanning ≥2 tiles matches identically to the `build_graph`-on-load path, with no
  per-load graph construction — only the border splice.

## Future — multi-modal day-plans (rough estimates, not a schedule)
**Premise:** the app plans *what you want to do* and gives **rough estimates** to answer "does it fit in
a day?" — it is **not** a scheduler. It never shows exact times (traffic, weather, delays change them);
it extends the instant-rough-length idea to a rough *duration* across modes.

**Prefer curated "nice" paths, don't chase "fastest".** The day-planning value is routing along
hand-curated recreational networks — the ones the app **already displays** as the **Waymarkedtrails**
overlay (`hiking`/`cycling`/`mtb`, switched per activity in `controls.js`). That overlay is *raster*
(for looking at); routing needs the *vector membership* — which ways belong to those networks — read at
ingest from the **same OSM route relations Waymarkedtrails is built on** (`network=rcn`/`rwn`/`lcn`,
`route=hiking`/`bicycle`/`mtb`), so display and routing share a source. Captured as a per-way flag, the
cost table turns it into a **bounded leisure bonus matched to the active activity's network** — the
*same* prefer-when-near mechanism as the cycle-infra bonus, so it picks the nice way among candidates by
your line but **never detours out of the corridor** (still faithful to the sketch — not komoot). Use-
case-dependent: strong for day-planning, off for get-there-quick. **Fastest point-to-point is explicitly
not a goal** — Google Maps' job; our edge is curated-nice routing + fits-in-a-day.

A **trip = ordered legs**. Each leg carries a mode/profile; its two ends are one of:
- a **drawn point**,
- a **returned-to anchor** (the car/bike you left behind — a loop leg, closed by loop detection),
- a **named place** (home),
- a **resolved POI** (nearest station / parking, from the spatial index).

Every private leg (drive / cycle / walk) reuses the existing per-profile matcher over the *one* tileset,
and contributes a rough duration = distance ÷ typical mode speed (+ small dwell/transfer buffers). The
day's feasibility is the sum, shown as a rough "~X h" — never a precise clock. Examples: drive → park →
bike loop → drive home; cycle → lock & walk a town → cycle to the nearest station → train home (the OV-
fiets pattern).

**Transit stays light, by design:**
- **Geometry** from OSM route relations (which line, its shape).
- An **operating calendar** per line, stored in the **transit `RoadType`'s `flags`** (the same 8-bit
  field as road attributes, reinterpreted per class → `weekday`, `weekend`, `evening`, `night`,
  `seasonal`, `school`). Filled at generation from a tiny slice of GTFS (`calendar` / `calendar_dates`,
  joined via `trips`; **not** `stop_times`). Those bits drive a per-line **availability indicator on the
  map** ("Mon–Fri only", "evenings", "summer") — not a routing filter: the human sees the restriction and
  plans around it (a set plan day can additionally dim days-off lines). Routing itself stays **untimed**
  — a transit leg is a connection + a rough duration. Transit lines are `Road`s with a transit class
  (`BusLine`/`TrainLine`/`TramLine`/`Ferry`), geometry from OSM route relations — same format, just a
  separately-refreshed layer since calendars change seasonally.
- **Full timetable routing (exact departures/transfers, RAPTOR/CSA, realtime) is a non-goal** — it would
  show precise times the premise deliberately avoids.

**Cheap hooks to keep open now** (no commitment): preserve stop/station `ref`/`gtfs:stop_id` when
classifying `Platform`/stations, and keep `amenity=parking` as anchors — so nearest-POI and later
calendar-linking just work. Calendar/geometry for transit lives in a separately-refreshed transit layer,
never in the geographic tiles.

## Risks & fallbacks
- **GitHub limits.** Raw/Pages cap file size (~100 MB) and CORS is inconsistent; Release assets are large
  but their CORS on the redirected object host must be verified (C.1). Fallbacks, in order: serve the
  file through **jsDelivr** (CDN, sends `206` + CORS — verified for small files, has its own size cap);
  or split into **many small per-tile files** fetched whole (no Range, but many requests + GitHub file
  counts); or move to **Cloudflare R2 / B2** sooner (the real target — GitHub is the stopgap).
- **File size / the 4 GB cap.** Per-file 4 GB is now structural — the generator rolls to a new
  `data-*.tiles` before the cap, and the top index spans them (so Western Europe is just more files).
  NL+100 km compact should be tens–low-hundreds of MB (likely one file); if it strains the *host*, the
  multi-file split also lets each file stay under a host's per-asset limit. Shrink the bbox first
  (NL + 25 km) to prove the pipeline, then widen.
- **Layout portability.** We rely on loft's schema-derived store layout being identical native↔wasm
  (checked via `type_layout_fingerprint` in B.2). Endianness isn't explicitly normalized in the store,
  so this holds for little-endian targets (all dev machines + wasm); a big-endian writer would need an
  explicit codec. B.2 is the gate — if it fails, drop to a hand codec.
- **Freshness.** The `data-*.tiles` are a snapshot; regeneration is a manual re-run of A→B for now.
