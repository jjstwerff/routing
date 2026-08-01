<!--
Copyright (c) 2026 Jurjen Stellingwerff
SPDX-License-Identifier: LGPL-3.0-or-later
-->

# PLAN-SCALE — from one city to Western Europe

**Status (2026-08-01): C0–C2 BUILT. The Netherlands routes and searches on GitHub Pages — but the map is
BLANK outside Enschede, and §6f is the design that fixes it.** Roads
(233 + 264 MB) and a name index (36 MB) ship same-origin and paged; the base map (999 + 1058 MB) is
regenerated and published but awaits a host (D2). The site sits at **560.5 MB of a ~950 MB budget**,
measured on every build. §6c has the rung, **§6e has what NL taught about Western Europe** — including the
correction that the client already streams and it is the GENERATOR that does not.

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

## 6b. The coverage ladder — how it actually gets to WE

The steps above are *capabilities*; this is the *rollout*, and it is deliberately a ladder of small,
boring, revertible rungs. Each rung is a **real deployment** that a user can route on, each is entered only
when the named gates are green, and each can be the last one for a while without anything being
half-finished. **Coverage grows ~4–10× per rung, so a wall shows up while it is still cheap to hit.**

| rung | coverage | ≈ blocks / bytes (roads + layout) | needs | what it proves for the first time | entry gate |
|---|---|---|---|---|---|
| **C0** | today: 283 km², one block, whole-file | 1 / 24 MB | — | the app routes and renders at all | shipped |
| **C1a** | ✅ **DONE 2026-07-30, native AND browser** — no full-collection scans | 1 / 24 MB | S2 | keyed reads replacing scans — **at a size where a mistake is visible and cheap**; and the server reading a corridor at 7.3% of a block's bytes | `match_parity.sh` byte-identical; corridor tiles-touched a function of the sketch, not of the store |
| **C1b** | ✅ **DONE 2026-07-30** — the app can read its roads block by BYTE RANGE (`readMode: 'paged'`), route-identical; shipped OFF for this block, see below | 1 / 24 MB | ✅ [loft#678](https://github.com/loft-lang/loft/issues/678) | the working-set read path where the app actually runs | ✅ route + pixel hash unchanged; the gate asserts range reads happen and reports the fraction |
| **C2** | ✅ **DONE 2026-08-01 — the Netherlands ROUTES AND SEARCHES on Pages.** Roads (233 + 264 MB) and names (36 MB) same-origin and paged; base map (999 + 1058 MB) regenerated and on the release, awaiting D2. See §6c for the state and §6e for what it taught about WE | 2 halves / 0.53 + 2.06 GB | S6, S7, S9 | multi-block, hosting, a generator that streams | ✅ N0 green per half; S8 seam route identical; `nl_live_gate` routes + searches in Amsterdam |
| **C3** | **Benelux + one big neighbour** (NL, BE, LU + FR-north or DE-west) | ~6 + ~12 / 1.5 + 9 GB | S4, S5, S8 | working-set eviction and the re-scoped render bridge under real panning; a cross-BORDER route between two countries | C2 stable; peak memory ceiling held on a 500 km pan |
| **C4** | **WE roads, base map per region** (D1) | ~10–16 roads blocks / 7–15 GB; layout on demand | S10 | the product: a cold visitor routes anywhere in WE | C3 stable; 26-sketch corpus 0-worse; warm match inside its `CPU_THROTTLE=4` budget |
| **C5** | **WE base map** as coverage, not opt-in | +25–45 blocks / 44–88 GB — ⚠ §6e's disk-derived chunking says **34–68**, from a different direction | S0's real numbers, D2 cost check | that the map layer is affordable at all | C4 stable and S0 says the bytes are what §1 guessed |

⚠ **"a generator that streams" (C2's wants column) was answered in §6e, and it does not mean what it
sounds like.** The client already streams and already scales — a viewport is 75–190 kB whatever the store's
size. What does not stream is the GENERATOR, which accumulates a whole store in memory (~350 bytes/feature;
130–270 GB for WE). The fix is not a bigger machine or a smaller store but **never building one that big**:
one region at a time, fed by a single `osmium extract --config` pass, which is the block structure C4/C5
already specify.

✅ **C1b is unblocked (2026-07-30).** It was blocked for nine hours; the plan was written to keep moving
without it and did not have to. C1a's work — ending the full-collection scans — is still the first thing to
build, because it needs nothing from anyone and every later rung stands on it. **C1b is now what the plan
said it would be: a URL policy change, same stores, same keys, no format change.**

**The refresh loop runs from C1a, not from C4.** Whatever the rung, the dataset it serves is produced by
§7's procedure — so the automation is exercised while it costs one small block, and by the time it manages
40 blocks it is the same script that has been running for months. *This is the one sequencing decision in
this plan that actually determines whether WE coverage is ever up to date* (§8).

Each rung's dataset is published under its own `v<date>/`, and **the rung below stays live** until the new
one has served real traffic. Rolling back a rung is flipping the index (rule 2), not regenerating anything.

⚠ **C5 is a genuine decision point, not a formality.** If S0's measurement puts the base map near the top
of its band, the honest options are: keep it per-region on demand forever (C4 is then the end state, and it
is a good one), reduce its detail (drop buildings outside urban cells, coarser cells at low zoom), or
source the map externally and keep loft on the route. Do not pre-commit storage to C5 before S0 reports.

---

### 6c. The NL rung, step by step (2026-07-31) — and what it costs to keep going

The ladder above is still the shape. This is the executable list for **C2**, written after re-measuring
what is actually on disk and on the wire, because three of C2's assumptions have moved.

**What is already true, measured today:**

> ## ✅ N0–N3 AND N6 ARE DONE (2026-08-01). The rung below is kept for its reasoning; this is the state.
>
> | | |
> |---|---|
> | NL roads | **live on Pages, same-origin, paged** — `nl-west` 233.4 MB + `nl-east` 263.9 MB, regenerated from a fresh md5-verified extract, carrying `RF_NET_*` network bits (`TRoad.flags` u8→u16) |
> | NL names | **new** — `nl.names.store`, 36.1 MB: 296 474 street names + 12 700 places, searched offline (PLAN-RESTORE R4) |
> | NL base | regenerated and published, **999.3 + 1058.3 MB** — smaller than the 1.44 GB halves it replaces *while carrying more categories* (loft#710's allocation artifact, favourably); stays on the release |
> | the site | **560.5 MB of a ~950 MB budget (59%)**, measured every build by `tools/site_size_gate.sh` |
> | release | `data-v2026-08-01`, 2.6 GB, every asset verified 206-and-correct-size before the index was uploaded |
> | refresh | `tools/refresh-region.sh` is the whole sequence; `data-refresh.yml` drives it, `workflow_dispatch` only |
>
> **N3's gate is `tools/nl_live_gate.sh`** — it opens the app in Amsterdam, where no other browser gate
> goes, and proves the claim end to end: resolves to `nl-west`, base `NONE`, routes 29 points, reads
> **17.7 MB of the 222 MB block (8.0%)** by Range, and finds "lonneker".

**What was true when this rung was written (2026-07-31), kept because the reasoning still holds:**

| | |
|---|---|
| release hosting | **Range yes, CORS no** — re-measured: `206` with a correct `Content-Range`, and no `access-control-allow-origin`. The note in `build_index.sh` is right, which is why the site index excludes them |
| Pages hosting | Range yes, ~1 GB per site. **NL roads fit. Roads + base do not.** |
| the blocks vs the pipeline | the base blocks were built `2026-07-30 17:01`; the classification work landed `2026-07-31 18:23`, so **they predate relations, sites, aeroway, heath/scrub and cemetery labels** |

**The one structural unknown**, and it is the whole difference between the two halves of this rung: the
roads store has a paged read path and the **base store does not**. `store-app.mjs` fetches `LAYOUT` as one
URL and `expose`s it into wasm memory. At 20 MB that is fine; at 1.44 GB it is not a tuning problem, it is
wasm32. **Routing over NL is a hosting-and-regeneration job. A base MAP over NL is a design job.**

⚠ **That framing was resolved by measurement on 2026-08-01, and the answer is not the one the two
candidates below assume — see §6e.** Paging the base map is *cheap*; hosting it is what binds. The
distinction matters because it moves the WE problem from the read path to the bucket.

---

#### The steps

Same rules as everywhere else here: one commit, one observable, gates green at each, and a rung stays
revertible by flipping the index rather than regenerating anything.

**N0 · The conservation gate — FIRST, before any country build.**
For a region, count OSM features per category out of the extract and compare against what the block holds:
ways per class, areas per cover, buildings, barriers, labels, lines. Not equality — filters legitimately
drop things — but a **floor per category and a hard fail on zero**.
*Why first:* every defect found by eye this week was **a whole category silently at or near zero** —
`service` roads absent from the draw order, multipolygon relations dropped by the parser, `amenity` never
collected, heath drawn as lawn. All of them reached the live map, and all of them are mechanically
detectable. At Enschede scale a human caught them because a human knows Enschede. **Nobody knows the
Netherlands well enough to catch them by looking**, which is the real reason this step is not optional.
*Observable:* deleting `w/building` from the recipe turns it red; a clean block is green.
*Cost:* one osmium pass per layer, seconds.

**N1 · Re-run it against Enschede.** No coverage change, no new data — the gate is proven on the one block
we can still check by eye and against a known-good result.
*Observable:* green on the shipped block; the counts are printed so the floors are visible, not implicit.

**N2 · Regenerate NL ROADS on today's pipeline.** Both halves, roads only. Still off the site index.
*Observable:* N0 green per half; `cross_block_gate` and `tile_border_gate` still route seam-identically;
`match_parity` byte-identical on the Enschede corpus (the kernel is shared, so this catches a regression in
the matcher, not in the data).
*Rollback:* nothing shipped yet.

**N3 · Put NL roads on Pages and make routing live.** 528 MB is under the ~1 GB cap and it is the **same
origin**, so the CORS wall does not apply — the site index can name them with relative URLs and
`read_mode = "paged"`. Enschede keeps supplying the base map; outside it you get roads and a route on a
plain background, which is a real product for a cyclist.
*Observable:* a cold visitor routes in Amsterdam; the deployed site stays under the cap (**measure it in
the deploy job, do not assume**); the paged gate reports range reads, not whole-file fetches.
*Rollback:* flip the index back to Enschede-only.
⚠ This is the step that makes the tool useful to someone outside Enschede. Everything before it is
preparation and everything after it is the map getting prettier.

**N4 · Decide the base-map read path — a MEASUREMENT, not a build.** ⚠ **ANSWERED 2026-08-01, and the
question was slightly wrong — see §6e.** Both candidates below assume the read path is what stops the base
map shipping. Measured, it is not: a base tile is **9.1 kB**, so a viewport of 8–20 cells is **75–190 kB
whatever the store's total size**. Paging it would be about as cheap as paging the roads already is. What
actually binds is that Pages caps the SITE at ~1 GB and the bytes must live somewhere — which no read path
and no amount of splitting changes. Kept below as written, because the two candidates are still the right
two once hosting is settled:
  * **page the base like the roads** — `store_load_keys` over `PTile[tkey]`, which needs `expose` to work
    on a partially-filled store. That is the open question, and it is a loft question: if it cannot, the
    deliverable is an issue on `loft-lang/loft` with the probe as its reproducer, not a decoder here.
  * **cut the base into small per-city blocks** and load only the covering one — C2's original D11 shape,
    no new loft capability, more blocks to manage and a seam every time you pan across a city edge.
*Observable:* a browser probe that renders one viewport of base map out of a country-sized store, with the
bytes fetched reported. Until that number exists, N5 is not plannable.

**N5 · NL base map, built to whatever N4 answered.** ✅ **The REGENERATION half is done (2026-08-01)**:
185 564 tiles / 17 290 495 features, split at 5.40°E into 999.3 + 1058.3 MB, carrying every category the
old blocks lacked (heath 8620, scrub 58 791, reserve 1315, site 1553, border 309, powerline 3058, pylon
9148, cemetery labels 968). Published to `data-v2026-08-01`. **The HOSTING half is open and is D2** — 2 GB
does not fit beside a site already at 560 MB of 950. Regenerate with today's classification (relations,
sites, aeroway, heath/scrub, cemeteries — none of which the current 1.44 GB blocks have). Host per N4: if
it fits Pages, same origin and done; if not, the CORS bucket, for which `publish-bucket.sh` and
`cors_host_gate.sh` already exist and pass.
*Observable:* the reported map at a dozen sampled coordinates matches OSM by category — the same
conservation check, sampled rather than eyeballed.

**N6 · Turn the refresh loop on, for NL.** ✅ **DONE 2026-08-01, with the cron deliberately still off.**
All three defects below are fixed: the workflow drives `tools/refresh-region.sh` + `tools/publish-release.sh`
rather than its own inline commands, so it publishes from `blocks/`, tags `data-v<date>`, rebuilds the
index and gets per-asset 206 verification. It opens a **PR** for the regenerated index rather than pushing,
since `main` is protected. The cron stays off for three MEASURED reasons — the base map needs ~11.7 GB of
intermediates and does not fit a runner (so the job runs `--no-base`); publishing replaces data a deploy
verifies against, so an unscheduled republish reddens Pages until the index is committed; and loft is built
from `main`, where the fixes this repo needs are routinely fixed-pending-merge. `data-refresh.yml` is deliberately disabled and its publish step
is broken in three ways (uploads `dist/blocks/*` while the script writes `blocks/`; tags `data-202608`
where everything else uses `data-v2026-07-30`; never rebuilds the index nor runs `publish-release.sh`'s
verification). Fix those, run **N0 before publishing**, and re-enable the monthly cron.
*Why here and not later:* §8 already says it — the loop must run while it costs one country, not when it
manages forty blocks. A month-old NL map that is *known* to be a month old beats a fresh one nobody trusts.

---

#### And by extension, Western Europe

The rungs are unchanged (C3 → C4 → C5); what N0–N6 buy is that each becomes mechanical rather than a leap.

| rung | what it adds | the thing it proves for the first time | the wall to watch |
|---|---|---|---|
| **C3 · Benelux + one neighbour** | 2–3 more countries | working-set **eviction** under a 500 km pan, and a cross-BORDER route | peak memory; a border is a seam between datasets, not just blocks |
| **C4 · WE roads** | ~10–16 road blocks, 7–15 GB | a cold visitor routes anywhere in WE | **hosting cost and the index size** — 7–15 GB is past Pages, so C4 is where the bucket decision is forced whether or not N4 forced it |
| **C5 · WE base map** | +25–45 blocks, 44–88 GB | that the map layer is affordable at all | it may simply not be — see below |

**C5 remains a genuine decision point and N4 is what informs it.** If the base map cannot be paged, the
honest end state is C4: routes everywhere, detailed map per region on demand. That is a good product and
this plan should not pretend otherwise. The alternatives named in §6b — coarser cells at low zoom, no
buildings outside urban cells, or sourcing the base map externally and keeping loft on the route — are all
cheaper than 88 GB, and the choice between them is a **measurement** (N4, then S0 on real WE numbers), not
a preference.

**What would make me stop and re-plan rather than continue:** N4 says the base cannot be paged AND
per-city blocks put more than ~100 blocks in one index (the index itself becomes a download); or N3's
deployed site lands within 20% of the Pages cap, because the next country will not fit and the bucket
decision arrives a rung early.

### 6d. The offline Android app — a later track, and it is smaller than it sounds

**Placed after the EU rungs by choice, not by dependency.** Recorded here now because its SIZE is already
measurable, and the number changes how the rest of the plan should be read.

**What it is:** an Android build that preloads a route plus everything within **≥3 km of it**, so a ride
through a valley with no signal still has its map and can still re-route.

**Three of the four pieces already exist**, which is why this is a small track rather than a project:

| piece | state |
|---|---|
| naming the cells within N km of a route | ✅ `corridor_cell_keys(pts, margin, tube)` — margin is **in metres**, so a 3 km pack is `margin = 3000.0`. This is the same call the matcher already makes |
| fetching exactly those cells | ✅ `store_load_keys` over HTTP Range, proven in the browser (C1b/S1) |
| an Android target | ✅ `loft --native-android [out.apk]` — a signed APK; present in the installed binary (needs `ANDROID_NDK_HOME` + `ANDROID_HOME`). **Unverified here** — nothing in this repo has built it |
| writing the pack to local storage and reading it back offline | ❌ the only new part: persist the fetched working set, then `store_load` it from a file instead of a URL |

**And the pack is small.** From §1's measured bytes/km² (roads 12.4 kB, base 73.5 kB) over a corridor of
`2·m·L + π·m²`, at m = 3 km:

| route | corridor | roads | + base | total |
|---|---|---|---|---|
| 25 km | 178 km² | 2.2 MB | 12.8 MB | **15 MB** |
| 50 km | 328 km² | 4.0 MB | 23.6 MB | **28 MB** |
| 100 km | 628 km² | 7.6 MB | 45.1 MB | **53 MB** |
| 200 km | 1228 km² | 14.9 MB | 88.2 MB | **103 MB** |

A day's ride is tens of megabytes. **The offline app is not a scale problem** — it is the working-set
machinery pointed at a file instead of a socket, and the 3 km margin is one argument.

⚠ **The honest consequence of that table:** this track does **not** technically depend on WE coverage, or
on C5, or on the base-map paging question in §6c N4 — a pack is built from whatever blocks exist, and it
only ever touches a corridor. It is scheduled late because that is the wanted order, not because it is
blocked. If the phone-in-a-valley case ever becomes the urgent one, it can be pulled forward to just after
**N3** (NL roads live) and give offline routing over the Netherlands with a base map wherever one exists.

**What it still needs designing, when it comes:** which zoom levels the base pack carries (73.5 kB/km² is
*all* of it — dropping buildings outside urban cells is the obvious lever if 103 MB is too much), pack
expiry against §8's freshness target, and whether a pack is per-route or a pinned region.

### C1b — done, and shipped OFF on purpose (2026-07-30)

The app can read its roads block **by byte range**: `corridor_cell_keys` / `view_cell_keys` name the cells
a command is about to read, `store_load_keys` fetches the ones this session has not asked for yet, and the
working set ACCUMULATES (verified — a second paged load keeps the first entry), so a warm edit inside
loaded area fetches nothing. Route and render are unchanged: `ways=7138 route_pts=213 len=13138.0m`,
pixel hash `917244eb`.

Three things it took that the plan did not predict:

1. **The app's own JS host had to grow the range bridge.** routing drives the wasm from
   `browser/store-kernel.mjs`, not loft's page, so `loft_host_http_range` / `_range_total` are implemented
   there (mirroring `doc/loft-gl-wasm.js`) — an import loft's page provides is not automatically ours.
2. **The gate's server could not serve Range at all.** `python3 -m http.server` ignores it; the gate now
   uses `tools/range_server.py`, or it would have been measuring whole-file responses that the shim
   silently sliced.
3. **Two loft constraints shaped the code.** The working set cannot live in a struct field (the paged
   loaders refuse a field-declared collection, loft#632) and `marks += …` through a `&hash` parameter
   does not compile, so the mark-and-fetch stays inline on the loop's own locals.

**And it ships OFF for this block, which is the honest result.** Measured: a session that pans and matches
across the region fetches **44–80% of the 3.5 MB block anyway, in 25–46 separate requests**, because the
block is only ~56 pages wide. Cheap on localhost; 25–46 round trips over a real RTT. So the read strategy
belongs to the **data**, not the code: `readMode` is a per-block choice that the top index will carry
(§7 R6), `'whole'` today, `'paged'` the moment a viewport is a small fraction of a block — which is C2
onwards. The gate switches it on explicitly so the mechanism cannot rot unexercised.

⚠ **A correction worth keeping.** A first reading blamed paging for a cold-start move (458 → 650 ms).
Re-measured with paging OFF in the same build: still ~650. The cause is the bigger wasm / newer binary,
not round trips — *the number moved, but not for the reason the change made obvious.*

---

### The Netherlands base map, and a published dataset (2026-07-30)

```
osmium layers            areas 3.2 GB · buildings 8.7 GB · pois 303 MB · lines 199 MB · places 2.8 MB
                         streets: the roads export, reused (884 MB)
build_store (streaming)  24m33s, ~5 GB resident → 184,839 tiles · 17,167,067 features · 3.2 GB
                         areas 2,658,318 · buildings 11,560,787 · labels 1,242,645 · lines 520,570 · pois 1,184,747
extent                   lat 50.7182..54.2223  lon 2.6837..7.2957
```

S6's flat-memory claim now has a country behind it: 13.3 GB of input, one chunk resident per layer.

**A GitHub release asset stops at 2 GB, so a 3.2 GB base map cannot ship whole** — which forces the
regions §7 R0 already calls the unit. Both stores are cut at **5.40°E** (`tools/split_base.loft`, the
presentation counterpart of `split_block.loft`), giving `nl-west` and `nl-east`, each roads 264 MB + base
1.44 GB. Cut by CELL, so nothing is clipped and S8's gate covers the seam.

**Published: [`data-v2026-07-30`](https://github.com/jjstwerff/routing/releases/tag/data-v2026-07-30)** —
8 assets, 3.2 GB, each verified to answer a `206` with the exact size uploaded **before** the index that
names them was published (§7 R6's order). And a paged read works against it end to end:

```
store_load_keys: asked=1 loaded=1 bytes_fetched=1179648 file=263942480
RELEASE ok=true entries=1 roads=6488 steps=25883        ← 1.18 MB of a 264 MB asset = 0.45%
```

⚠ **What a GitHub release cannot do, measured rather than assumed:**

| surface | `Range` | CORS with `Origin` | ceiling |
|---|---|---|---|
| release asset | ✅ 206 + `Content-Range` | ❌ **no `Access-Control-Allow-Origin`** | 2 GB/asset |
| `raw.githubusercontent.com` | ✅ | ✅ `*` | git limits (~50–100 MB) |

So the release serves **downloads, the native server and offline use**, and a browser on another origin
cannot read it. That is D2 restated by measurement, not a surprise — the browser path needs a CORS host.
The manifest therefore carries a per-region `url_base`, and **each index names only what it can serve**:
the site index has the block that ships beside the app, the release index has the published regions. A
region in the wrong index would resolve to a URL the consumer cannot fetch, which is a blank map rather
than an error.

---

### Many files stitch themselves — and the one property that makes that true

**`nl-west` and `nl-east` are not two maps.** A route from Amersfoort to Apeldoorn crosses the 5.40°E seam,
draws **30 cells from west and 60 from east**, and produces byte-identical geometry to the unsplit country:

```
#N whole  ways=10935 route_pts=148 fp=555142227
#N split  west_cells=30 east_cells=60 ways=10935 route_pts=148 fp=555142227
```

There is no stitching STEP. Splits are by cell so nothing is clipped; `store_load_keys` accumulates, so one
working set is filled from each covering block in turn; and the index turns a command's box into that
covering set. The mechanism does not care whether there are two files or forty — a corridor names the two
or three blocks it actually crosses.

**What it does care about is disjointness**, and that is the one thing the index cannot check: it stores
extents, and extents legitimately overlap because a feature is keyed by its FIRST VERTEX and never clipped.
Only the cell sets settle it. A cell held by two blocks an index can name together delivers its roads
twice — not a slower match, a different one — and it survived once only because `build_graph` dedups nodes
by coordinate (7,138 ways became 9,438 for an identical route).

`tools/block_overlap_gate.sh` (in `make test-native`) asserts it, **per resolvable set**: a region is
reachable from exactly one index, so blocks in different indexes may overlap — the Enschede block that
ships with the app sits inside the Netherlands regions and shares 84 cells with `nl-east`, which is correct
and harmless. The first version of the gate compared everything to everything and failed on exactly that;
the ambiguity was in the model, not the data, and the rule is now stated precisely.

⚠ **This is the check to run before Western Europe is generated.** Blocks cut from ONE extract on cell
boundaries are disjoint by construction — that is how the NL halves were made. Blocks taken from
**per-country Geofabrik extracts are not**: those deliberately include cross-border data, so `france` and
`belgium` would both hold ways near Lille. WE must be cut, not collected.

---

### D2 — the CORS host, made testable (2026-07-30)

⚠ **CORRECTED 2026-07-30 — the first version of this section was WRONG, and it was load-bearing.** It
said GitHub Pages cannot serve a byte range, and that is the claim that sent the Netherlands blocks to a
release asset. Pages serves ranges correctly. The bad measurement was taken against
`python3 -m http.server`, standing in for Pages, which ignores `Range` and returns the whole file — and
python's behaviour was written down as GitHub's. Re-measured against the live site:

| surface | `Range` | CORS | verdict |
|---|---|---|---|
| **GitHub Pages** | ✅ **206, 16 bytes asked → 16 transferred, correct bytes at 3 offsets** | same-origin for our app; also sends `ACAO: *` | **usable — and it is the app's own origin, so CORS does not arise** |
| jsDelivr `/gh` | ✅ 206 | ✅ `ACAO: *` **and** `expose: *` | usable; per-file limits apply |
| raw.githubusercontent | ✅ 206 | ✅ `ACAO: *`, but **no** `expose-headers` | usable only with a `HEAD`→`Content-Length` fallback for size |
| release asset | ✅ 206 + `Content-Range` | ❌ no ACAO even with `Origin` | downloads, native, offline — not the browser |

So **D2 is not a wall and no bucket is required**. What limits GitHub hosting is SIZE, not capability:
Pages allows ~1 GB per site, and NL roads are 504 MB (fits) while roads+base is 3.2 GB (does not). The
stores are also ~45–55% preallocated zeros — two different regions weighed a byte-identical
1 437 020 160 — so a store persisted at its true size would put NL near 1.5 GB.

The gate below is still exactly right and still the acceptance test for any *other* host; only the claim
about Pages was wrong. `tools/cors_host_gate.sh` (in `make test-map`) serves the app
on one origin and its blocks on another and drives the real app across it:

```
data origin: HTTP 206, ACAO header present: 1
✓ rendered from a DIFFERENT origin: # view: R=3112
✓ matched across it: SUMMARY ways=7138 route_pts=213 len=13138.0m
✓ read BY RANGE across origins: 58 reads, 3.5 MB = 96.2% of the block
```

**Four requirements, each of which the gate catches**, and two were only found by building it:

1. a real `206` with `Content-Range` — Pages fails this;
2. `Access-Control-Allow-Origin` for the app's origin — release assets fail this;
3. ⚠ **an OPTIONS preflight that allows the `Range` REQUEST header.** `Range` is not CORS-safelisted, so
   the browser asks first, and a host answering only GET is indistinguishable from one with no CORS at
   all. My own test host failed exactly here;
4. ⚠ `Content-Range` in `Access-Control-Expose-Headers`, or the reader cannot learn the file's size.

`data/bucket-cors.json` is that policy and `tools/publish-bucket.sh` applies §7 R6's order to a bucket —
upload, verify every object for all four properties, index last. It needs credentials this machine does
not have; everything else is done.

⚠ **An index must not mix reachable and unreachable hosts.** The gate's first version built an index
naming both the local CORS host and the GitHub-hosted NL regions; a match whose padded box escaped the
small block named both, the release-hosted read failed for want of CORS, and **the whole working set went
down with it** — `ways=0`, an empty route, on a host that was working perfectly. One unreachable block in a
covering set does not degrade a match, it ends it. That is why each index names only what it can serve.

*Two of my own assertions were vacuous before this gate worked:* it first passed while the match returned
`ways=0` (the summary was non-empty, so the check said nothing), and the range counters counted requests
rather than deliveries, so blocked reads still reported "38 reads, 2.3 MB". Both are fixed — the counters
count what arrived, and the gate requires a real route.

---

### 6e. Western Europe needs a streaming GENERATOR, not a smaller store (2026-08-01)

C2's wants column has said **"multi-block, hosting, a generator that streams"** since it was written. This
is what that turned out to mean once the NL numbers existed, and it corrects two things the earlier rungs
assumed.

#### The client already streams, and already scales. Do not rebuild it.

| measured | |
|---|---|
| a route on a country block | **17.7 MB of 222.4 MB (8.0%)**, 271 Range reads (`nl_live_gate`) |
| a base-map tile | **9.1 kB** on disk (1058.3 MB / 116 561 tiles) |
| ⇒ one viewport of base map | 8–20 cells ⇒ **75–190 kB, independent of the store's total size** |

That last row is the important one: a viewport costs the same against an 88 GB base map as against a 1 GB
one, because `store_load_keys` fetches cells, not files. **The read path is not what stops WE.**

#### The generator is the wall, and it is arithmetic

`client/basemap/build_store.loft` streams its INPUT (1 MB chunks, so a 4 GB geojsonseq is fine) and then
accumulates the entire store in memory, writing it once with `store_persist_bind`.

    NL base:  17.29 M features  →  ~6 GB RSS   ≈ 350 bytes/feature, linear
    WE base:  390–780 M features (§1's 44–88 GB at ~113 B/feature payload)  →  130–270 GB RSS

Nothing tunes out of that. Two ways past it:

* **make the store writable incrementally** — a real capability, an upstream ask on `loft-lang/loft`, and
  an unknown timeline;
* **never build a store that big.**

The second needs nothing from anyone, and it is not a workaround: **C4/C5 already specify 10–16 roads
blocks and 25–45 base blocks.** The generator never has to stream a continent; it has to do one region at a
time. What was genuinely missing is an ACQUIRE step that produces those regions without reading a 30 GB
continent extract once per region — and osmium already has it (`osmium extract --config`, one pass, many
outputs; verified on osmium 1.16).

    europe-latest.osm.pbf (~30 GB)
            |   ONE `osmium extract --config` pass
            +-- region-01.pbf --+
            +-- region-02.pbf   |   per region, independent -> CI matrix, parallel
            +-- ...             |     build-blocks -> roads + networks
            +-- region-NN.pbf --+     gen-names / build-base
            |
            +-- one index naming all of them -> CORS host (D2), read paged

Every step is bounded by ONE region; nothing ever holds a continent. It is also the same change that makes
the base map buildable in CI at all (N6 runs `--no-base` today purely because one region does not fit).

#### Chunk size falls out of DISK, not RAM

NL needed **~11.7 GB of intermediates** for 17.29 M features (1.8 GB areas + 4.1 GB buildings + 1.0 GB
streets geojsonseq, then a 2.0 GB store) — about 680 bytes/feature. Against a ~10 GB working budget that is
**~15 M features per chunk ⇒ 34–68 chunks for WE**, which lands on C5's independently-derived 25–45. Two
estimates from different directions agreeing is mild evidence both are roughly right.

#### Where the base map's bytes actually are

Measured on `nl-east` (746 MB of payload, `tools/census.loft` + the `.dschema` record sizes):

| | count | coords | payload | share |
|---|---|---|---|---|
| **buildings** | 5 599 287 | 44 495 091 | **400.8 MB** | 53.7% |
| **areas** | 1 545 108 | 34 393 421 | **287.5 MB** | 38.5% |
| labels | 619 320 | 1 504 651 | 24.4 MB | 3.3% |
| lines | 249 389 | 1 511 552 | 15.1 MB | 2.0% |
| pois | 555 995 | — | 8.9 MB | 1.2% |
| tile headers | 116 561 | — | 9.8 MB | 1.3% |

Buildings and areas are **92%**. Buildings are already lean at 7.9 coords each — there are simply 5.6 M of
them; areas at 22.2 coords are the softer target for simplification. But the honest conclusion is that
there is no 5× here: dropping buildings ENTIRELY and halving areas still lands at ~700 MB for two halves,
against ~390 MB of remaining Pages budget. **Shrinking does not reach Pages. Splitting does not either** —
the cap is on total site bytes, so 2 GB in eight parts is still 2 GB. Only a different host does.

#### Ceilings to raise before they bind

* ⚠ **`tools/block_overlap.loft` caps an index at 62 blocks** (one bit per block in its owner mask). Its
  comment claims that is "far above the per-index counts C2 contemplates" — true when written, and no
  longer true at 34–68 chunks. Cheap to fix (count per pair rather than masking); fix it before it is
  load-bearing, not after.
* `MARK_BLOCK = 10000000000` in `web_basemap_kernel.loft` namespaces cell marks as `block * MARK_BLOCK + k`
  — fine to ~9e8 blocks on i64, so not a concern, but it is the other place block count is encoded.

#### The order I would do it in

1. ✅ **Chunked base build — DONE 2026-08-01.** `tools/build-base-chunked.sh` cuts a region into n
   longitude bands and builds each as a whole region (roads then base, since the base map's street labels
   come from the roads export for the same box). `tools/trim_base.loft` makes them disjoint: `osmium
   extract` keeps whole ways, so a feature straddling an edge lands in both neighbouring extracts and is
   binned by its first vertex to the same tile in both — trimming to a half-open cell band leaves it in
   exactly one. **Measured on Enschede: 600 + 519 = 1119 tiles and 138 219 + 72 054 = 210 273 features,
   identical to n=1, no shared cells.** `tools/base_chunk_gate.sh` asserts it and is verified to fail (a
   trim that keeps everything gives exactly 2×).
   Two mistakes worth keeping, both caught by counting: **the margin belongs on INTERIOR seams only** (on
   the outer edges each end chunk extracted past the region and kept the overshoot — 355 554 against
   209 932, a larger map rather than a partition), and **the control must be n=1 through the same script**
   (comparing against the shipped block showed a 341-feature gap that was OSM drift between two build
   dates, not chunking).
   **NL at n=4 (2026-08-01):** 185 559 tiles / 17 290 483 features against 185 564 / 17 290 495 from
   n=1 on the same inputs — 99.99997%, with the four chunks a disjoint partition (185 559 cells, no
   overlap). The shortfall is 5 tiles / 12 features, and its SHAPE is the point: **12 across 3 interior
   seams is 4 per seam**, a boundary constant rather than a data-proportional loss. The gate bounds loss
   per seam and treats any SURPLUS as a hard failure. Mechanism is a labelled hypothesis (a multipolygon
   straddling a seam by more than MARGIN); `osmium extract --strategy=smart` and a larger margin are the
   untried candidates.
   **Wired into CI (2026-08-01):** `data-refresh.yml` now runs `refresh` (roads + names) →
   `base-chunks` (matrix of 4, `CHUNK_ONLY=k`) → `base-assemble` (`merge_base.loft` back into
   nl-west/nl-east, then publish). ⚠ Chunk edges must be a **superset of the REGION edges** or no
   grouping of chunks is a region — `CHUNK_EDGES` exists for exactly that, and the NL edges include 5.40.
   *Still to do:* actually run the workflow once (it has never fired), and settle the per-seam loss.
2. **Raise the 62-block cap** — small, and it is a ceiling on everything above it.
3. **Price D2** — the cost check C5 is already gated on, and the thing that decides whether the WE base map
   is coverage or opt-in. `tools/cors_host_gate.sh` passes today, so the path is tested, not hypothetical.

Leave the streaming-store ask upstream alone unless step 1 proves chunking cannot hold it.

### 6f. FULL NL BASE MAP — the design (2026-08-01)

**The problem, stated as a user sees it:** outside Enschede the map is BLANK. Roads route and search
works, but there is nothing to look at, so you cannot tell "the router picked a farm track" from "the map
is missing". A route on an empty background is not a product.

**Why it was blank:** the NL base map is 2.06 GB. GitHub Pages caps a SITE at ~1 GB and the app already
uses 560 MB, so the base map was published to the release instead — and release assets send no CORS
header, so a browser cannot read them. §6e concluded the fix was D2, a paid CORS bucket.

**Three things measured on 2026-08-01 make that conclusion obsolete.**

| # | measured | why it matters |
|---|---|---|
| 1 | **GitHub Pages sends `access-control-allow-origin: *`** *and* a real `206` — verified against the live site with a cross-origin ranged GET | Pages IS a CORS host. A SECOND Pages site (a data-only repo) can serve blocks to the app, cross-origin, free. D2's premise — that CORS forces a paid bucket — was assumed, never tested |
| 2 | **A country-scale base store PAGES correctly**: `store_load_key` on `nl-east.base.store` fetched **524 288 bytes of 1 109 719 080** and returned a tile identical to the whole-load one (653 areas / 1034 buildings / 563 lines / 41 labels / 252 pois / 17 379 coords) | N4's open question — "can `expose` work on a partially-filled store" — is answered for the READ half. The base map does not need to fit in memory, only the viewport does |
| 3 | **A base tile is 9.1 kB**, so a viewport of 8–20 cells is 75–190 kB | The per-screen cost is the same against 88 GB as against 1 GB |

#### The design

    main Pages site  (~560 MB, unchanged)      data Pages repos (~690 MB each, 3 of them)
      app shell                                  nl-a.base.store
      roads   nl-*.roads.store                   nl-b.base.store
      names   nl.names.store                     nl-c.base.store
      base    enschede.layout.store            served cross-origin, 206 + ACAO, read PAGED

* **NL becomes three regions**, cut so each base block fits a Pages site with margin. `build-base-chunked.sh`
  already produces roads AND base per chunk, and `CHUNK_EDGES` already forces the cuts to land where the
  coverage manifest wants them.
* **Each base block gets its own data repo**, named by `base_url_base` in `data/coverage.toml` — the
  per-store hosting that already exists. The app resolves it to an absolute cross-origin URL.
* **The base map is read PAGED**, like the roads, by the cells the viewport touches.

#### The work, in order, each with its own observable

| | what | observable |
|---|---|---|
| **F1** ✅ | **Page the layout in the kernel.** `web_basemap_kernel.loft` did `store_load_url_trusted(layout, url)` — a WHOLE load. It now gets the roads' treatment: `store_load_keys(layout, url, layout_cell_keys(bbox, LAYOUT_PAD))`, accumulating a working set | a viewport renders from a store read by RANGE — **done**, and the bytes are 50× what this row assumed; see below |
| **F2** ✅ | **Re-`expose` as the working set grows.** `expose` pins the store read-only and is O(collection) per call, so it cannot run per frame — it must run once per LOAD, and the JS side must re-read the handle after each | **done, and the risk is disproven**: 13 viewports with a growing working set, per-viewport cost 211 ms → 176 ms (0.84×), bracket balanced 13/12 |
| **F3** ✅ | **Cut NL into three regions** and rebuild roads + base per region — **and re-bin the base map while doing it**, which turned out to be the load-bearing half | **done**; each base block under 900 MB and every region paged-EXACT. See "F3, and what it cost" below |
| **F4** | **Publish the base blocks to data repos** and name them by `base_url_base` | `cors_host_gate.sh` against the real data repo, not a local server |
| **F5** | **Extend `nl_live_gate`** to assert the map RENDERS in Amsterdam | non-zero areas/buildings/labels from a cross-origin paged base — the check that would have caught "shows nothing" |

#### What F1 measured, and what it changes (2026-08-01)

F1 is built and works — the app draws a base map it never downloaded whole, over real 206 Range requests
(`tools/base_paged_gate.sh` runs the same camera path twice, whole vs paged, and compares what got
DRAWN). But building it required measuring the two things this section had assumed, and **both
assumptions were wrong**. The instrument is `tools/layout_page_probe.loft`; the numbers are from
`blocks/nl-west.base.store`, the block that would actually ship.

**1 · A viewport is not 75–190 kB. It is 10 MB, and at one zoom out, 68 MB.**

| viewport (the app's own padded box) | keys | features | geometry | **fetched** |
|---|---|---|---|---|
| Amsterdam z16 | 84 | 54 974 | 3.4 MB | **10.3 MB** |
| Amsterdam z14 | 779 | 344 195 | 21.8 MB | **68.4 MB** |
| open water / outside the block, z16 | 84 | 0 | 0 | **9.0 MB** |

The row above got 75–190 kB by multiplying the store-wide average tile (9.1 kB) by an unpadded
viewport (8–20 cells). Both factors are wrong in the same direction: **the average tile is rural and the
viewed tile is urban** (a city cell is 5× the mean), and a real viewport at z16 is 84 cells once padded.
This is `CLAUDE.md`'s own rule — *measure the common case, not the outlier* — with the outlier being the
average. The marginal cost is **~104–139 kB per key against ~31 kB of geometry**, and the third row is
the one that names the mechanism: **84 keys that hold nothing still cost 9 MB**, so most of that is the
per-key probe, not the payload.

**2 · No affordable padding is exact.** A layout feature is keyed by its FIRST VERTEX and never clipped,
so it overhangs its cell (PLAN-PERF §7g). A whole load hides this — the render path screens on each
tile's sealed extent — but a paged load cannot consult the extent of a tile it never fetched. Counting
features actually VISIBLE in an Amsterdam z16 viewport:

| pad | 0 | 1 | 2 | … | exact |
|---|---|---|---|---|---|
| tiles fetched | 50 | 84 | 126 | | 864 (z16) · 13 661 (z14) |
| features missed of 25 260 | 79 | 12 | 7 | | 0 |

`LAYOUT_PAD = 1` is the knee — 85% of the misses for 1.7× the tiles — and it is **a compromise, not a
fix**. What is left is a handful of very wide features: a province border, a power line, a railway, a
big water body keyed kilometres from where it is drawn. In a dense viewport that is invisible; in a
rural one it can be all four of the lines on screen.

**3 · Both problems have the same fix, and it belongs to F3's rebuild.** Bound a feature's reach at
GENERATION instead of widening the window at read time:

* **Bin each feature into a tile whose cell CONTAINS it**, with coarser tiers (×8 each) for the ones that
  do not fit the finest. Then *at its own tier a feature spans at most 2 cells*, so a window padded by 1
  cell **per tier** is EXACT — 4 tiers cover NL (500 m → 4 km → 32 km → 256 km), each feature is stored
  once, and the store does not grow. A low zoom then reads only the coarse tiers, which is also the
  answer to 68 MB: today a zoom-out multiplies the key count by 4 while the useful detail shrinks.
* **And reconsider `LAYOUT_CELL` (500 m) itself.** At ~110 kB of per-key cost against ~31 kB of payload,
  the grid is finer than the read path can pay for. A coarser cell cuts the key count 16× for the same
  area *and* shrinks every feature's span in cells, which improves 2 as well.

The alternative — storing each feature in every cell it touches — is measured at **1.5× the store**
(`layout_page_probe … spans` reports `dup_if_binned_everywhere` per kind: areas 211%, lines 404%), so it
is the expensive way to buy what tiering gives for nothing.

⚠ **None of this makes F1 wrong to have built.** The kernel has to page the layout under every one of
these designs, F2's O(collection) re-expose risk is now measured away rather than feared, and the gate
that holds the residual exists. What changed is F3: it was "cut NL into three regions", and it is now
"cut NL into three regions **and re-bin the base map**", with the numbers above as its acceptance test.

⚠ **The layout working set never shrinks**, exactly like the roads one (C1b): a session that pans across
a country accumulates every cell it has visited. Flat per-viewport cost over 13 viewports says nothing
about 500, and eviction is where §6b's Track 3 already puts it (blocks + stitching + LRU). It is a
session-length question, not a correctness one, and it wants measuring before it wants solving.

#### F3, and what it cost (2026-08-01)

**The exactness fix is two rules in the GENERATOR, and it is free.**

> A feature is keyed at the FINEST TIER whose cells its bbox spans at most 2 of, at the cell holding the
> bbox's MINIMUM CORNER.

Tiers step ×8 (500 m → 4 km → 32 km → 256 km) and share one store, the tier riding in the key above
`TIER_STRIDE`. The first rule bounds a feature's reach to one cell *at its own tier*; the second makes
that reach one-directional — a feature occupies its cell and the next one **up**, never the one below —
so a reader pads the low side only. Padding stops being a guess measured in lost features:

| on the shipped Enschede inputs | before | after |
|---|---|---|
| features missed at z16 / z14 | 7 / 5 | **0 / 0** |
| keys asked for a z16 viewport | 111 | **69** (93% of them hit, was 65%) |
| store bytes | 20 776 816 | **20 776 816** |

Conservation was checked rather than assumed at both scales: the same inputs through the old and new
binning give identical feature counts, and the country rebuild lands on **17 290 495 features — exactly
the published total** — in the same bytes, with ~130 extra coarse tiles.

**Cutting into regions puts a seam through ground people look at**, and that decided both the region
count and the cut rule. Measured at a cut, at the app's own default zoom: a straddling viewport holds
25 862 features and one region answered with **13 946 — 54%, half the screen silently blank.**

**So a region carries its neighbours' edges: every internal side is widened by a 0.10° MARGIN**, which is
wider than a padded z14 viewport (±0.0944° of longitude, measured off the app's own projection). One
region therefore answers any viewport at z14 or tighter whole — checked rather than assumed, on a
viewport centred exactly on a cut:

| z14 viewport centred on the 5.40°E cut | visible | drawn | missed |
|---|---|---|---|
| the single region whose band holds it | 61 631 | 61 631 | **0** |
| the whole-country store, same box | 61 631 | 61 631 | 0 |

**FOUR regions, not three, and the count came out of the arithmetic.** `layout_page_probe … lonprofile`
sums coords per 0.1° band — the weight is nothing like uniform, the Randstad carrying far more geometry
per degree than the north-east — and a size model calibrated on three measured cuts (fits within 1%) says
three regions cannot hold a 0.10° margin under the 900 MB cap; the eastern one lands at 957 MB. Four can,
with room:

| | west | midwest | mideast | east |
|---|---|---|---|---|
| base, cuts 4.7 / 5.4 / 5.9 | 555 MB | **794 MB** | 627 MB | 775 MB |
| roads (disjoint, no margin) | 104 MB | 129 MB | 107 MB | 162 MB |

Roads are split from the country block and conserve exactly — 2 785 476 ways and 234 253 barriers — and
they are cut WITHOUT a margin on purpose: the client stitches road blocks (S8) and a duplicated way is
not a slower match but a different one (`block_overlap_gate` enforces it). The base is the opposite case
and gets the margin. The two stores of one region no longer describe the same ground, and that is
deliberate.

⚠ **A REGION and a CHUNK want opposite cuts, and `trim_base` now has both.** A chunk is re-assembled, so
every feature must survive exactly once (`partition`, by tile origin — what `base_chunk_gate` counts). A
region is HOSTED ALONE, so it has to be a complete map of its own ground: `cover` keeps every tile whose
sealed EXTENT reaches the band. With the margin that costs **+27% features / +35% bytes** (2751 MB across
four against 2043 MB for the country), and that is the price of never showing a seam.

**The client keeps a covering SET as the backstop** — `baseUrlsFor`, `roadsUrlsFor` generalised over the
store kind rather than copied. The margin makes it a no-op at z14 and tighter (one block covers, one URL
is named); it is what answers a z13-or-wider viewport, and it is only possible at all because F1 made
the loads PAGED: `store_load_keys` accumulates, where the whole-file load it replaced adopted an image
and a second would have discarded the first.

#### Two defects this rung found, both silent, both now loud

1. **`store_persist_bind` ADOPTS AN EXISTING IMAGE.** Pointed at a file that already exists it keeps the
   old contents, writes none of the new ones, and returns **true**. The three-region cut was produced
   twice with different bands and the second run changed nothing: the tool printed the new feature counts
   and `persist true`, the file had a fresh mtime, and it still held the previous map — caught only by
   reading the extent back out of it. Every tool here that persists now refuses an existing target by
   name (`#PERSIST FAIL`), which is the difference between a wrong answer and an error.
2. **A tiered store's EXTENT no longer identifies a region.** A tier-3 tile is 256 km across, so a
   region's sealed base extent is whatever its widest tile covers: after the four-way cut all four base
   extents read lon 2.39..7.21 — the whole country, four times. Block selection by "smallest block
   containing the box" then picked an arbitrary region, and **Den Haag and Rotterdam rendered as two
   lines and nothing else** while the gate still passed on aggregate. `baseUrlsFor` selects on the ROADS
   extent (untiered, disjoint, genuinely geographic) and reads the base URL off the region it picks.
   ⚠ Anything else that treats a base extent as a geographic bound — `build_index.sh` writes one into the
   index — needs the same reading.

**What F3 did NOT fix, with the number:** a viewport still costs 12–24 MB paged (six real viewports
across the four regions: 99.7 MB, 1611 range requests), and the reason is not the geometry. A keyed read
costs **~100 kB whether or not the key exists** — 84 keys that hold nothing fetched 9 MB — so the bill is
dominated by asking, not by receiving. The min-corner rule cut the asking by 38% and correct region
selection halved the bytes again; that is the last cheap win on this side. The rest is either a coarser
`LAYOUT_CELL` (which trades probe count against over-fetch and has an optimum worth measuring) or a
cheaper absent-key probe in loft's paged loader, for which `layout_page_probe … pageload` is a
ready-made reproducer.

### 6g. PLANNING REGIONS AUTOMATICALLY — the design, and what it cannot fix (2026-08-02)

NL's four regions were cut BY HAND: a 1-D longitude weight profile, cuts read off the thirds, the 900 MB
cap checked afterwards. That does not survive Western Europe, and the reason is specific rather than
general — **a longitude cut cannot make a dense COLUMN smaller.** London, Paris, the Ruhr, Milan and
Berlin are each denser than anything in the Randstad, and any of them can put a strip over the cap on its
own. So the region plan has to be computed from the data, in both axes, before anything is built.

#### The pipeline: download → analyse → plan → build

The analysis pass reads the **geojsonseq exports**, not a built store. They exist immediately after the
osmium step, so nothing is built twice and no region is ever discovered oversized after the fact:

    acquire(PBF) → osmium per layer → COUNT COORDS PER CELL → plan regions → build only the plan

**Coords are the weight, because bytes are near-linear in them.** Calibrated on three measured regions,
`MB = 12.972/Mcoord + 40` predicts within 1% — the slope is a `Coord` (two i32) and the intercept is the
store's own fixed overhead. A pass that counts coordinates per 0.05° cell is a streaming line-scan of
files the pipeline already produces.

**The planner is a kd-split**: while any region's predicted size (INCLUDING its margin ring) exceeds the
cap, split the worst one along its longer axis at the WEIGHTED median. Prototyped against the real NL
grid it reproduces the hand cut and improves on it — 4 regions, max 727 MB against 794, duplication +33%
against +35% — and it splits the eastern half by LATITUDE, which the longitude-only cut could not do.

**Resolution is not the binding constraint, and that is the reassuring measurement.** At 0.05° NL's
densest cell holds 0.64 Mcoords ≈ **8.4 MB of geometry — 107× under the cap**. A metro would have to be
two orders of magnitude denser per km² than the worst cell in the Randstad before the grid could not
subdivide. Region sizing is therefore safely automatable; report the densest cell so the headroom stays
visible rather than assumed.

#### The two things the planner cannot fix

1. **The margin gets expensive exactly where regions get small.** The 0.10° margin is a RING, so
   duplication is `((S + 2m)/S)² − 1`: **+44% at 1.0° across, +96% at 0.5°, +178% at 0.3°.** Dense metros
   need small regions, which is where the ring costs most. So the margin must be per-region and
   cost-capped, falling back to the client's covering set (`baseUrlsFor`, already built and gated) where
   it is not worth paying. The planner should emit the margin it chose and the duplication it bought.
2. **⚠ PER-VIEWPORT COST IN A DENSE METRO, WHICH NO REGION PLAN TOUCHES.** An Amsterdam z14 viewport is
   already 21.8 MB of geometry; London or Paris will be several times that, and cutting regions
   differently changes it by exactly nothing — it is density per SCREEN, not per region. This is what
   would make those cities "suddenly problematic" for a user, and the only answer is generalisation: a
   zoom pyramid that drops buildings and simplifies areas at low zoom (§6f's back-pocket overview tier
   measured 75/94 MB for NL — **§6i is that design, measured**). **Measure a real Île-de-France or Greater London extract before committing
   to WE** — one download answers whether the viewport cost is 3× NL's or 10×, and that number decides
   whether generalisation is the next rung or the one after.

*Do not build the planner and conclude WE is solved.* It removes one failure mode — a region that cannot
be hosted — and leaves the one a user actually feels.

### 6h. DO THE NL PATTERNS REACH WESTERN EUROPE? Measured verdict: three of them do not (2026-08-02)

The scale factor is not a guess. Geofabrik's own extracts for the thirteen countries of Western Europe
(FR, DE, GB, IT, ES, NL, BE, AT, CH, DK, PT, IE, LU) total **20.5 GB of source PBF against the
Netherlands' 1.40 GB — 14.7×.** Projecting this session's *measured* NL blocks linearly in source bytes:

| | NL measured | WE projected |
|---|---|---|
| base map | 2043 MB | **30.0 GB** (40.5 GB with the 0.10° margin) |
| roads | 238 MB | **3.5 GB** |
| names | 36 MB | 0.5 GB |
| regions at ~700 MB of base | 4 | **~58** |

**What still holds** — and it is most of the design. Paged reads (a viewport costs the same against a
1 GB store as a 20 MB one, proven), the tier rules (exactness is a property of the data, not of scale),
the covering set, the marks, the index-as-contract, and chunked generation. None of these care how big
the continent is.

**Three that break, in the order they will bite:**

1. **⚠ THE ROADS STOP FITTING THE SITE — 3.5 GB against a 0.95 GB Pages site, 3.7× over.** Today's split
   is "roads same-origin beside the app, base map elsewhere" (HANDOFF §0 rule 2), and at WE the roads are
   themselves too big for the app's own site. The mechanism to fix it already exists and is gated
   (`cors_host_gate.sh`: paged + CORS, cross-origin), but the RULE changes — every store moves off-origin
   and the site keeps only the app.
2. **⚠ ONE PAGES REPO PER REGION DOES NOT SCALE TO ~58 REPOS.** Four was a judgement call; fifty-eight
   public repositories, each with its own workflow and deploy, is not an operational shape. This is where
   **D2 stops being optional**: one R2 bucket holds 40.5 GB for roughly **$0.61/month** at $0.015/GB with
   no egress fee, against 58 repos that are free and unmanageable. `publish-bucket.sh` already exists and
   `data/bucket-cors.json` is the policy; what is missing is the account, not the code.
3. **⚠ THE 62-BLOCK CEILING BINDS.** `block_overlap.loft` masks cell owners one bit per block and refuses
   an index over 62 (`tools/block_overlap.loft:53`). At ~58 road blocks WE lands *inside the margin of
   error of the cap* — one finer cut, one city block, and it fails. §6e already listed this as open item
   (c); it is no longer theoretical. Fix: count per PAIR rather than one bit per block.

**Two more that are not new but get worse:**

* **The working set never shrinks** — there is no LRU anywhere in the kernel (grep: zero matches). A
  session panning from Paris to Berlin accumulates every cell it crossed, in wasm memory. Tolerable
  across NL; not across a continent. §6b Track 3 owns it.
* **The margin costs more as regions get smaller** (§6g): +35% measured across NL's four ~1°-wide
  regions, and worse for the smaller regions dense areas force. Per-region, cost-capped margins are the
  answer, with the covering set as the fallback.

**And the one the user feels, unchanged by any of this:** per-viewport bytes in a dense metro. An
Amsterdam z14 viewport is 21.8 MB of geometry; London and Paris are denser still, and no region plan,
bucket or block cap touches it. Generalisation is the only lever.

*Verdict: the read path scales as designed; the PUBLISHING and BOOKKEEPING do not.* The three breakages
are each small, known fixes — a bucket instead of repos, a wider overlap mask, and off-origin roads — but
they are prerequisites, not follow-ups, and none of them is the thing that decides whether the map feels
good in London.

⚠ **F5 is the lesson from shipping this blank.** `nl_live_gate` proved routing and search on the live site
and never asked whether anything was DRAWN, so a blank map passed every gate. Every future coverage claim
needs a render assertion, not just a route one.

#### What is still unknown, and the honest risks

* **F2 is the real engineering risk.** `expose`'s cost is O(collection), and a growing working set means
  re-exposing a growing store. If that turns out to be per-frame-expensive, the fallback is JS reading
  pages directly (§9 item 3's stated fallback) — not a decoder of our own (§0's rule).
* **Pages acceptable use.** GitHub documents Pages as not intended as a CDN, with soft limits of ~1 GB per
  site and 100 GB/month bandwidth. Paged reads make a visitor cost ~100 kB per viewport, so the bandwidth
  is unremarkable — but three data repos holding 2 GB of map tiles is a judgement call, and it should be a
  deliberate one. **D2 (R2/B2) remains the answer that scales**: at WE's 44–88 GB this stops being a
  judgement call and becomes a bucket, for roughly $0.66–1.32/month of storage with no egress fee on R2.
* **Three repos is an NL answer, not a WE one.** 44–88 GB would be 45–90 Pages repos. Do not build
  tooling that assumes this shape; F4 should be "publish to a base URL", with the URL a config value.

#### Why not the alternatives

* **Shrink it** — buildings (53.7%) + areas (38.5%) are 92% of the bytes, and buildings are already lean
  at 7.9 coords each. Dropping buildings ENTIRELY and halving areas still lands at ~700 MB against ~390 MB
  of free budget. There is no 5x, and it costs the detail that makes the map worth having.
* **Split it further onto the SAME site** — the cap is on total site bytes. 2 GB in eight parts is 2 GB.
* **An overview tier only** (no buildings, no pois, big areas simplified, place labels) measures at
  **75 MB west / 94 MB east** and WOULD fit the current budget. Worth keeping in the back pocket as a
  never-blank fallback, but it is not "full support" — it is a different, thinner map.
  ⚠ **§6i explains that number and shows it is a plateau, not a floor.** 75/94 MB is what SELECTION alone
  buys: keeping only what a low zoom draws keeps 4% of the features and **45% of the coordinates**, because
  the features it keeps are the huge ones. Adding 1-pixel decimation takes the same window to 1.2% of
  coordinates at z≤10. The overview is not a thinner map you settle for — it is the top of a ladder.

### 6i. THE OVERVIEW LADDER — what it takes to open the app on the Netherlands (2026-08-02)

The app opens on Enschede at z16 because that is the only camera it can afford. Everything below is the
design for opening it on the *country*, and the reason it is a design rather than a setting: **the read
path has no zoom.** `viewCmd` sends base/roads/cmd/**bbox**/mode, and `layout_cell_keys` enumerates all
four tiers over that box unconditionally, so a view costs what its GROUND AREA costs and nothing tells it
that a building is invisible at z10. Measured on the deployed site (headless 1000×700, cold, cache off,
`CPU_THROTTLE=4`, medians of 3 at 1.05× spread):

| camera | block | first view | bytes | features drawn |
|---|---|---|---|---|
| Enschede z16 — today's default | `enschede`, whole | **1.64 s** | 10.7 MB | 26 630 |
| Amsterdam z16 | `nl-midwest`, paged, 297 reads | **6.31 s** | 18.4 MB | 22 479 |
| Amsterdam z15 | 761 reads | 11.9 s | 47.4 MB | 78 751 |
| Amsterdam z14 | 1675 reads | 26.9 s | 104.6 MB | 252 373 |

A whole-NL screen (z≈8.6, padded 0.6) enumerates **~1.1 M layout keys + 70 k road keys**. There is no
setting that survives that.

#### ⚠ THE UNIT OF COST IS THE KEY, NOT THE FEATURE — and it inverts the design

This is the measurement everything else follows from, and it is the opposite of the intuition that a
zoomed-out map is expensive because it holds more stuff. Two same-sized windows on `nl-midwest`, both read
the way the app reads (`tools/base_key_probe.loft`):

| window | keys | tiles | features | bytes |
|---|---|---|---|---|
| Amsterdam centre | 69 | 67 | 39 646 | 14.2 MB |
| IJsselmeer (open water) | 69 | 68 | **6 107** | **17.7 MB** |

**6.5× fewer features for MORE bytes.** Every key costs ~3 × 64 kB pages, and asking for more keys does not
amortise it: 4 keys → 12 pages, 69 keys → 216, 163 keys → 787. A z16 window pays 14.2 MB for ~4 MB of
content. So the bill is **asking**, not receiving — a directory descent per key, paid whether the key
exists or not.

Two consequences, both load-bearing below:
* **Below the zoom where detail is drawn, a whole-file read of a generalised block beats a keyed read of
  the detailed one.** A 25 MB overview downloaded once is cheaper than 128 keys.
* **A pyramid cannot have many levels.** Every level costs ≥4 keys per view even when it holds nothing —
  ~800 kB. A level-per-zoom ladder is a 16 MB floor on every view; ~4 levels is the ceiling.

#### Three designs this killed. Do not re-open them without new evidence

1. **⛔ "Make the reader zoom-aware over the existing tiers"** — no data change, just skip the fine tiers
   when zoomed out. **Falsified**: of the features a z12 Amsterdam viewport should draw, **73% sit in
   tier 0** (1452 of 1997 — every place label, canal and railway). The tier is a SIZE bin; a city name is a
   point and sits at the finest tier. Skipping fine tiers gives polygons with no cities.
   `tools/zoom_bin_probe.loft` is the cross-tab.
2. **⛔ A level-per-zoom pyramid** — killed by the per-key floor above.
3. **⛔ "Selection is the shrink"** — see below; it is the *plateau*, not the lever.

#### Selection is not the lever. DECIMATION is — and that reconciles §6h's 75/94 MB

§6h measured an overview tier (no buildings, no POIs, big areas simplified, place labels) at **75 MB west /
94 MB east** and shelved it as "a different, thinner map". That number is right and it is exactly what
SELECTION ALONE buys, because the features a low zoom keeps are the *huge* ones: on the Amsterdam window
(39 646 features, 532 160 coords), keeping only debut ≤ z12 keeps **4% of the features and 45% of the
coordinates**. One coastline is one feature and forty thousand vertices.

Adding the second rule — drop every vertex nearer than **one pixel at the level's own zoom** to the chord
it sits on (Douglas–Peucker) — is what actually shrinks it. Measured, same window
(`tools/overview_size_probe.loft`):

| level | features kept | coords kept | after 1-px decimation | of ALL coords |
|---|---|---|---|---|
| z ≤ 8 | 319 (0.8%) | 215 880 (40%) | **2 333** | 0.44% |
| z ≤ 10 | 319 (0.8%) | 215 880 (40%) | **6 504** | 1.2% |
| z ≤ 11 | 493 (1.2%) | 224 601 (42%) | **12 387** | 2.3% |
| z ≤ 12 | 1 826 (4.6%) | 239 886 (45%) | **24 069** | 4.5% |
| z ≤ 13 | 7 304 (18%) | 265 183 (49%) | **43 163** | 8.1% |

Read the columns, not the rows: **selection is flat in coordinates (40–49% at every level) and decimation
is ~2× per zoom level.** The handover zoom is therefore the *only* size knob, and it costs a factor of two
per level.

#### ✅ O0 ANSWERED — the country measured in one pass, and the handover is z10 (2026-08-02)

The window numbers above are a dense city and cannot be scaled to a country, so O0 walks
`blocks/netherlands.tiered.base.store` once: **80 s, 4.0 GB RSS, 186 211 tiles**, and it sees
**17 290 495 features / 159 329 825 coords** — the feature count is exactly the published country total,
which is the conservation check that says the walk is complete.

| overview | selected features | selected coords | after 1-px decimation | of which areas | **all-in MB** |
|---|---|---|---|---|---|
| **z ≤ 8** | 117 188 (0.68%) | 10 716 825 (6.7%) | **398 385** | 397 178 | **~8 MB** |
| **z ≤ 10** | 117 463 (0.68%) | 10 717 100 (6.7%) | **735 407** | 733 087 | **~11 MB** |
| z ≤ 11 | 714 921 (4.1%) | 30 486 234 (19%) | 4 073 287 | 4 057 679 | ~63 MB |
| z ≤ 12 | 1 348 741 (7.8%) | 43 864 873 (28%) | 8 188 439 | 8 037 459 | ~120 MB |

*All-in* uses this store's own measured rate rather than a guess: 2043 MB / 159.3 Mcoord = **12.8 B per
coordinate**, which at 9.2 coords per feature decomposes into 8 B of geometry + **44 B per feature** of
record, text and index. (§6g's `12.972·Mcoord + 40` fit is not usable here — its +40 MB intercept was
calibrated on 555–775 MB regions and is meaningless at this size.)

**The cliff is at z11, and it is one threshold in one function.** `areaMinZoom` debuts an area at z0 when
its diagonal exceeds 0.008° and at z11 when it exceeds 0.003° — so z11 admits ~600 000 medium polygons at
once: features **117 463 → 714 921 (6.1×)** and decimated coordinates **735 407 → 4 073 287 (5.5×)**. One
zoom level costs 5.7× the file.

**So the handover is z10** — the top of the "big areas only" band, ~11 MB of base, and the last level
before that cliff. z11 at ~63 MB is possible but is a poor first paint; z12 at ~120 MB is not a whole
download.

⚠ **The overview is AREAS, by 99.7%** — 733 087 of 735 407 decimated coordinates at z≤10, against 2 009
for lines and 311 for labels (36 city labels at z≤8, 311 cities+towns at z≤10). Whatever else the design
does, it is a landcover-and-water file with a road spine bolted on.

**And the road spine has to come from the ROADS store** (`tools/spine_size_probe.loft`, whole country):

| class | ways | vertices | km | DP per way @z10 | merged bound @z8 |
|---|---|---|---|---|---|
| motorway | 27 595 | 153 913 | 6 994 | 56 071 | 18 577 |
| trunk + primary | 63 848 | 352 778 | 9 126 | 128 512 | 24 240 |
| secondary | 75 886 | 454 814 | 8 866 | 152 603 | 23 548 |
| tertiary + unclassified | 316 713 | 2 334 221 | 66 436 | 648 629 | 176 458 |

⚠ **Decimation alone buys NOTHING on roads: `DP per way` is exactly 2 × ways** (56 071 for 27 595
motorway ways), because Douglas–Peucker can never drop a way's two endpoints and OSM fragments a motorway
into ~130 m pieces. **Merging consecutive same-class ways into runs is not an optimisation here, it is the
entire road-spine budget** — at z8 it is bounded 3.0× better on motorway and 6.4× on secondary. The
z≤10 spine (motorway + trunk/primary) is **184 583 vertices unmerged ≈ 3 MB**, less once merged.

**⇒ An NL overview at z≤10 is ~11 MB of base + ~3 MB of spine ≈ 14 MB**, against 385 MB of free site
budget. It ships beside the app.

⚠ **The window projection held where it mattered and failed where it did not.** It predicted z≤10 ≲25 MB
(measured ~11) but z≤12 ≲92 MB (measured ~120). A dense-city window over-states the SELECTED share
(45% of coords against the country's 28%) and under-states the DECIMATED share (4.5% against 5.1%) — two
errors in opposite directions, which is why a window is not a scale model of a country and why O0 was a
rung rather than a footnote.

#### ✅ O1 BUILT — `blocks/nl-overview.base.store`, 19.6 MB, 11 seconds (2026-08-02)

`tools/build_overview.loft` reads the country base store and the country roads store and writes an
**ordinary base store holding less** — the same `PTile`, the same tier keying, the same sealed extents, so
every existing reader already understands it. Measured, on 17 290 495 features in:

| | |
|---|---|
| kept | **116 703 areas · 449 lines · 311 labels · 0 buildings · 0 pois** |
| base coordinates | 10 717 100 selected → **735 500 decimated** (94.1 m = 1 px at z10) |
| spine | 91 443 ways → **14 631 chains** → 38 931 coordinates |
| output | **90 tiles · 132 094 features · 774 431 coords · 20 570 304 bytes (19.6 MB)** |
| checks | `persist true load true verify true`; base coords land within 93 of O0's independent 735 407 |

Verified geographically, not just structurally: a keyed read over the Amsterdam window returns 7 tiles /
17 667 features and one over the country returns all 90 — so re-keying moved features between tiles
without moving them on the ground. (That country read asks **454 867 keys**, which is the same point §6i
opens with: this block is read WHOLE, never paged.)

**Two things cost real bytes, and neither was in the design:**

1. **⚠ An overview must be RE-KEYED, or it inherits a grid built for a hundred times its density.** Keeping
   each feature in its source tile is the obvious implementation and it produced **26 848 tiles holding 4.9
   features each** — against 93 in the full store. A tile's fixed cost (five vector headers, origin, sealed
   extent, store bookkeeping) is then paid 26 848 times: **25.5 MB → 19.6 MB** simply by flooring the
   output at tier 2 (0.32° cells, 90 tiles). Coarser is always safe for the reader's one-cell window, so
   the floor only ever moves a feature UP the ladder.
2. **⚠ The merge had a silent half-failure.** Endpoint slots were *preferred* in order rather than
   *tested*, so when the run we arrived on sat in the second slot the continuation was refused — exactly
   half the time. It chained 1508 city ways into 814 pieces (1.85 each) and looked like it worked.
   Fixed, and the same block chains into **223** (6.8 each). Nationally: 91 443 ways → 14 631 chains,
   **184 583 unmerged coordinates → 38 931 (4.7×)**. Merging really is the spine's whole budget.

⚠ **19.6 MB against a 14 MB projection, and the model was wrong in a knowable way.** §6i predicted 8 B per
coordinate + 44 B per feature. Geometry did land at 5.9 MB (8 B/coord exactly), but the remaining 13.7 MB
is **109 B per feature**, not 44 — because 44 B/feature was derived from a store averaging 9.2 coords per
feature, and an overview averages 5.9, so each feature's own ring is a separate small allocation with its
own header. **Per-feature cost does not scale down with the geometry**, which says the next lever on size
is FEATURE COUNT, not vertices — and 116 703 of the 132 094 are areas, because `areaMinZoom` sends
*everything* over 0.008° of diagonal to z0, putting a 900 m field on the same footing as the IJsselmeer.
A finer ladder above that threshold is the obvious follow-up and it is a renderer rule, not a store one.

#### ✅ O1b WIRED — a bare visit opens on the Netherlands in 0.6 s (2026-08-02)

`DEFAULT_CAM` is `z8 52.15,5.30` and the app resolves it to the overview alone. Measured on a bare URL
against the local site:

| | bare visit (z8) | z16 Amsterdam — the regression check |
|---|---|---|
| requests | **1 · `nl-overview.base.store` · 19.62 MB** | `nl-midwest`, 82 range reads, 4.97 MB |
| drawn | **116 703 areas · 15 080 lines · 311 places** | roads `R=4866`, base paged |
| detailed roads read | **`R=0`** | unchanged from before this work |
| wall | **0.6 s** | 18.6 s (unchanged) |

**Four things had to change, and one of them was the kernel:**

1. **A zoom band per block, in the index** (`zoom_min` / `zoom_max` → `"zoom":[lo,hi)`), filtered in JS by
   `blocksForBox`. A block that declares none serves every zoom, so an older index behaves as it did.
2. **Selection falls back to the BASE extent when a block has no roads store.** The overview is a picture
   and never a routing input, so `selBox` picks roads-when-present and the asked-for store otherwise —
   which also keeps §6f's rule (a tiered base extent is meaningless) intact for the regions that do have
   roads.
3. **⚠ The VIEW's roads are zoom-banded; a MATCH's are not.** `roadsForSketch` deliberately passes no
   zoom, because a route must always be matched against detailed geometry whatever the camera shows.
4. **⚠ The kernel needed a branch: an empty roads URL is a supported state**, symmetric with the empty
   layout URL it already had. Below the handover there is no roads store at all — the spine lives in the
   overview as Lines.

**Two defects this found, both mine, both measured rather than reasoned:**

* **The chooser's fallback re-admitted the block the band had just excluded.** `roadsUrlsFor` was passed
  `coverage.block` as its fallback, and `chooseBlocks` applies the fallback when the candidate set comes
  out empty — which is precisely what a band exclusion produces. At z8 it downloaded a **123 MB roads
  store whole**. The fallback belongs at the call site, where the band can be consulted.
* **Before the kernel branch, a z8 view asked the detailed roads for the whole country: 75 256 range
  requests, 4.7 GB into one block, and the view never returned.** The overview loaded correctly the whole
  time — the base half was right and the roads half was catastrophic, which is exactly the shape §6i
  warned about when it said the zoom band is load-bearing rather than cosmetic.

⚠ **Seven headless drivers navigated to a bare URL and inherited `DEFAULT_CAM`.** Moving the default
silently re-baselines every one of them onto a generalised national map. They each pin `GATE_CAM` now.
Green after the change: `map_render_gate`, `base_paged_gate`, `cross_block_browser_gate`, `cors_host_gate`,
`index_fresh_gate`, `browser/map.test.mjs`.

⚠ **NOT DEPLOYABLE UNTIL THE BLOCK IS PUBLISHED.** The committed index now names
`stores/nl-overview.base.store`, and `fetch-site-blocks.sh` verifies every relatively-named block against
the release — by design it fails loudly rather than shipping a map with a hole. So the release needs the
block before this reaches `main`.

⚠ **AND THE GAP IS REAL AND NOW REACHABLE.** The handover is z11: below it the overview answers, above it
the detailed regions do — and §6i's own arithmetic says the detailed path costs ~10 500 keys at z12 and
~40 700 at z11. **A visitor who opens on the country and zooms in walks into that.** It is not a
regression (it is what every zoom below z14 already cost) but the default camera now leads there, which
makes **O3 — the middle levels on their own coarse grids — the next rung rather than a later one.**

#### ✅ O3 — THE GAP IS CLOSED, and the fix is not the one the design proposed (2026-08-02)

O1b left z11–z13 unaffordable and promoted this to the next rung. The handover is **z14** now, and every
zoom below it is answered by the overview alone. Measured, cold, against the local site:

| camera | requests | drawn | wall |
|---|---|---|---|
| z11 | 1 · overview · 19.62 MB | 16 687 areas · 2 441 lines · 53 places | **0.5 s** |
| z12 | *(same file)* | 5 355 areas · 1 135 lines · 21 places | **0.5 s** |
| z13 | *(same file)* | 1 411 areas · 495 lines · 3 places | **0.5 s** |
| z14 | `nl-midwest`, 296 range reads, 18.5 MB | the detailed path, unchanged | 19.5 s |

Against **2 GB at z12 and 8 GB at z11** before. One line of manifest, no new data.

**§6i's own design for this rung was wrong, and the arithmetic says so.** The plan proposed "middle levels
on their own coarse grids", and the natural cheap version of that is to keep reading the DETAILED store
but floor the tier the reader starts at. It costs little — z13 floors to 76 keys (~15 MB), z12 to 216 —
but it buys nothing, because **the tier ladder is a SIZE bin and not a visibility bin.** The coarse tiers
of an Amsterdam window hold 611 of its 39 646 features and not one place label or motorway. That is §6i's
already-falsified R1, re-derived from the other end: the features a low zoom needs are selected by DEBUT,
which is exactly what the overview is and what a tier can never be.

⚠ **And the detailed ROADS cannot be read in the gap at any grid** — one cell size (0.02°), so a padded
z13 viewport names 231 keys and a z12 one 760, which is 46–152 MB before a single area is drawn. The
overview's merged spine is what stands in for them, which is why it had to carry roads at all.

**What is closed and what is not.** The PERFORMANCE gap is gone — the whole range z2–z13 is one 19.6 MB
file, downloaded once and reused. A DETAIL gap remains: at z13 the map is z≤10 content (motorways, big
areas, city labels) decimated at 94 m, which is ~8 px of error at that zoom. It is coarse, and it is
instant, and it degrades in one direction only.

⚠ **Closing the DETAIL gap is blocked on the per-key cost, and that is the real finding.** A mid level at
z≤12 read paged is the right shape, and every grid for it lands in the same place because ~200 kB per key
dominates whatever the cell size: **0.04° → 216 keys ≈ 54 MB · 0.08° → 66 keys ≈ 26 MB · 0.16° → 28 keys
≈ 24 MB · 0.32° → 16 keys ≈ 37 MB** for one z12 viewport (probe cost plus over-fetch against ~10 MB of
content). There is no cell size that makes it cheap. **O5 — loft's 3-pages-per-key with no batch
amortisation — is therefore a PREREQUISITE for the detail half, not an optimisation beside it.** Fix that
and every row above divides by ~3.

#### ✅ O2 — SKETCH DENSIFICATION, as a fallback rather than a preprocess (2026-08-02)

The country view makes a 100-pixel drag ~40 km, and a matcher fed two distant points returns the sketch
**echoed** — `match_route` hands back its input trace when it cannot bridge. Bracketed on one Amsterdam
corridor, three points each time, spacing the only variable:

| spacing | 1 km | 2 km | **3 km** | 4 km |
|---|---|---|---|---|
| result | 46 route pts | 104 route pts | **none** | **none** |

`densifySketch` splits any leg longer than **1 km** into collinear pieces — the working end of the range
with margin. Through the app's own path (`rough.commitEdit` → `requestMatch`):

| sketch | before | after |
|---|---|---|
| 3 points at 3 km spacing | **no route** | **134 route pts**, 7 333 m, 5.0 s |
| a country drag: 2 points, ~35 km | **no route** | **791 route pts**, 47 327 m, 45.6 s |

**⚠ IT FIRES ONLY ON THE ECHO, AND THAT IS THE WHOLE DESIGN.** Densifying every sketch would change the
route for every sketch whose points are more than a kilometre apart — including ones that already match
perfectly (the Enschede corpus spans 3.5–4.8 km between points and returns 199 points), and a
route-affecting change is gated on the 26-sketch corpus at 0 worse accepted. Retrying only when the
matcher handed the trace straight back leaves **every working match byte-identical** and costs one retry
on the case that returned nothing at all. `densifySketch` even returns the ORIGINAL array when no leg
needed splitting, so "an ordinary sketch is untouched" is structural rather than promised.

The two pure functions (`densifySketch`, `isSketchEcho`) are exported from `map.mjs` and carry **12
DOM-free checks** in `browser/map.test.mjs` — collinearity, endpoint identity, the untouched-array case,
a zero step, and the echo test at loft's 6 printed decimals.

⚠ **The 45.6 s is honest and it is not the densifier's.** That sketch escalates to the fat-bbox corridor
(162 834 ways) and then pays an anchor search per point on 36 points — PLAN-PERF §7 measures anchoring at
~75% of a cold match on a dense sketch. It is a long walking route on a country-scale drag, and it now
returns one instead of nothing.

⚠ **TOOLCHAIN: the installed loft changed MID-SESSION and the version string moved with it** —
`/usr/local/bin/loft` was reinstalled 2026-08-02 19:59, **2026.7.2 → 2026.8.0**, md5 `13311104…`,
byte-identical to `../loft`'s build. The overview block, the kernel wasm and the first gate runs of §6i
were all made on 7.2. Re-verified on 8.0: the block still loads and reads (7 tiles / 17 667 features at
the Amsterdam window), `index_fresh_gate` still regenerates byte-identically, the wasm was rebuilt (same
sources hash, **1 408 411 → 1 404 720 bytes** — the documented toolchain drift the sidecar deliberately
does not hash), and `map_render_gate`, `cross_block_browser_gate`, `cors_host_gate` and
`browser/map.test.mjs` are green on it.

#### The design: a ladder of LEVELS, not a bigger tier ladder

**Invariant.** *A feature is stored once per level at which it is drawn — selected by the renderer's own
debut zoom, decimated to one pixel at that level, on a grid whose cell scales with the level — so a view
at any zoom reads a constant number of cells holding only what that zoom can show.*

Three rules, each already computable from what exists:
* **Selection** is the renderer's `minZoom` tables — `areaMinZoom` (an area's own diagonal),
  `BUILDINGS_MINZOOM`, `LINE_STYLES`, `RANK_MINZOOM`, `POI_STYLES`. Nothing is invented; the probes above
  port them verbatim. ⚠ Today `areaMinZoom` is recomputed **in JS, per area, per view** — storing the
  debut removes that too.
* **Decimation** is Douglas–Peucker at 1 px of the level's zoom. The road spine must be **MERGED first**:
  the country holds 27 595 motorway *ways* for ~3 500 km of motorway (≈130 m per way, OSM fragmentation),
  and keeping way identity costs ≥2 vertices each before any simplification.
* **The level's own cell size** is what keeps key count constant. Today's tiers ×8 are already levels
  z16/z13/z10/z7; the fix is that a view at zoom z asks the levels ≤ z on THEIR grids, not all four on all
  of theirs.

The top level(s) are small enough to ship **whole** — read once, same-origin, cached — which is where the
key-cost measurement pays off. Only the lower levels stay keyed.

**Contents of the top level** (what a country map is): area colour, borders, rivers, canals/railways/
runways, places by rank, and the road spine — motorway 27 595 · trunk+primary 63 848 · secondary 75 886
ways (`tools/census.loft` over `blocks/netherlands.roads.store`, 2 785 476 ways / 17 298 515 vertices
total). ⚠ **The spine has to be lifted out of the ROADS store**, which the base map's `Line` kinds do not
cover today (waterway/railway/barrier/aeroway/boundary/power only).

#### Is the zoom seamless? By construction yes — but there is a GAP in the middle

**The handover cannot be seen, and that is a property of the decimation rule rather than a blend.** A level
decimated at 1 px of its own zoom differs from the detailed geometry by **less than one pixel at every zoom
it serves**, so switching sources at the top of its band moves nothing the eye can resolve. Seamlessness is
bought at generation time, not by cross-fading.

Three things still have to be arranged, and they are cheap:
* **Always loaded, never swapped.** The overview is the app's base layer, drawn *under* the detailed
  blocks, not exchanged with them. That removes handover flicker, removes pop-in while a keyed read is in
  flight, and gives a background everywhere the detailed blocks do not reach.
* **One source per kind per frame**, or a motorway drawn from both levels smears. The rule is the level
  band, so it is the same decision as selection.
* **Hysteresis at the boundary**, because the camera zooms fractionally (~0.5 per wheel notch). Switch up
  and down at different zooms or the boundary thrashes.

⚠ **AND THE HONEST PROBLEM: the two paths do not meet.** The overview is affordable up to ~z11 (≲47 MB
whole); the detailed regions are affordable from ~z15 (18.4 MB). Between them **neither is** — z13 is
~230 MB keyed, and a z≤13 overview is ≲165 MB. So a single overview file does not make zooming continuous;
it makes the *ends* work. The middle band is what the per-level grid is for: a z12 level on 0.08° cells is
~16 keys ≈ 3 MB, where the same viewport on today's 0.005° grid is 2 777 keys. **The gap is the argument
for the ladder** — one file alone leaves a hole from z12 to z14.

#### Long routes: yes, and the mechanism is already right — but the overview walks it into a trap

Routing does not go through the view path at all. `match` names its own blocks from the sketch
(`roadsForSketch`) and reads a **tube** of corridor cells along the drawn polyline, so its cost is
proportional to route LENGTH, not to viewport area. Measured on the deployed site through the app's own
path:

| sketch | corridor | route | network | time |
|---|---|---|---|---|
| 11 points over ~8 km (≈800 m apart) | 19 808 ways | **217 pts, 10 186 m** | 39 requests, 2.3 MB | 4.9 s |
| 3 points over ~3 km | 28 902 ways | 59 pts, 3 185 m | 18 requests, 1.0 MB | 5.4 s |
| **3 points over ~8 km** (≈4 km apart) | 35 833 ways | **NO ROUTE** | 39 requests, 2.3 MB | 8.6 s |
| **3 points over ~40 km** | 162 834 ways | **NO ROUTE** | 415 requests, 25.9 MB | 41 s, wasm **1.45 GB** |

**The limit is point SPACING, not length.** A drawn line at ~800 m spacing routes fine and pays ~5 keys and
~290 kB per km; the same ground as three far-apart taps fails, because the tube tier is rejected, the fat
bbox is read instead (162 834 ways, 1.45 GB of wasm memory) and no route comes back. This is a MATCHER, not
an A→B router — which is by design (DESIGN §1), but it means:

⚠ **The overview makes the failing case the DEFAULT.** At z8 a 100-pixel drag is ~40 km, so a sketch drawn
on a country map is exactly the sparse sketch that returns nothing. **Densify the sketch before matching** —
interpolate along the drawn polyline to ≤~1 km spacing (collinear points do not change the user's intent),
or make the tube radius adapt to point spacing. Without it, "open on the Netherlands" ships a map you can
draw on and get no route from. `browser/rough.mjs`'s `commitEdit` is the one chokepoint it belongs in.

#### Failure paths to design against

1. **Block selection is by AREA, not by zoom.** `chooseBlocks` takes the smallest block CONTAINING the box
   and drops nested hits — so a mid-width box straddling two regions is contained by the overview and by
   neither region, and would draw the coarse map at z14 where detail exists. Fix: **each block declares its
   zoom band in the index** (`"zoom": [0,12]` / `[12,19]`) and JS — which already chooses blocks — filters
   on it. The kernel does not change.
2. **Conservation gates must not be applied to an overview.** It is lossy on purpose. It needs its own gate
   in BOTH directions: every overview feature exists in the detailed block, *and* every debut ≤ Z_HAND
   feature of the detailed block is in the overview. The second direction is the one that catches a silent
   hole — the same class of miss as F5's blank map.
3. **Freshness.** Build it in the same `data-refresh.yml` run from the same extract, or it drifts from the
   regions and the map disagrees with the route.
4. **Double-draw and label duplication** at the handover — one source per kind per frame (above).

#### The rungs, in the order the evidence favours

| | what | observable |
|---|---|---|
| **O0** ✅ | **Measure the country's overview population in ONE generator pass** — done 2026-08-02, above | **handover z10; ~11 MB base + ~3 MB spine ≈ 14 MB** |
| **O1** ✅ | Build the NL z≤10 level (select + **merge** + decimate) **and wire it in** — both done, above | **a bare visit draws 132 094 features in 1 request / 19.62 MB / 0.6 s** |
| **O2** ✅ | Zoom bands (O1b) + **sketch densification as an echo-triggered fallback** (above) | **a 2-point 35 km country drag returns a 791-point route**; every working match byte-identical |
| **O3** ✅ | Close the z11–z13 gap — **done by extending the overview's band to z14, not by a middle level**: the tier floor buys nothing because a tier is a size bin (above) | **z11/z12/z13 all render in 0.5 s from one file**, against 8 GB / 2 GB / 539 MB of keys before |
| **O3b** | The DETAIL half — a z≤12 mid level, paged on its own grid | blocked on O5: every cell size lands at 24–54 MB/viewport while a key costs 3 pages |
| **O4** | The same generator for WE — the only part of §6h's list needing no bucket, no CORS and no 58 regions | a WE overview ships beside the app |
| **O5** ⬅ **next** | *(upstream)* the per-key page cost — 3 pages per key with no batch amortisation. **Promoted: O3b cannot start until this lands** | a z16 view drops from 14.2 MB toward its ~4 MB of content |

O5 is worth filing on `loft-lang/loft` with `tools/base_key_probe.loft` as the repro: it is a ~3× on
**every** zoom, needs no data change, and it is what makes the ladder's per-level floor affordable.

#### Instruments added for this (all keyed reads — none walks a whole store)

* **`tools/base_key_probe.loft`** — one viewport through the app's own reader; asked/loaded/bytes. This is
  the probe that separated "the data is missing" from "it was never fetched".
* **`tools/zoom_bin_probe.loft`** — the debut-zoom × tier cross-tab, i.e. what a zoom-aware reader would
  and would not be able to reach.
* **`tools/overview_size_probe.loft`** — selection vs decimation, with Douglas–Peucker at 1 px of a given
  zoom, over a window (keyed) or a whole store (`whole`, for O0's country pass). The size curve above is
  its output.
* **`tools/spine_size_probe.loft`** — the road spine: ways, vertices, km and decimated vertices per class,
  against the merged bound. This is what showed decimation alone buys nothing on roads.

⚠ **A pixel is not a degree in both axes, and the first version of both probes got it wrong.** Mercator's
screen-y follows `ln(tan(…))`, whose slope is `1/cos(lat)` — so at 52°N a degree of latitude is 1.62 screen
pixels for every one a degree of longitude buys, and decimating on raw degrees silently drops vertices up
to 1.6 px off the line. Corrected, the country's decimated coordinates rose 7–17% (z≤10: 626 692 →
735 407). It did not change a verdict, but an instrument that flatters the answer it is measuring is the
one to distrust.

⚠ **One thing found while measuring this that belongs to §6h, not here: the paged base map works only
because the data repos share the app's origin.** Same code, same block, same viewport — base served
same-origin: 217 requests, 13.58 MB, 22 479 features; served from another origin that sends `ACAO: *` but
no `Access-Control-Expose-Headers` (which is what GitHub Pages sends): **2 requests, ~0 bytes, blank map,
`rangeFails: []`, no error anywhere.** `cors_host_gate.sh` is green because `tools/range_server.py` sends
the expose header and answers the preflight — it models a CORRECT CORS host, and nobody asserted that Pages
is one (it answers `OPTIONS` with 405). D2's off-origin plan rests on this working.

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
output named `<region>-v<YYYY-MM-DD>.store`. ✅ **The cell-key packing is fixed (2026-07-30) — it was wrong
west of Greenwich.** `tools/gen-tiles.loft` packs `key = ty * 1000000 + tx` with truncating division, so a negative
`tx` aliases the previous row (`ty=100,tx=-5` collides with `ty=99,tx=999995`) and the two cells either
side of the meridian both fold onto `tx=0`. Invisible for this block (all of it is east of Greenwich) and
**silent data loss for FR / ES / UK / IE / PT**, which is most of the coverage. It was a data-format
change, so it landed **before** any block west of 0° exists rather than after — at one block, which is the
cheapest this migration will ever be.

*The fix was already written, one library over.* `lib/basemap` keys its layout tiles with a parametric
packing — biased axes, a row multiplier that scales with cell size, floored `cell_ix` — and
`client/basemap/grid_test.loft` already **proved the routing packing collides** at a finer cell. Routing
now uses the same scheme (duplicated, not imported: the server links `routing_kernel` without the map).
`tools/rekey_tiles.loft` migrated the shipped block — 88 tiles, all moved, roads/steps untouched, and it
refuses to write if two tiles ever land on one key. Route byte-identical throughout: the border gate's
three golden fingerprints, `match_parity`, and the browser's pixel hash `917244eb`.

**That tool is also the template for R4's every future migration**: read the old image, write a new one,
prove the route is identical, keep the old file until it is. *Gate:* per-block counts within a band of the previous
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

**R6 · Publish atomically, and PIN each block's hash.** The top index carries every block's `sha256`, and
the client loads with **`store_load_url`** (the verifying loader) rather than `store_load_url_trusted` —
newly available on the browser target as a loft#678 follow-up, which noted the asymmetry precisely: *"the
browser could fetch a whole store but could not PIN its hash: the weaker half of the pair, on the target
most likely to be loading third-party bytes."* At WE scale the blocks live on third-party object storage,
so this is the difference between trusting a CDN and verifying it. Upload blocks under `v<date>/`, verify
each object's size and a Range read of it, **then** flip the top index — the index is the only mutable pointer, so a half-uploaded release is
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

**R9 · Rolling refresh, not a big bang.** The unit of refresh is **one block**, so the steady state is a
queue: regenerate the K oldest blocks each run, publish, flip the index once per run. Whole-WE freshness
then follows from K and the cadence rather than from anyone finding a free weekend. *Observable:* a run
touches only the blocks it claimed and leaves the rest of the index alone. *Gate:* a run that fails
mid-queue leaves a fully consistent index (the previous version for every block it did not finish).

**R10 · Where it runs (D9).** WE needs ~30 GB of source, tens of GB of intermediates and hours of CPU, and
GitHub Actions gives ~14 GB of disk and a 6 h job — so the refresh runs on the **maintainer's machine or a
self-hosted runner**, driven by `tools/build-blocks.sh`, resumable (R2) so one run may span days. CI's job
is the *checks*, not the build: it validates the manifest (R0) and the published index. *Gate:* a run
interrupted by a reboot resumes and produces byte-identical blocks.

⚠ **Sequence R deliberately before S10 — and start it at C1.** Shipping WE-wide data you cannot regenerate
is how a dataset becomes frozen: the first schema change or OSM correction strands it. Running the
procedure when the dataset is one block is nearly free and is the only way the 40-block version is ever
trustworthy.

---

## 8. "Up to date" — the steady state, and how we know

A rung is not done when the data is *published*; it is done when the data is **current and visibly so**.
This is the part that has no natural forcing function, so it gets an explicit target and an alarm.

- **The target.** Every block in coverage is regenerated **at least every 30 days**, aiming at 14. OSM
  moves daily and Geofabrik republishes daily; a month-old cycling network is fine, a year-old one is
  wrong in ways users notice (a new bridge, a closed path).
- **The arithmetic that makes it true.** ~40 blocks at C5 (~16 at C4) ÷ a 14-day cycle = **~3 blocks per
  day at C5, ~1 at C4**. That is the K in R9, and it is what the cadence has to sustain — if R8's measured
  per-block cost makes that impossible, the answer is fewer/bigger blocks or a longer target, decided on
  the number rather than discovered by drift.
- **Freshness is data, not folklore.** Each block carries `generated_at` and its source PBF's date; the
  top index aggregates them. The app **shows the age of the data under the cursor** — partly honesty,
  partly because a visible number is the only staleness monitor that never gets muted.
- **The alarm.** A scheduled check reads the published index and **fails when any block exceeds the
  target**, naming it. That check is the difference between a plan that claims freshness and a dataset
  that has it. *Gate:* it fails today against a hand-made block older than 30 days — which is exactly what
  the current one is, so the alarm is provably wired to reality before it is trusted.
- **Regeneration must be boring.** Anything that makes a refresh scary (a manual step, a broken elevation
  cache, no resumability, a format change without a parity gate) will make refreshes rare, and rare
  refreshes are the failure mode. Every R-step above exists to keep this one property.

**Definition of done for the whole plan:** a cold visitor on a phone routes anywhere in coverage; the
oldest block in the index is inside the target; a single stale region is one block's work to fix; and no
step in doing any of that required a codec of our own.

---

## 9. Still open — with the instrument named

| | question | how it gets answered |
|---|---|---|
| 1 | ~~Does the paged Range reader work in a `--html` build?~~ | ✅ **ANSWERED — and now YES.** It did not compile (E0599); [loft#678](https://github.com/loft-lang/loft/issues/678) fixed it the same night, and `tools/paged_http_gate.sh` reports `browser=pass` at 262 KB / 5 range requests. ⚠ Fix is `fixed-pending-merge` upstream, present in the installed binary only |
| 2 | ~~What does a realistic viewport working set actually cost in bytes?~~ | ✅ **ANSWERED 2026-08-01.** Roads: **17.7 MB of 222.4 MB (8.0%)** for a route on a country block, 271 Range reads (`nl_live_gate`). Base map: **9.1 kB/tile**, so a viewport of 8–20 cells is **75–190 kB — independent of the store's total size**. That last property is what makes §6e's WE path work at all |
| 3 | Is per-working-set `expose` fast enough to render from? | S5; fallback is JS reading pages directly. ⚠ Now the **critical path** for a full NL base map — §6f F2. The READ half is answered (a paged `store_load_key` on a 1.11 GB base store returns a tile identical to the whole load, for 512 kB) ; what is untested is re-`expose` as the working set GROWS |
| 3b | Which builtins are missing on the browser target? | ✅ **ASK IT: `loft targets wasm`** (loft#680, shipped 2026-07-30 — derived from rustc, so it cannot drift from the cfgs). Today it answers *"every stdlib builtin is available here"* |
| 4 | Real density factor, hence real total size | S0 (three blocks) |
| 5 | Is keyed lookup on a reloaded store reliable now? | S2 — the paged loader gives keyed access by construction, which may retire `corridor_ways_impl2`'s comment |
| 6 | R2 vs B2: Range + CORS behaviour and egress cost | S9. ⚠ **Less urgent than it looked**: GitHub Pages itself sends `access-control-allow-origin: *` with a real 206 (measured 2026-08-01 against the live site), so a second Pages site is a free CORS host for NL-sized data. A bucket is still the answer at WE scale — 44–88 GB is 45–90 Pages repos — so this becomes a cost question at C4/C5, not at C2 |
| 7 | `oneway=` is still dropped by the store — ⚠ **the u16 widening it was waiting for HAPPENED** (2026-08-01, `RF_NET_*`), so the schema cost is already paid; bits 11–15 are free and the next regeneration can carry direction | the flags byte is FULL (8/8 bits, see routing_kernel's `RF_*`). Carrying direction needs 2–3 more bits, hence a `u16` — which every existing block must be regenerated for, because the field width is in the schema. Deliberately not half-done alongside the access fix |
| 8 | ~~The NL blocks predate the access bits~~ | ⚠ **NOW A HARD REQUIREMENT, not missing data.** `TTile` gained a `barriers` collection, and a store written before it does not read as "no barriers" — it reads GARBAGE (`len` came back as 20 981 984 713), because `store_load` maps old records at the new stride and ignores the sidecar's own schema hash ([loft#700](https://github.com/loft-lang/loft/issues/700), `sev:high`). Every block MUST be regenerated. `tools/build_index.sh` and `tools/access_gate.sh` both refuse a block whose `.dschema` lacks `barriers@`, so a stale one cannot reach the app |
| 9 | ~~Barrier NODES are never fetched~~ | ✅ **DONE.** `osmium tags-filter w/highway n/barrier` + `--geometry-types=linestring,point`, `parse_barrier_feature` bins them per tile, and `build_graph_barriers` lands each on its graph node by coordinate. 989 in the Enschede block. ⚠ The **Overpass** path still asks for ways only, so an Overpass-sourced corridor (`server.loft`'s fallback when no tile block covers the area) still walks through gates |
| 10 | A barrier BETWEEN way vertices is dropped | `apply_barriers` lands a barrier on the node that shares its coordinate; one tagged mid-segment matches nothing. Correct today (a route cannot pass through a point that is not a node) and worth revisiting only if real data shows barriers tagged off-vertex |
| 11 | An index is capped at **62 blocks** | ⚠ **MINE, and it may bind.** `tools/block_overlap.loft` tracks cell owners as a per-block bitmask; its comment says 62 is "far above the per-index counts C2 contemplates", which was true when written. §6e's disk-derived chunking puts WE at **34–68 blocks**. Cheap fix: count shared cells per PAIR instead of masking. Do it before it is load-bearing |
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
