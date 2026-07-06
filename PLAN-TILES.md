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
- **Single file + HTTP Range** ("reads parts of it"). Fallback noted in Risks: many small per-tile files
  if GitHub's Range/size/CORS proves awkward.

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

### B.4 — Generate the tile file
- **Goal:** produce `nl.tiles` from the intermediate.
- **Build:** read NDJSON → classify → **split** at intersections, at tile borders (grid-snapped boundary
  nodes), and at 255 points → assign to tiles → decompose pedestrian squares into synthetic `square`
  roads → build each tile as a **self-contained durable-store region** + the spatial hash index →
  concatenate the tile regions + index into the single file (Hilbert/z-ordered), so one tile is one Range.
- **Check (acceptance for the data):** pick a handful of real NL routes; **matching each from the
  generated tiles equals matching it from a live Overpass fetch** of the same points (same polyline
  within tolerance). Border-crossing routes connect (boundary nodes merged); a route across a square and
  one along a cycleway look right; file size + tile count recorded.

---

## Phase C — Host on GitHub (for now)

### C.1 — Publish with Range + CORS
- **Goal:** the file reachable by a browser with partial reads.
- **Build:** upload `nl.tiles` as a **GitHub Release asset** (Pages/raw have tight size limits; releases
  allow large files). Note the URL.
- **Check:** `curl -r 0-31 -D - <url>` returns **`206`** with correct `content-range`; and the response
  carries **`access-control-allow-origin`** (browser fetch needs it). If either fails at our file size,
  take the Risks fallback (jsDelivr proxy, or many small files, or move to R2 early).

### C.2 — Bootstrap the index
- **Goal:** the client can find the directory/hash from the file head.
- **Build:** fixed header at offset 0 → pointer to the index region.
- **Check:** a script Range-fetches header→index and lists tile ids + byte ranges without downloading
  any slice.

---

## Phase D — Client tile source (caching hidden behind an abstraction)

### D.1 — The abstraction (the whole point)
- **Goal:** one interface the engine uses; transport + cache invisible.
- **Build:** `TileSource` with a single async method, e.g. `waysForCorridor(points, margin) → Way[]`
  (internally: walk the index for the covering tiles, fetch, read via the schema, return). Nothing above it knows
  about HTTP, Range, or the cache.
- **Check:** a contract test runs against a **fake in-memory** `TileSource` (backed by the local
  `nl.tiles`) and the real one, asserting identical `Way[]` for the same corridor.

### D.2 — Range loader behind it
- **Goal:** fetch only the needed slices.
- **Build:** load the index once; for a corridor compute covering tiles from the in-store hash; coalesce
  and Range-fetch just those slices; read the fetched bytes via the loft store schema (no parse).
- **Check:** for a known corridor it fetches only the expected byte ranges (log them); the returned ways
  match the offline generator’s tiles for that area.

### D.3 — Caching layer (hidden)
- **Goal:** revisits and offline need no network — without the engine knowing.
- **Build:** an IndexedDB (browser) / on-disk (native test) cache *inside* `TileSource`: index cached on
  first load; each slice cached on first fetch.
- **Check:** first `waysForCorridor` fetches (network observed); an overlapping second call makes **zero**
  network calls; results identical. The engine code is unchanged between the two.

### D.4 — Wire to the matcher, serverless
- **Goal:** match an NL route with no server.
- **Build:** feed `TileSource.waysForCorridor(...)` into `build_graph` + `match_closed_ex`. (Verify
  natively first — no wasm dependency; browser wiring follows PLAN-BROWSER Phases 1–2/4.)
- **Check:** for drawn NL points the matched route equals the Overpass-backed server’s; only static Range
  requests occur; a repeat is fully cache-served.

---

## Done (milestone acceptance)
A `TileSource` that, given NL points, returns ways read from `nl.tiles` on GitHub via Range — caching
transparently — such that `build_graph`+`match_closed_ex` produce a route **identical to the
Overpass-backed server** for the same points, with **no server and no full-dataset download**. Browser
execution (wasm) is the follow-on in PLAN-BROWSER; the abstraction is written so the same `TileSource`
serves native tests and the browser unchanged.

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
- **File size.** NL+100 km compact should be tens–low-hundreds of MB; if it strains the host, shrink the
  bbox first (NL + 25 km) to prove the pipeline, then widen.
- **Layout portability.** We rely on loft's schema-derived store layout being identical native↔wasm
  (checked via `type_layout_fingerprint` in B.2). Endianness isn't explicitly normalized in the store,
  so this holds for little-endian targets (all dev machines + wasm); a big-endian writer would need an
  explicit codec. B.2 is the gate — if it fails, drop to a hand codec.
- **Freshness.** `nl.tiles` is a snapshot; regeneration is a manual re-run of A→B for now.
