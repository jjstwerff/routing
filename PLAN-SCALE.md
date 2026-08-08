<!--
Copyright (c) 2026 Jurjen Stellingwerff
SPDX-License-Identifier: LGPL-3.0-or-later
-->

# PLAN-SCALE — from one city to Western Europe

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-04 · **Owns:** the coverage model, the walls, the decisions and the S1–S11 ladder — the spine; four children hold the rest

**Status (2026-08-07): C0–C3 BUILT — the BENELUX routes and searches on GitHub Pages**, dataset
`v2026-08-03d`, 10 blocks over three countries, drawing at every zoom from z0. The site sits at
**673.8 MB of a ~950 MB budget (71%)**, measured on every build. ⚠ **Belgium ships with no base map above
z14** — 1202.5 MB against a ~1 GB per-site cap needs cutting in two, and it is handled as a product state
rather than a fallback. **`HANDOFF.md` §0 is the live status; this doc is the model behind it.**

`docs/coverage-rungs.md` §6c and §6j have what the NL and Benelux rungs cost; **`docs/block-pipeline.md`
§6e has what NL taught about Western Europe** — including the correction that the client already streams
and it is the GENERATOR that does not.

Plan of record for taking the app from its single 283 km² block to WE-wide coverage **that is actually
current**. Three parts, and the last two are the ones
usually missing: the **capabilities** (§6), the **coverage ladder** that gets there in small revertible
rungs (§6b), and the **refresh procedure + freshness target** that keep it up to date once it exists
(§7–§8 — the recurring cost, and the part that is easiest to under-plan).

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

## Where each section lives

**This doc was 2 504 lines and is now five.** Nothing was rewritten — whole sections moved, keeping
their numbers, so **`PLAN-SCALE` §6e still means §6e**; this table says which file holds it. The spine
below (§1–§6, §9, §10) is the model, the walls and the step ladder; the four children are the parts big
enough to be read on their own.

| § | subject | file |
|---|---|---|
| **§1–§5** | sizing, the walls, decisions fixed up front, what is superseded, the read path | **here** |
| **§6** + `C2` | the step ladder S1–S11 and where each stands | **here** |
| **§6b, §6c, §6h, §6j** | the coverage ladder, and what each country rung COST and PROVED | `docs/coverage-rungs.md` |
| **§6i** | the overview ladder — what it takes to open the app on a whole country | `docs/overview-ladder.md` |
| **§6f, §6g** + `C1b` | how a country's base map is generated and cut into regions | `docs/base-map-build.md` |
| **§6d, §6e, §7, §8, §8b** + `D2` | generating at scale, hosting, publishing, and staying current | `docs/block-pipeline.md` |
| **§9, §10** | what is still open, and the risks | **here** |
| **D12** (§3) | roads PARTITION, the base map COVERS — the rule the whole cut turns on | **here**, §3 |

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

### S1 ANSWERED (2026-07-30): native Range worked, the browser did not — and by the next morning it did

`tools/paged_http_gate.sh` — one generated program, three ways to run it, same store, same key:

```
[1] native, local file : RESULT ok=true entries=1 roads=1577 steps=8287   VERDICT PASS
[2] native, http Range : RESULT ok=true entries=1 roads=1577 steps=8287   VERDICT PASS
    store_load_keys: asked=1 loaded=1 bytes_fetched=262144 file=3580472      ← 7.3% of the file
[3] browser            : BUILD FAILED
    error[E0599]: no method named `load_key` found for mutable reference `&mut Stores`
```

**Control:** the same program using whole-file `store_load` builds for `--html` fine (353 KB wasm). So the
paged family was compiled out of the wasm target — `HttpRangeProvider` was `ureq`-based, which cannot exist
in wasm32, and nothing routed it through the asyncify `fetch()` bridge that `store_load_url_trusted` uses.

### ✅ FIXED UPSTREAM the same night — [loft#678](https://github.com/loft-lang/loft/issues/678)

`b64b4291` "the working-set store loaders now page in the browser too": `PageProvider` was the seam, only
`HttpRangeProvider` held the `ureq` client, and it now goes through `net::fetch_range`/`fetch_size`, which
carry the same native-vs-browser split `fetch_bytes` already had for `store_load_url_trusted` — the paged
reader, traversal and relocating copy are untouched and shared. Availability became one named cfg,
`paged_store`, replacing 25 hand-written `#[cfg(feature = "remote-store")]`s. Upstream proves it end to end
against a real Range host: **262 KB in 5 range requests (6.9%)**, asserted as a CONSTANT page count rather
than a ratio, *"because a keyed lookup's cost must not depend on image size; a silent whole-file fallback
would satisfy a ratio on a small fixture but never this."*

**Our gate flipped by itself, which is the point of it** (installed loft, md5 `74eac5b2…`, 2026-07-30 07:24):

```
[3] browser, http Range: OUT<<RESULT ok=true entries=1 roads=1577 steps=8287 VERDICT PASS>>
S1 RESULT  native_http=pass  browser=pass
PASS — the paged Range read works natively AND in the browser: PLAN-SCALE C1 is unblocked
```

⚠ **The fix is on `tuxedo-diagnostics2`, `fixed-pending-merge`, NOT yet in loft `main`.** It is in the
binary installed here; a fresh install from `main` does not have it yet. Keep D11 as the fallback until it
merges, and anchor any claim to the binary's md5 rather than to `--version`, which still says 2026.7.2 for
the third distinct binary in two days.

Two smaller items from the same report also landed: `loft --html` now names generated code AS generated
(pointing at `LOFT_KEEP_NATIVE_RS=1`, and saying that a builtin `--native` accepts and `--html` cannot is a
gap in loft), and `02_files.loft`'s stale *"FLAT (scalar-field) struct"* claim is corrected. The third —
a **declarative per-target builtin surface** (48 builtins are cfg'd off wasm with no place stating it) —
needs a design and is split out as [loft#680](https://github.com/loft-lang/loft/issues/680). Worth
tracking here: it is the reason this plan's §2 was written against a read path the browser did not have.

**Consequences, in order of importance:**

- ✅ **(RESOLVED 2026-07-30, see above.) The browser read path was BLOCKED UPSTREAM:
  [loft#678](https://github.com/loft-lang/loft/issues/678)**
  (`bug · wa:partial · sev:medium · area:wasm/stdlib/codegen · hit-by:routing`), with this gate and an
  8-line standalone repro attached, plus a second, cheaper ask: `loft --html` should refuse at the loft
  level rather than surfacing `E0599` from generated Rust that names `prog.rs`. Write-up:
  `docs/loft-feedback.md` 2026-07-30.
- ✅ **Everything native is unblocked** — `server/server.loft` can page a corridor out of a big block
  *today*, at 7.3% of the bytes. The server is where WE-scale data can be exercised first.
- ➡ **The ladder re-orders around it** (§6b): the work that needs no browser paging — end the
  full-collection scans, stream the generator, blocks + index, Hilbert ordering — comes first, and
  coverage grows meanwhile on **small whole-file blocks** (D11).
- 🚫 **We do not write our own Range reader** to get around this (the rule at the top). The interim is
  smaller blocks, not a private codec.

---

## 3. Decisions fixed up front

| | decision | why |
|---|---|---|
| **D1** | **Router WE-wide first; base map per-region on demand.** Ship roads (7–15 GB) as continuous coverage; treat layout blocks as an opt-in download per region. | §1(1) — the map is 6× the bytes of the thing that makes this app worth using, and `CLAUDE.md`'s split already says *loft does the ROUTE, JS does the MAP* |
| **D2** | **Object storage with Range + CORS** (R2/B2), app shell stays on GitHub Pages. **Now a TEST, not a plan** — `tools/cors_host_gate.sh` drives the real app with its blocks on another origin; a candidate host either passes it or is not a host for this app. | Pages caps a site around 1 GB and a Release asset at 2 GB (re-verify before sizing) — neither hosts 50 GB. R2 has no egress fee, which is the cost model that decides this |
| **D3** | **loft's working-set loader is the read path** — no codec, no JS range machinery, per the rule above. A gap in it is an **issue on `loft-lang/loft`**, and this plan waits on the fix rather than routing around it. | proven in §2 on both shapes; the one thing a hand-rolled reader would buy is speed, at the cost of hiding the gap the test-bed exists to find |
| **D4** | **Keep the two cell sizes** (roads 0.02°, layout 0.005°). ~~Hilbert-order tiles within a block.~~ **AMENDED 2026-07-30: the ordering is decided by MEASUREMENT at C2** — on today's block a viewport wants 42 of 88 cells, so no layout can win, and Hilbert measured worse (S3). | changing cell size is a data migration; ordering is a layout, not a format, so it stays free to change — and routes are byte-identical under every ordering tried |
| **D5** | **Blocks are per-country or per-split, ≤ 2 GB, and the dataset VERSION is in the URL.** | a client must never mix versions mid-session; per-block regeneration is what makes a hotfix cheap (§7) |
| **D6** | **The top index is ours and tiny** — bbox → block URL + version, one row per block (12–40 rows). | the store is its own directory (D3), so the only thing we author is the map from geography to block |
| **D7** | **Cross-block continuity rides the existing border rule** — ways split at tile borders, border nodes grid-snapped so neighbours merge exactly — extended to blocks, with its own gate. | `tools/tile_border_gate.sh` already proves this across *tiles*; blocks are the same rule at a bigger seam |
| **D8** | **Overpass fallback stays** for outside-coverage sketches. | it is the only thing that makes a partial rollout usable — and every rung of §6b is a partial rollout |
| **D9** | **The refresh runs on the maintainer's machine or a self-hosted runner**, resumably; CI validates the manifest and the published index but does not build the data. | ~30 GB of source and hours of CPU against Actions' ~14 GB disk / 6 h job (§7 R10) |
| **D10** | **Coverage grows by RUNGS (§6b), each one live and revertible by an index flip**, and the refresh loop runs from the first rung. | a wall found at 1 block costs a day; the same wall found at 40 blocks costs the dataset |
| **D12** | **Roads are cut as a disjoint PARTITION; the base map as an overlapping COVER.** Every cell belongs to exactly one roads block, while base blocks carry a 0.10° margin and deliberately overlap. **The read decides which, not the geography:** a route corridor is *unbounded* — it follows the route — so a duplicated road is read twice and matches a **different** route (wrong, not slow); a viewport is *bounded* to about 0.1°, so a duplicated margin removes the seam and is never read twice. Named 2026-08-03 while asking why a country border needs more care than a region border: it does not — **the layer** does. Consequence: a neighbouring country needs its ROADS trimmed to unowned cells, not the continent re-tiled (`plans/51-coverage-past-nl/`). | the four NL regions already ship both rules; this states the one that was implicit. It is also why raw Geofabrik per-country extracts are not a mistake to route around — they do the base-map thing (duplicate enough to be whole) to data we consume the roads way |
| **D11** | ⏸ **RETIRED 2026-07-30 (kept until loft#678 reaches `main`, since a fresh install from `main` still lacks the fix).** Until the browser can page (S1), coverage grows on SMALL WHOLE-FILE blocks — city-sized, ~20–50 MB, the app loading the one or two its viewport needs — and switches to working-set reads the day `store_load_key` compiles for `--html`, with no format change (same stores, same keys). | it is the only honest interim: the block SIZE is the only lever a whole-file loader has, and it costs block count and index rows, not a codec. ⚠ It does NOT reach C4/C5 — a phone cannot whole-file its way through WE — so it buys coverage growth and pipeline experience while the upstream ask lands, and the plan's end state still depends on it |

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

**Every step is safe by construction, and that is a requirement, not a hope.** Five rules, so no step can
take the app down and none of them needs a flag day:

1. **The shipped app keeps working throughout.** New coverage arrives as a *new dataset version at a new
   URL*; the running app points at whatever the top index says. Nothing is edited in place.
2. **The index is the only switch.** Publishing data changes nothing user-visible; flipping one small
   index file does. **Rollback = flip it back**, and the previous version is still there.
3. **Every rung is proven against the rung below it** on the geography they share: the same corpus of
   sketches must route identically (`match_parity.sh` shape). Growing coverage must not change a route
   inside the old coverage — that is the whole safety property, and it is checkable.
4. **No step both grows coverage and changes a format.** Migrations are their own steps, with their own
   parity gate, so a bad day has one suspect.
5. **A step that cannot be measured does not ship.** Each one below names its observable and its gate.

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

**S2 · Kill the full-collection scans (W4).** ✅ **DONE for the corridor (2026-07-30).**
`corridor_ways_impl2` enumerates the sketch's cell window and looks each cell up by key; the tube test runs
on the cell's own centre *before* the lookup, so a cell outside the tube costs arithmetic and no store
access — which is also what makes it safe to page later (C1b must not fetch a cell it does not need).

*The premise it was blocked on was stale.* The code walked the store because *"keyed lookup `store[key]`
isn't reliable on a mmap-reloaded store"*; re-tested on a `store_persist_bind`-ed block that is **88 keys,
0 misses, 0 mismatches**.

| gate | result |
|---|---|
| `tools/match_parity.sh` | ✅ byte-identical, 3 distinct routes over 5 cases |
| `tools/tile_border_gate.sh` | ✅ 4 corridors, golden fingerprints unchanged, still order-insensitive |
| `tools/corridor_scale_probe.loft` (**new**, in `make test-native`) | ✅ identical corridor and **flat** at 501× the tiles |
| `tools/match_phase_probe.loft` | corridor **20–22 ms** before and after — the real interaction is unmoved |

⚠ **Two things this step cost, both worth keeping:**
- **The first version of the scale probe could not fail.** Its synthetic tiles carried real roads, so
  decoding the corridor's own 2702 ways swamped the scan and the probe passed *against the old
  walk-the-store code*. Rebuilt with EMPTY far-away tiles — a scan iteration and nothing else — it now
  separates them cleanly: old **51 → 358 ms** at 501×, new **flat**. A gate is not a gate until it has
  been shown to fail.
- **The first refactor was slower.** Returning a fresh `vector<Way>` per tile and doing `ways += …` copies
  every Way once per tile (~40% on a short corridor). It appends through a `&` reference instead.

### C2 — the multi-block wiring is DONE; only the data is missing (2026-07-30)

The kernel's line 1 is no longer a block, it is the **covering set** — the roads blocks whose extent a
command touches, comma-separated. One entry is the C0/C1 case and behaves exactly as before; a corridor
near a seam names two and the working set is filled from each in turn, which S8 proved the matcher cannot
distinguish from a single block.

- **More than one block can only be PAGED**, and the kernel enforces that rather than trusting the hint: a
  whole-file load *adopts* an image, so the second would replace the first, where `store_load_keys`
  accumulates by design. The plan predicted this forcing function; it is now mechanical.
- **Marks are per (block, cell)**, not per cell. Every covering block is asked for the whole window, and a
  block that legitimately holds none of those cells must not mark them fetched for its neighbour.
- **The app derives the set per command** — a view from its viewport, a match from the sketch's bbox padded
  by 0.05° (beyond the corridor margin the kernel will add, so a corridor cannot want a block the app never
  named).
- ⚠ **If one block contains the whole box, the set is that block alone** — the smallest such. Real blocks
  are disjoint (regions cut on cell boundaries) but the index cannot enforce it, and a detailed city block
  inside a country block is exactly what an overlap looks like. Naming both would feed the SAME roads to
  `build_graph` twice, and **a duplicated way is not a slower match, it is a different one**. The unit test
  caught that on its first run, before any second block exists.
- The **base map stays single-block**: `expose` pins one store, and re-scoping that is S5/C3.

### C2 — THE NETHERLANDS IS BUILT (2026-07-30)

Real data, end to end, through the pipeline the plan specifies (`tools/build-blocks.sh`, §7 R1–R5):

```
geofabrik netherlands-latest.osm.pbf   1.4 GB   (md5 verified)
osmium tags-filter w/highway           187 MB
osmium export -f geojsonseq            884 MB   2,784,366 features
gen-tiles (streaming)                  2m16s → 12,457 tiles · 2,784,366 roads · 322 MB
extent  lat 50.7400..53.5418  lon 3.3400..7.2430
```

**The claim C1b could not demonstrate on a 3.5 MB block is now demonstrated:** a 42-cell viewport reads
**10.5 MB of a 337 MB block — 3.1%**. On the small block the same read was 44–80%, because a 56-page block
has nothing to be selective about. `readMode = "paged"` is in the index for this region, and the app uses
it.

**The route survived the change of dataset**: the gate's sketch matches to `route_pts=213 len=13138.0m` on
NL data, identical to the Enschede block it replaced — from a different extract, a different vintage and
35% more roads in view.

Three things real data taught that no probe had:

1. **osmium writes RFC 8142** — every `geojsonseq` record is prefixed with a RECORD SEPARATOR (0x1E).
   `json_parse` rejected it, `parse_way_feature` returned "no way" for all 2.78 M lines, and the run
   produced an EMPTY BLOCK with no error. ⚠ *S6's round-trip gate had passed* — because it fed the reader
   **our own writer's** output, which omitted the RS. A round trip proves a reader against the writer it
   was tested with, not against the world; the emitter now writes the RS too.
2. **A store leak that only 65k+ records can reach** — [loft#688](https://github.com/loft-lang/loft/issues/688).
   A struct owning a collection, constructed and then ABANDONED (built as a local, a different value
   returned), never has its store reclaimed; at 65,535 calls the process dies with "store table exhausted".
   Both backends. Our parser had exactly that idiom. Invisible below 65k of anything, so no test suite
   finds it — only production-sized data does.
3. **ROAD BLOCKS MUST NOT OVERLAP.** With both Enschede and NL listed, a sketch whose padded bbox escapes
   the small block named BOTH, and the same roads were read twice: **7,138 ways became 9,438 for an
   identical route**. It survived only because `build_graph` dedups nodes by coordinate. The fix is in the
   DATA — one block per area — and the manifest now says so where the deleted region used to be.

⚠ **One check is open, and it is a decision, not a bug.** Switching the app to real NL data moved the
render (expected: `R=3112 → 4197` roads in the viewport, pixel hash `917244eb → 751c9c58`) and pushed
§6d's block-cache bounded delta from **15 to 25**, above its threshold of **16 — a threshold chosen on the
old dataset**. With 35% more thin lines, more pixels sit on the snapped-origin boundary, which is the
phenomenon §6d measured; whether 25 is still "rounding" or an artefact worth chasing needs the same rigour
§6d used, and the threshold has deliberately NOT been touched in the meantime.

*What C2 still needs is data and nothing else* — generate NL blocks, add them to `data/coverage.toml`,
rebuild the index. ✅ **And the browser runs it** (`tools/cross_block_browser_gate.sh`, in `make test-map`). The hole — the
app only ever exercising a set of ONE — is closed the same way S8 closed its own: the shipped block is
split beside itself in `_site`, the page's own coverage index is swapped for one naming both halves, and
the SAME sketch is matched twice:

```
split at cell 345 (6.9°): west tiles=44 roads=16561 · east tiles=44 roads=9410
single block : 1 url  · SUMMARY ways=7138 route_pts=213 len=13138.0m · routeHash=bb724a2c
two blocks   : 2 urls · SUMMARY ways=7138 route_pts=213 len=13138.0m · routeHash=bb724a2c
✓ two blocks, paged: 49 range reads total; route identical to the single block
```

The gate asserts the split run **named two blocks** before comparing anything — a fallback to one would
otherwise pass while testing nothing — and the halves are temporary, built and removed per run, so the
fixture cannot drift from the block it came from.

✅ **The browser runs it too** (same day): [loft#681](https://github.com/loft-lang/loft/issues/681) — the
`--html` import-validation regression that had pinned `store-kernel.wasm` to the previous kernel — was
fixed within the afternoon, the wasm rebuilt, and the browser gate reproduced the route exactly:
`ways=7138 route_pts=213 len=13138.0m`, identical to the pre-C1a run. `map_render_gate.sh`'s staleness
guard is now FATAL, so a kernel change that never reaches the wasm fails the gate instead of passing it.

✅ **The JS viewport filter too (2026-07-30).** `viewFromStore` read 5 scalars from EVERY tile to apply
§7g's extent screen — exact, cheap per tile, and proportional to the MAP. It now queries an index built
over the tiles' own sealed extents (`tileIndex` in `map.mjs`), cached per exposed store.

*A cell-key window would have been unsound here* and that is the whole reason the index is built on
extents: features are keyed by their FIRST VERTEX and never clipped, so a tile's geometry overhangs its
cell — measured at up to ~9 km for lines (PLAN-PERF §7g). Two tiers keep one bucket size from having to
fit both a house and a river: tiles wider than `MAX_SPAN` buckets go in a `wide` list every query checks,
and `fcount == 0` tiles (no extent — an empty tile, or a store predating the field) stay candidates so an
older store degrades to slow rather than blank. **The exact extent test still runs per candidate; the
index only decides who is worth testing.**

| evidence | |
|---|---|
| **reads per view** (DOM-free, injected deps count the calls) | **3, whether the store holds 59 tiles or 5009** — the old path read 298 and 25,048. Deterministic: a count, not a timing |
| emitted set | identical to a full scan, asserted against one computed in the test |
| real store, headless | layer counts unchanged (buildings 16646 · areas 2252 · lines 1231 · pois 4460 · streetLabels 1439 · places 2) and the **render pixel hash unchanged (`917244eb`)** |
| `CPU_THROTTLE=4`, load 1.9, spreads 1.1–1.5× | storeRead **22 ms**, view total **142 ms** — within noise of the 146 ms on record. The gain today is small because 1089 tiles is small; **the gain is the exponent, not the constant** |

The index build is O(n) once per store — 5 reads × 1089 tiles, i.e. exactly what ONE view used to cost —
and every view after it is free. **S2 is complete.**

**S3 · Page-locality: Hilbert ordering.** ⏸ **MEASURED AND DEFERRED (2026-07-30) — the instrument exists,
the decision belongs at C2.** The plan assumed a Hilbert curve was the answer (D4). Measured on the block
we have, it is not evaluable here and, as implemented, it is a net loss:

| ordering | file | bytes fetched for a 42-cell viewport |
|---|---|---|
| as generated (row-major) | 3,816,152 | **3,211,264** (84% of the file) |
| explicit `row` | 3,816,152 | 3,211,264 |
| **`hilbert`** | **8,904,352** | **3,604,480** — *more absolute bytes, out of a 2.3× file* |

**Why it cannot be evaluated at this size:** a realistic viewport wants **42 of the block's 88 cells**, so
any layout fetches most of the file. Locality has nothing to win until a viewport is a small *fraction* of
a block, which is C2 onwards. Routes are byte-identical under all three orderings (the border probe's
three golden fingerprints), so the ordering is free to change later — it is a layout, not a format.

⚠ **An unexplained 2.33× file, recorded rather than diagnosed.** Rewriting the block in Hilbert order
yields 8,904,352 bytes for identical content — 88 tiles, 25,971 roads, 159,993 steps — reproducibly, from
any input ordering; rewriting it back gives exactly 3,816,152 again. But a standalone repro (2,000 records
of 200 values, inserted ascending vs scattered) shows **1.00×**, so *"scattered insertion inflates a
store"* is NOT established and nothing was filed upstream: a report whose repro does not reproduce is
noise. What is known is written down, with `tools/reorder_tiles.loft` to re-check it at C2 scale, where
the answer actually matters.

**D4 is amended:** tile ordering is decided **by this measurement at C2**, not assumed now. The tooling is
the deliverable — `tools/reorder_tiles.loft` (hilbert / row / keep) and
`tools/page_locality_probe.loft` (a fixed viewport's `bytes_fetched`, via `LOFT_LOADER_STATS=1`).

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

**S6 · Streaming generator input (W1).** ✅ **DONE (2026-07-30).** `gen-tiles` reads a `.geojsonseq` /
`.jsonl` input line by line and holds one chunk whatever the file size; the whole-document Overpass path
stays for small inputs, and the FORM of the input picks the reader. PLAN-TILES' recipe already ends in
`osmium export -f geojsonseq` and then converts — streaming reads that file directly, so the conversion
step disappears.

*loft has no streaming line reader:* `lines()` is built on `content()`, so both hold the whole file. The
binary idiom does stream — seek, read a chunk, use only the part up to its LAST newline, seek back to just
after it. That last detail is what makes it safe: a chunk boundary can never split a line, and a partial
multi-byte character at the end of a chunk is never decoded (proven on a 64-byte file with a multi-byte
character read in 12-byte chunks).

*Gate:* `tools/gen_stream_gate.sh`, in `make test-native`. The original Overpass JSON is long gone, so the
round trip is closed against the store itself — **block → `geojsonseq` → streamed generator → block'** —
and the assertion is the **route**, not the counts: the border probe's golden fingerprints must be
unchanged, because equal tile counts would not catch geometry that moved a centimetre.

```
wrote 25971 features / 159993 coords (6393262 bytes)
streamed: 25971 features from 6393262 bytes in 1048576-byte chunks
built: tiles=88 roads=25971
routes before: 13491979666115 13491979666115 2009382494520 1467589415931
routes after : 13491979666115 13491979666115 2009382494520 1467589415931
```

✅ **The BASE generator streams too (2026-07-30).** `client/basemap/build_store.loft` read six Overpass
documents with `file().content()`, so a country's base map meant six whole documents plus every parsed
element resident at once — the same wall the roads generator had, six times over. It now reads
`.geojsonseq` layers line by line and shares one set of `bin_*` functions with the whole-file path, and
`osmium export`'s **Polygon** shape (a closed way with an area tag) is handled beside LineString and Point.
Gate: `tools/base_stream_gate.sh` in `make test-native` — the same fixtures, built both ways, every layer
count equal (1089 tiles · 28,773 areas · 130,402 buildings · 11,310 labels · 6,585 lines · 27,912 pois).
A mixed invocation is refused rather than half-honoured.

⚠ **Two traps that cost an hour between them, both worth knowing:**
- **A helper that RETURNS a tile silently loses every write.** The first draft had
  `fn tile_at(…) -> PTile`; a whole-value bind COPIES a heap value (loft C86), so it created all 1089
  tiles and binned nothing into them — a store that is structurally perfect and empty. The helper returns
  a KEY now, and each caller re-reads `idx[key]`, which is a live view.
- **`store_persist_bind` binds to an existing image rather than replacing it.** Every corrected run
  afterwards reloaded the *old* empty tiles from the file the broken run had left behind, with
  persist/load/verify all reporting true — so the fix looked like it had not worked. The generator now
  deletes the target first, which is what `tools/build-blocks.sh` already did for roads without my knowing
  why it mattered.

⚠ The **flat-memory claim is structural, not yet measured**: the reader provably holds one chunk, but
"a country-sized input generates in bounded memory" needs a country-sized input, which is C2's data half.
The emitter (`tools/tiles_to_geojsonseq.loft`) carries the one subtlety worth remembering: its class →
highway map must cover EVERY class the store can hold, including the ones the corridor ignores (14, 15).
`tile_hw` maps only the routable ones, so using it would have dropped those roads and let the round trip
"pass" by losing data.

**S7 · Blocks + top index (D5/D6).** ✅ **The index and the resolver are DONE (2026-07-30);** rolling
shards wait for a second block, i.e. for data.

- **`data/coverage.toml`** is the manifest (§7 R0) — the only place a region enters coverage. It
  deliberately does **not** declare bounding boxes: a block's extent is a fact about the data (osmium
  clips, a generator drops what it cannot classify), so a declared bbox that outran its data would be a
  hole in the map the index insisted was covered.
- **`tools/build_index.sh`** opens every block, reads its MEASURED extent (`tools/store_extent.loft`),
  and writes `_site/coverage.json` — 617 bytes for one block: url, bytes, **sha256**, tiles, features,
  bbox, and the per-block `readMode` (C1b's switch, now a property of the DATA as promised). The hash is
  what lets R6 publish against `store_load_url`, the loader that VERIFIES.
- **`browser/coverage.mjs`** resolves: `pickBlock` (smallest covering block wins, so a city inside a
  country wins), `blocksForBox` (what a viewport straddling a border needs — C2's cross-block case,
  already answered), and `resolveCoverage` with its fallbacks stated rather than implied: no index → null
  and the app says so; index but no cover → the first block, **flagged**, so a visitor outside coverage
  gets a map to pan from instead of a blank page.
- **The app no longer hardcodes its stores.** Two `const`s at the top of `store-app.mjs` were exactly as
  far as one block goes — a second region would have meant a second build of the app.

*Gate:* nine DOM-free assertions in `map.test.mjs` (city-inside-country, two countries, a point in
neither, a border viewport needing both, and all three fallbacks), plus the browser gate now REGENERATES
the index and boots the app through it. Route, layer counts and pixel hash `917244eb` all unchanged.

⚠ **The bug this caught is the one to remember.** The index first lived at `_site/stores/index.json`, and
a URL resolves against the file that CONTAINS it — so `"stores/enschede.roads.store"` became
`stores/stores/…`, every block 404'd, and the app booted into an empty map. Nothing in the unit tests
could see it; the browser gate failed on the first run. **The index belongs at the site root**, which is
what the block URLs are relative to.

**S8 · Cross-block stitch (D7).** ✅ **PROVEN (2026-07-30), without waiting for a second real block.**
A seam is MANUFACTURED from the block we ship — `tools/split_block.loft` cuts by CELL, so no way is cut
and no coordinate moves, which is the same seam a per-region generation produces — and the reference is
the same corridor against the unsplit block:

```
split at cell 344 (6.88°): west tiles=35 roads=11038 · east tiles=53 roads=14933
#X whole  ways=8436 route_pts=131 fp=862017430
#X split  west_keys=18 east_keys=24 tiles=42 ways=8436 route_pts=131 fp=862017430
#X ALL PASS — 18+24 cells from two blocks route identically to the single block
```

**The mechanism is the working set itself:** `store_load_keys` accumulates, so the same local collection
is filled from each covering block in turn and the matcher never learns there was a seam. Both routes are
computed in ONE run, so there is no golden to drift, and the gate checks non-vacuity first — both sides
must contribute cells, or it proves nothing.

*This is the property every rung from C2 up stands on*, and it was the one most likely to be discovered
late, over real data, with nothing to compare against. `tools/cross_block_gate.sh`, in `make test-native`;
nothing is committed but the tools, so a re-keyed or regenerated block is re-split automatically.

**S9 · Hosting (D2).** Blocks on R2/B2, Range + CORS from the browser origin. *Observable:* a 206 with
correct bytes, cross-origin, from the deployed page. *Gate:* a headless check in `make test-map` against a
real (small) hosted block.

**S10 · Roll out roads WE-wide** (D1), base map per-region opt-in. *Observable:* a cold visitor routes
anywhere in coverage; the base map offers a region download. *Gate:* the 26-sketch corpus still 0-worse;
`CPU_THROTTLE=4` warm match inside its current budget.

**S11 · The refresh procedure** — §7, and it is a project of its own.

---

## 9. Still open — with the instrument named

| | question | how it gets answered |
|---|---|---|
| 1 | ~~Does the paged Range reader work in a `--html` build?~~ | ✅ **ANSWERED — and now YES.** It did not compile (E0599); [loft#678](https://github.com/loft-lang/loft/issues/678) fixed it the same night, and `tools/paged_http_gate.sh` reports `browser=pass` at 262 KB / 5 range requests. ⚠ Fix is `fixed-pending-merge` upstream, present in the installed binary only |
| 2 | ~~What does a realistic viewport working set actually cost in bytes?~~ | ✅ **ANSWERED 2026-08-01, and the base-map half was RETRACTED the next day.** Roads: **17.7 MB of 222.4 MB (8.0%)** for a route on a country block, 271 Range reads (`nl_live_gate`) — that still stands. ⚠ **The base map is NOT 75–190 kB per viewport.** §6f measured it: a viewport is **8.1 MB** (`base_paged_gate` phase 1, 13 viewports) and a dense metro one is **21.8 MB, or 68.4 MB one zoom out**. The old figure multiplied a store-wide average tile (9.1 kB) by an unpadded cell count. Costed per host in `docs/hosting-cost-model.md` |
| 3 | Is per-working-set `expose` fast enough to render from? | S5; fallback is JS reading pages directly. ⚠ Now the **critical path** for a full NL base map — §6f F2. The READ half is answered (a paged `store_load_key` on a 1.11 GB base store returns a tile identical to the whole load, for 512 kB) ; what is untested is re-`expose` as the working set GROWS |
| 3b | Which builtins are missing on the browser target? | ✅ **ASK IT: `loft targets wasm`** (loft#680, shipped 2026-07-30 — derived from rustc, so it cannot drift from the cfgs). Today it answers *"every stdlib builtin is available here"* |
| 4 | Real density factor, hence real total size | S0 (three blocks) |
| 5 | Is keyed lookup on a reloaded store reliable now? | S2 — the paged loader gives keyed access by construction, which may retire `corridor_ways_impl2`'s comment |
| 6 | ~~R2 vs B2: Range + CORS behaviour and egress cost~~ | ✅ **PRICED 2026-08-04 — `docs/hosting-cost-model.md`.** Against our own measured session (~1 600 requests / ~100 MB): R2 wins from ~10k sessions/month (**$2.68 vs $8.91**) and by ~2× at 100k (**$54 vs $99**). The bills are OPPOSITE in shape — R2 charges requests, B2 charges bytes — and we are byte-light, request-heavy. ⚠ **The binding limit is not either of them: GitHub Pages' 100 GB/month caps us at ~1 000 sessions**, and that binds at Benelux, not at WE. ⚠ One input unresolved and worth 10×: whether a Cloudflare cache HIT still bills a Class B op (docs silent, community says yes). Settle before paying |
| 7 | ~~`oneway=` is still dropped by the store~~ | ✅ **CARRIED 2026-08-03.** `nets` moving to its own u16 (PLAN-LAYERS §3) freed bits 8–15 of `flags`, and direction now uses four of them: two for `oneway=` and a two-bit FIELD for `oneway:bicycle`, because a signed contraflow (`oneway=yes` **and** `oneway:bicycle=no`, 597 of them in the Enschede fixture alone) is the case one bit cannot express. `oneway_flags`/`oneway_tags` live beside each other in routing_kernel so the generator does not know the layout. The ROUTER never needed changing — `dir_allowed` has honoured direction since the matcher was written; it was fed `""` by every stored way, so this was a storage gap, not a matcher one. Regenerated fixture: **5345 / 1 / 597 / 51** for yes / -1 / bike-contraflow / bike-forward, matching the source export exactly, against **0 of each** before. A/B on one sketch: `driving_fastest` 27 pts 1062.2 m → 28 pts 1048.3 m, `walking_paved` **identical** (the control — foot ignores direction by design). ⚠ **The published blocks do not carry it until the next regeneration**; the code is inert on a block whose bits are zero. Old note follows | the flags byte is FULL (8/8 bits, see routing_kernel's `RF_*`). Carrying direction needs 2–3 more bits, hence a `u16` — which every existing block must be regenerated for, because the field width is in the schema. Deliberately not half-done alongside the access fix |
| 8 | ~~The NL blocks predate the access bits~~ | ⚠ **NOW A HARD REQUIREMENT, not missing data.** `TTile` gained a `barriers` collection, and a store written before it does not read as "no barriers" — it reads GARBAGE (`len` came back as 20 981 984 713), because `store_load` maps old records at the new stride and ignores the sidecar's own schema hash ([loft#700](https://github.com/loft-lang/loft/issues/700), `sev:high`). Every block MUST be regenerated. `tools/build_index.sh` and `tools/access_gate.sh` both refuse a block whose `.dschema` lacks `barriers@`, so a stale one cannot reach the app |
| 9 | ~~Barrier NODES are never fetched~~ | ✅ **DONE.** `osmium tags-filter w/highway n/barrier` + `--geometry-types=linestring,point`, `parse_barrier_feature` bins them per tile, and `build_graph_barriers` lands each on its graph node by coordinate. 989 in the Enschede block. ⚠ The **Overpass** path still asks for ways only, so an Overpass-sourced corridor (`server.loft`'s fallback when no tile block covers the area) still walks through gates |
| 10 | A barrier BETWEEN way vertices is dropped | `apply_barriers` lands a barrier on the node that shares its coordinate; one tagged mid-segment matches nothing. Correct today (a route cannot pass through a point that is not a node) and worth revisiting only if real data shows barriers tagged off-vertex |
| 11 | ~~An index is capped at **62 blocks**~~ | ✅ **RAISED AND GATED.** The per-block bitmask became an owner LIST (`8fe43a7`), so there is no ceiling. Measured, not asserted: `block_overlap_gate.sh` runs the checker at **70 blocks / 2 415 pairs** — the old code refused outright — and re-rejects a manufactured partial overlap at 72, because passing on volume alone is the failure that check exists to catch. ⚠ The fix landed 2026-08-03 with **no test**, so "no ceiling" was a comment for a day; the gate is what closed it |
| 12 | The GENERATOR does not stream | ~350 bytes of RSS per feature, so a WE-sized store is 130–270 GB. §6e's answer is to never build one that big — one region per run, fed by a single `osmium extract --config` pass. Only if chunking fails does this become an upstream ask for an incrementally-writable store |

---

## 10. Risks

- **The base map's size is the project's shape.** If S0 comes in at the high end (~90 GB), D1 is not a
  preference — the base map has to become vector-tile-ish or externally sourced, and that is a different
  plan. Measure before committing storage.
  ⚠ **Partially measured 2026-08-01, and the news is mixed.** NL came in at 2.06 GB for 17.29 M features,
  and 92% of it is buildings (53.7%) plus landcover areas (38.5%). Buildings are already lean at 7.9 coords
  each — there are simply 5.6 M of them — so there is **no 5× saving available**: dropping buildings
  entirely and halving areas still lands at ~700 MB for two halves. Shrinking does not reach Pages, and
  neither does splitting (the cap is on total site bytes). **Only a different host does**, which makes D2
  the decision the base map hangs on rather than an optimisation of it.
- **W5 is the one that can force a loft change.** Everything else is our own code; the render bridge's
  `expose` semantics are not.
- **Page granularity may not amortise.** If Hilbert ordering does not make a viewport's tiles share
  pages, per-view bytes stay ~18 MB and the layout tile size (0.005°) has to grow — a data migration, so
  S3 comes before any bulk generation.
- **The refresh procedure is where this rots.** Unwritten automation plus a broken elevation cache plus a
  hand-made block is exactly the state from which a dataset never gets updated again. §7 before §6 S10.
