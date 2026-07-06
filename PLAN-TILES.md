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
- **Build:** define the structs (fixed-point u64 origin, u32 `Step` deltas, `Road` = `RoadType`+count,
  index); `store_persist_bind`/`durable_seal` a synthetic tile to a file; read it back via the schema.
- **Check:** *(native)* persist → reopen → structurally identical, and `build_graph` + `match_closed_ex`
  on it matches the same ways built directly. *(portability)* the file written natively reads correctly
  under the wasm build, and `type_layout_fingerprint` for the `Tile` schema matches on both targets.
  **If the fingerprint differs, switch to an explicit codec before continuing.**

### B.3 — OSM tags → `RoadType` + cost table
- **Goal:** the classifier and its cost/legality table.
- **Build:** a pure mapping `tags → RoadType`; the `RoadType → (cost, passable-by-profile)` table.
- **Check:** table-driven test — sample tag sets map to the expected class (motorway, road50_oneway,
  bicycle_lane, footway, stairs, square…); the existing profile/cost tests still pass on the mapped
  classes.

### B.4 — Generate the data files + top-level index
- **Goal:** produce the `data-*.tiles` files (≤4 GB each) and the `index.tiles` top-level index.
- **Build:** read NDJSON → classify → **split** at intersections, at tile borders (grid-snapped boundary
  nodes), and at 255 points → assign to tiles → decompose pedestrian squares into synthetic `square`
  roads → build each tile as a **self-contained durable-store region**; pack tiles (Hilbert/z-ordered)
  into data files, starting a new file before 4 GB; emit the **top-level index** store mapping spatial
  key → `(fileId, offset, length)`.
- **Check (acceptance for the data):** pick a handful of real NL routes; **matching each from the
  generated files equals matching it from a live Overpass fetch** of the same points (same polyline
  within tolerance). Border-crossing routes connect — including a pair whose tiles land in **different
  data files**; a route across a square and one along a cycleway look right; per-file sizes (each ≤4 GB)
  + tile count recorded.

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
