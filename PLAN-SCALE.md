<!--
Copyright (c) 2026 Jurjen Stellingwerff
SPDX-License-Identifier: LGPL-3.0-or-later
-->

# PLAN-SCALE — from one city to Western Europe

**Status: design, nothing built (2026-07-30).** Plan of record for taking the app from its single
283 km² block to WE-wide coverage, *and* for the procedure that keeps that data fresh (§7 — the recurring
cost, and the part that is easiest to under-plan).

Supersedes the scale sections of the older plans, which were written against a premise that has since
died — see **§4**. `PLAN-PERF.md` owns per-interaction performance; this doc owns *coverage*. The
invariant is the same one and it is the whole design: **every interaction does work proportional to what
CHANGED, never to the size of the data.** WE-wide data is where that stops being a slogan.

> ## The rule this plan is built on
>
> **We never author a store codec. If we need one, that is a loft bug.**
>
> A loft store is its own wire format — self-describing, native-endian, walkable by byte offset
> (`../loft2/doc/claude/formal/layout.md`). Reading it is loft's job: `store_load*` for whole loads,
> `store_load_key(s)`/`store_load_range` for working sets, and loft's **own** reader (`loft-deliver.js`,
> vendored verbatim) where JS touches the bytes. Every proposal below that looks like "parse the bytes
> ourselves" is therefore **out of scope by construction**; when a shape cannot be read, paged, or
> exposed, the deliverable is an **issue on `loft-lang/loft` with the probe as its reproducer** (plus the
> definition-relevant half in `docs/loft-feedback.md`), not a decoder in this repo. Routing is loft's
> consumer test-bed — a read path we hand-rolled here would hide exactly the gap the test-bed exists to
> surface.

---

## 1. Sizing — measured on the block we ship, not estimated

`tools/coverage_probe` style walk of `_site/stores/enschede.layout.store` + the roads store:

```
layout: 1089 tiles (0.005° cells)   origins span lat 52.160..52.325  lon 6.775..7.000
        ≈ 18.3 km N-S × 15.4 km E-W ≈ 283 km²
        areas 28,773 · buildings 130,402 · lines 6,585 · labels 11,310 · pois 27,912
        = 204,982 features / 1,586,857 coords in 20.8 MB
roads:  88 tiles (0.02° cells) in 3.5 MB
```

| | per km² | ×2.4 M km² (WE core) at density 0.25–0.5 |
|---|---|---|
| **roads** (the router) | 12.4 kB | **7–15 GB** |
| **layout** (the base map) | 73.5 kB | **44–88 GB** |

WE core = FR, DE, ES, IT, UK, PT, IE, NL, BE, LU, CH, AT, DK ≈ **2.4 M km²** (adding NO/SE/FI is
+1.17 M km², ~+50%). The **density factor is a guess and it is the single biggest unknown in this
document** — Enschede is a city with its surroundings, WE average is emptier, the Randstad and Île-de-France
are denser. **S0 replaces it with a measurement**, and every number above moves with it.

**Two facts that fall out of the table and drive every decision below.**

1. **The base map is 6× the router.** PLAN-TILES' *"~6–10 GB, ~12–20 files"* estimate for WE is
   roads-only — it predates the base map entirely. The map layer, not the routing data, is what makes
   this a ~100 GB project instead of a ~10 GB one.
2. **Tile counts explode before bytes do.** WE at 0.02° road cells ≈ **600 k tiles**; at 0.005° layout
   cells ≈ **12 M tiles**. Anything that is *per tile and not per viewport* — iteration, a flat
   directory, one HTTP request each — is dead at that count, whatever it costs today.

---

## 2. The walls, and which are already gone

Five things stand between today's app and WE. **Two are cheaper than the old plan assumed and one is new.**

| | wall | state |
|---|---|---|
| **W1** | **The generator reads its whole input as one `text`** — `tools/gen-tiles.loft:41` and `client/basemap/build_store.loft:206-211` both do `file(x).content()`. NL's PBF alone is ~1 GB before the JSON-with-geometry expansion. | **open** — needs a streaming input (§6 S6) |
| **W2** | **The client downloads and holds the whole store** (`store_load_url_trusted`) | ⚑ **SMALLER THAN PLANNED** — loft's working-set loader already does keyed page reads, proven on our own stores below |
| **W3** | **wasm32 has a 4 GiB address space**, and a phone's practical cap is far below it | **open** — the working set must be bounded and evicted (S4) |
| **W4** | **Every tile read iterates the whole collection** — `corridor_ways_impl2` does `for t in store` because *"keyed lookup `store[key]` isn't reliable on a mmap-reloaded store … a region's tile count is small"*, and the tube filter's comment says *"1089 tiles is cheap"* | **open, and it is the first real work** (S2). At 600 k road tiles a warm match would scan the continent |
| **W5** | **The zero-copy render bridge assumes ONE resident store.** `expose` pins a whole store and is **O(collection) per call** (PLAN-PERF §6c/§7f, ~230 ms to re-expose 3.5 MB of roads) | **new** — a 12 M-tile store can never be exposed whole (S5); most likely place we need something from loft |

### W2 — the keystone probe (2026-07-30, installed loft 2026.7.2)

loft's own contract (`../loft2/doc/claude/DATABASE.md` § working-set loader) says `store_load_key(s)` /
`store_load_key_text` / `store_load_range` materialise **only the pages an entry touches, from a local
file or an `http(s)://` Range server**, and **refuse** what the relocator cannot copy — `vector<text>`,
`vector<vector>`, or a collection declared as a struct **field** (loft#632). Our `PTile` is a vector of
structs that each carry a `text` *and* a nested `vector<Coord>`, which is exactly the at-risk shape, and a
refusal returns `false` — indistinguishable from an absent key. So it was asked directly, on the real
stores, comparing the **richest** tile loaded both ways:

```
layout: 1089 tiles; richest tkey=2049559237 with 1810 features
  whole load : areas=255 buildings=990 lines=9 labels=40 pois=516 coords=10564
  store_load_keys: asked=1 loaded=1 bytes_fetched=327680 file=20776816
  paged load : areas=255 buildings=990 lines=9 labels=40 pois=516 coords=10564   → paged == whole ✓
roads : richest tkey=2611000344; whole roads=1496 steps=8915 | paged roads=1496 steps=8915  ✓
        store_load_keys: asked=1 loaded=1 bytes_fetched=327680 file=3580472
```

**Both shapes load, and the paged entry is identical to the whole-load entry.** (A first pass picked an
arbitrary tile, got `areas=0 buildings=0`, and looked like silent data loss — it was an honestly sparse
tile. *Pick the richest case: an empty answer on empty input proves nothing.*)

Three things this buys and one it charges:

- **No bespoke tile codec, no JS range layer, no directory format.** The store's own hash index *is* the
  directory, and loft reads it by pages. PLAN-APP §3's steps 2–3 are superseded (§4).
- **`store_load_keys` is a batch call** — the corridor can ask for its whole cell window at once.
- **`LOFT_LOADER_STATS=1` prints `bytes_fetched` vs file size** — the working-set claim has an
  instrument, so every step below can gate on it instead of asserting it.
- ⚠ **Page granularity is coarse: one entry cost 192–328 KB.** At ~60 layout tiles per viewport that is
  ~18 MB per view if pages do not overlap. **Hilbert ordering within a block** (PLAN-TILES step 5 already
  specifies it) plus batched `store_load_keys` is the fix, and S1 measures whether it works.

**Still unproven, and it gates everything: does the paged reader work in the BROWSER?** `store_load_url*`
needs the asyncify `fetch()` bridge; whether `paged_reader.rs`'s Range path is wired through it in a
`--html` build is unknown. **S1 answers this before anything else is built.**

---

## 3. Decisions fixed up front

| | decision | why |
|---|---|---|
| **D1** | **Router WE-wide first; base map per-region on demand.** Ship roads (7–15 GB) as continuous coverage; treat layout blocks as an opt-in download per region. | §1(1) — the map is 6× the bytes of the thing that makes this app worth using, and `CLAUDE.md`'s split already says *loft does the ROUTE, JS does the MAP* |
| **D2** | **Object storage with Range + CORS** (R2/B2), app shell stays on GitHub Pages. | Pages caps a site around 1 GB and a Release asset at 2 GB (re-verify before sizing) — neither hosts 50 GB. R2 has no egress fee, which is the cost model that decides this |
| **D3** | **loft's working-set loader is the read path** — no codec, no JS range machinery, per the rule above. A gap in it is an **issue on `loft-lang/loft`**, and this plan waits on the fix rather than routing around it. | proven in §2 on both shapes; the one thing a hand-rolled reader would buy is speed, at the cost of hiding the gap the test-bed exists to find |
| **D4** | **Keep the two cell sizes** (roads 0.02°, layout 0.005°), **Hilbert-order tiles within a block.** | changing cell size is a data migration; ordering is free at generation and is what makes page reads overlap |
| **D5** | **Blocks are per-country or per-split, ≤ 2 GB, and the dataset VERSION is in the URL.** | a client must never mix versions mid-session; per-block regeneration is what makes a hotfix cheap (§7) |
| **D6** | **The top index is ours and tiny** — bbox → block URL + version, one row per block (12–40 rows). | the store is its own directory (D3), so the only thing we author is the map from geography to block |
| **D7** | **Cross-block continuity rides the existing border rule** — ways split at tile borders, border nodes grid-snapped so neighbours merge exactly — extended to blocks, with its own gate. | `tools/tile_border_gate.sh` already proves this across *tiles*; blocks are the same rule at a bigger seam |
| **D8** | **Overpass fallback stays** for outside-coverage sketches. | it is the only thing that makes a partial rollout usable |

---

## 4. What is superseded (so the plans stop contradicting each other)

- **PLAN-APP §3 steps 2–4 (byte codec + JS Range fetch + JS-side directory)** — superseded by D3. The
  premise was *"no mmap in wasm, so the tile format is read by explicit decode"*; loft#522 shipped
  `store_load*` and the store became its own wire format (HANDOFF §6 records the bet holding).
- **PLAN-APP Track 2 (2b–2d) and Track 3 (3a–3b)** — replaced by §6 here. Track 2's *"~1 GB Benelux"* and
  Track 3's *"6–10 GB WE"* are **roads-only** figures; §1 restates them with the base map included.
- **PLAN-TILES "Western Europe — full build routine"** — its *generation* steps survive almost intact and
  are folded into §7 (they are the best part of the old plan: osmium passes, Hilbert packing, 0.5 GB
  rolling shards, border-node splitting). Its *client* half (index.tiles as a directory we author, mmap
  reload) is superseded by D3/D6.

---

## 5. The read path as it will actually be

```
top index (ours, ~KB, cached)      bbox → block URL @version
   └─ block  (≤2 GB store + .dschema, Hilbert-ordered, Range-served)
        └─ store_load_keys(working_set, url, [tkey…])     ← loft reads only the pages those keys touch
             └─ working-set store (bounded, LRU-evicted)  ← what the matcher and the renderer see
```

1. **Resolve** — sketch/viewport bbox → cell window → tkeys (+ a one-cell ring) → blocks via the top index.
2. **Load** — one batched `store_load_keys` per block into a working-set collection. No iteration of the
   block, ever (W4).
3. **Match** — `build_graph` over the working set, unchanged; border nodes make tiles and blocks connect.
4. **Render** — the base map reads the *working-set* store through `expose`, re-scoped per working set
   (W5), not one session-long pin of the world.
5. **Evict** — LRU over working-set tiles, bounded in bytes, so a long session cannot grow past W3.

---

## 6. Steps — one commit, one observable, gates green

**S0 · Size it for real.** Generate three representative blocks — dense urban (Randstad), rural (central
France), mountain (Alps) — and record bytes/km² per layer with **`tools/coverage_probe.loft`** (the
instrument §1's table came from). *Observable:* the density factor of §1 replaced by three measurements.
*Gate:* the numbers land in this doc; if layout comes in above ~60 GB, D1 is already vindicated and the
base map moves behind a per-region opt-in.

**S1 · Prove the paged reader in the browser.** A `--html` page that `store_load_keys`-es a handful of
tkeys from a Range-served store and reports `bytes_fetched`. *Observable:* the same tile contents as
native, with bytes_fetched ≪ file size. *Gate:* new `tools/paged_browser_probe.*` in `make test-map`. **If
the Range path is not wired into the wasm build, everything else waits and this becomes a loft ask** — with
this probe as the reproducer.

**S2 · Kill the full-collection scans (W4).** Replace `corridor_ways_impl2`'s `for t in store` with a
keyed cell-window fetch, and the viewport filter's walk likewise. *Observable:* corridor read time flat as
coverage grows — measure on a synthetic 20× block. *Gate:* `tools/match_parity.sh` byte-identical +
`tile_border_gate.sh`; a new assertion that the tile count touched per match is a function of the sketch,
not of the store.

**S3 · Page-locality: Hilbert ordering.** Order tiles within a block on a Hilbert curve at generation.
*Observable:* `bytes_fetched` for a realistic viewport working set, before vs after. *Gate:* a probe that
fails if a 60-tile viewport costs more than N MB (N set by S1's measurement, recorded, not guessed).

**S4 · Working-set lifecycle + eviction (W3).** Bounded LRU over loaded tiles; a session that pans across
a country holds a bounded footprint. *Observable:* peak wasm memory across a scripted pan of 500 km.
*Gate:* the profiler asserts a ceiling; route unchanged.

**S5 · Re-scope the render bridge (W5).** `expose` per working set instead of per session, with the
re-expose cost measured (it was ~230 ms for 3.5 MB). *Observable:* pan frame stays ≤ the PLAN-PERF budget
with tiles arriving. *Gate:* `map_render_gate.sh` pixel hash unchanged; the bridge probes already in
`make test-map` extended to a working-set store. **Most likely loft-side ask, and it stays one:** if
per-working-set `expose` is too slow, the answer is an `expose` that is O(exposed) rather than
O(collection) — filed with this probe as the reproducer — **not** a reader of our own (the rule above).
Interim, the render path can fall back to whole-block loads for the *base map only* (D1 already makes it
an opt-in per region), which is slower but changes no format.

**S6 · Streaming generator input (W1).** Teach the generator to read `geojsonseq` line-by-line (PLAN-TILES
step 2 already suggests it, *"removes this step"*) instead of one `file().content()` text. *Observable:* a
country-sized input generates with flat memory. *Gate:* the Enschede block regenerates **byte-identical**
to today's store from the same source — the parity that makes this refactor safe.

**S7 · Blocks + top index (D5/D6).** Rolling ~2 GB shards, `.dschema` beside each, version in the path;
top index authored from the manifest. *Observable:* a point in each region resolves to the right block.
*Gate:* every block opens, `store_load_key` spot-checks pass, index round-trips.

**S8 · Cross-block stitch (D7).** A route crossing a block seam. *Observable:* no gap, no bridge edge at
the seam. *Gate:* extend `tile_border_gate.sh` to a **block** seam, both directions, order-insensitive.

**S9 · Hosting (D2).** Blocks on R2/B2, Range + CORS from the browser origin. *Observable:* a 206 with
correct bytes, cross-origin, from the deployed page. *Gate:* a headless check in `make test-map` against a
real (small) hosted block.

**S10 · Roll out roads WE-wide** (D1), base map per-region opt-in. *Observable:* a cold visitor routes
anywhere in coverage; the base map offers a region download. *Gate:* the 26-sketch corpus still 0-worse;
`CPU_THROTTLE=4` warm match inside its current budget.

**S11 · The refresh procedure** — §7, and it is a project of its own.

---

## 7. Phase R — the update procedure (the recurring cost)

Everything above is a one-off. **This is the part that runs forever**, and today it does not exist:
`tools/build-blocks.sh` is unwritten (HANDOFF §11), the elevation cache path is known-broken on re-runs
(PLAN-TILES §3), and the current block was made by hand. Designed so that **a single stale country costs
one block, not a continent.**

```
manifest(regions) → acquire(PBF) → per-region osmium → elevation cache → generate block
                 → verify block → publish under v<date>/ → flip the top index → clients migrate
```

**R0 · The manifest is the source of truth.** `data/coverage.toml`, in the repo, versioned: one row per
region — id, bbox, source PBF, split parent, expected size band. Everything downstream is a function of
it, and a diff to it is the only way coverage changes. *Gate:* the manifest generates the top index; CI
checks the regions tile WE with no gaps and no overlaps beyond the border ring.

**R1 · Acquire, checksummed and cached.** Geofabrik per-country extracts (~30 GB for WE), pinned by their
published `.md5`, into a content-addressed cache. *Gate:* a re-run with no upstream change downloads
nothing.

**R2 · Per-region osmium passes** — `extract --bbox` → `tags-filter w/highway` → `export -f geojsonseq`.
Parallel across regions, **resumable per region**, each step's output cached by (source hash, bbox, step).
*Gate:* killing the run mid-way and restarting reproduces the same intermediates and skips finished work.

**R3 · Elevation.** Terrarium z12 tiles per bbox in a **shared, persistent** cache — the current
per-run re-fetch is the known bug, and at WE scale it is the difference between one fetch and forty. Also
the point where `h: 0` finally gets populated (HANDOFF §11 — gradient routing is wrong nationwide until
it is). *Gate:* second run fetches 0 tiles; a known relief profile matches within tolerance.

**R4 · Generate one block.** Native loft, streaming input (S6), Hilbert-ordered (S3), `.dschema` written,
output named `<region>-v<YYYY-MM-DD>.store`. *Gate:* per-block counts within a band of the previous
version — a block that suddenly loses 30% of its ways fails rather than ships.

**R5 · Verify per block, before anything is published.** Four checks, because a bad block is invisible
until someone routes through it:
1. `store_load_key` spot checks with `LOFT_LOADER_STATS=1` — opens, pages, and the entry equals a whole
   load. **`tools/paged_gate.sh` + `tools/paged_probe.loft` already do this** on the shipped block (in
   `make test-native` as of this plan); per-block it runs against the freshly generated store.
2. **Route parity** — a fixed sample of sketches per block matches identically to the previous version,
   or the diff is inspected deliberately (`match_parity.sh` shape).
3. **Border continuity** with each already-published neighbour (S8's gate).
4. **Layout identity** — the `.dschema` matches the client's compiled types. *A store-format change fails
   SILENTLY otherwise* (HANDOFF §3): no output, no error, exit 1.

**R6 · Publish atomically.** Upload blocks under `v<date>/`, verify each object's size and a Range read
of it, **then** flip the top index — the index is the only mutable pointer, so a half-uploaded release is
never visible. Keep the previous version for a grace period. *Gate:* a client pinned to the old index keeps
working throughout the upload.

**R7 · Client migration.** The index carries the version; IndexedDB caches are keyed by it, so a new
version invalidates nothing and costs only what the user actually re-visits. *Gate:* a scripted session
across a version flip does not re-download unchanged blocks.

**R8 · Budget, measured once and written down.** Wall-clock and disk for the WE run, from one
representative block × the region count: osmium hours, generation hours, peak disk (source + intermediates
+ output), upload bytes. Then the cadence follows from the number instead of from optimism. *Gate:* the
figure lands in this section, and a **single-region hotfix** is timed separately — that is the number that
matters on a bad day.

⚠ **Sequence R deliberately before S10.** Shipping WE-wide data you cannot regenerate is how a dataset
becomes frozen: the first schema change or OSM correction strands it.

---

## 8. Still open — with the instrument named

| | question | how it gets answered |
|---|---|---|
| 1 | Does the paged Range reader work in a `--html` build? | **S1** — blocks everything |
| 2 | What does a realistic viewport working set actually cost in bytes? | S1 + S3 with `LOFT_LOADER_STATS=1` |
| 3 | Is per-working-set `expose` fast enough to render from? | S5; fallback is JS reading pages directly |
| 4 | Real density factor, hence real total size | S0 (three blocks) |
| 5 | Is keyed lookup on a reloaded store reliable now? | S2 — the paged loader gives keyed access by construction, which may retire `corridor_ways_impl2`'s comment |
| 6 | R2 vs B2: Range + CORS behaviour and egress cost | S9 |

---

## 9. Risks

- **The base map's size is the project's shape.** If S0 comes in at the high end (~90 GB), D1 is not a
  preference — the base map has to become vector-tile-ish or externally sourced, and that is a different
  plan. Measure before committing storage.
- **W5 is the one that can force a loft change.** Everything else is our own code; the render bridge's
  `expose` semantics are not.
- **Page granularity may not amortise.** If Hilbert ordering does not make a viewport's tiles share
  pages, per-view bytes stay ~18 MB and the layout tile size (0.005°) has to grow — a data migration, so
  S3 comes before any bulk generation.
- **The refresh procedure is where this rots.** Unwritten automation plus a broken elevation cache plus a
  hand-made block is exactly the state from which a dataset never gets updated again. §7 before §6 S10.
