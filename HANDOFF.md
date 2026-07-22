# HANDOFF — resume state

Single entry point for picking this up on another machine. Reflects the repo as of the branch that
added this file. **Plan of record:** `DESIGN.md` (north-star) + the `PLAN-*.md` docs; this file is the
*status + how-to-resume* layer on top of them.

---

## 1. Where things stand

The **standalone/serverless browser app runs in a real browser** (`browser/store-app.*`, plan of record
`PLAN-BUILD.md`): it fetches the two loft stores by URL (`store_load_url_trusted`), runs the **loft-wasm
kernel** (`client/web_basemap_kernel.loft` → `loft --html`) for the matched route, and needs **no server**.

**`PLAN-PERF.md` §0 has nothing open** (2026-07-22). Steps 1–16 and 20–22 are done; **18 and 19b are ⛔
closed on measurement, not skipped** (see §2 below).

### The numbers, `CPU_THROTTLE=4` (≈ a phone — always profile with it; desktop flatters ~4×)

Quiet box, medians of 6, spreads 1.0–1.1×:

| interaction | before | now | |
|---|---|---|---|
| **view** (pan past the loaded box) | 946 ms | **146 ms** | 6.5× |
| **pan frame** (camera moved, no reload) | 76 ms | **0.6 ms** | 127× |
| **cold match** (first click / corridor miss) | 6370 ms | **1450 ms** | 4.4× |
| **warm match** (one point moved — what users do) | ~880 ms | **343 ms** | 2.6× |
| JS objects retained for geometry | 239,135 | **4,609** | −98% |

**Every shipped change is route-identical**, proven by `tools/match_parity.sh` and (for anything touching
the graph) `tools/tile_border_gate.sh`. The two route-AFFECTING changes ever accepted — step 22's ladder
and nothing since — were gated on a 26-sketch corpus with **0 worse accepted**.

### The six structural changes behind those numbers

1. **loft owns the loop** (steps 4–8) — `loft_start` once, never returns; stores, corridor `Graph` and
   `MatchState` live across commands. It used to run the one-shot model loft explicitly *rejected*: a
   full match per click, a phone frozen 4.2 s at a time.
2. **loft is out of the view path** (steps 9–13) — JS reads the layout store from wasm memory through
   @PLN105's `expose` bridge; `view` emits roads only, **no layout text at all** (was 4.25 MB/view). A
   per-tile feature extent (§7g) then lets a viewport read **6% of the tiles**.
3. **The match ladder** (step 22, and §7p) — cell-tube corridor first, escalating to the fat bbox when a
   margin-relative gate rejects it. ~65% fewer ways when accepted. **Both consumers now run it**: the
   browser kernel and, since §7p, `server/server.loft`'s TILE branch — slotted inside that branch so the
   server's widening loop and its tiles-replace / Overpass-accumulates policy are untouched, with the
   **Overpass path deliberately left OFF the ladder** (the corpus does not cover it). `tier_ok` +
   `TIER_*` + `DEV_MARGIN_K` live in `routing_kernel` for that reason — the server must not pull in
   `map_kernel`'s basemap deps to reach a corridor-quality gate.
   ⚠ The gate's K was swept on `cycling_road`; the server defaults to `walking_paved`, so it was
   **re-swept before wiring** (§7p): K=6 gives 0 worse there too, first bad acceptance at K=9. Worth
   ~13% of a server tile match — less than on cycling, so size it before spending.
4. **JS stopped COPYING the store** (step 14, §6c) — a `vector<Coord>` is *already* an interleaved
   `Int32Array`, so the renderer reads coordinates straight out of wasm memory instead of materialising a
   viewport as 239k JS objects. This is the fix "pre-project into typed arrays" would have missed — it
   would have been a cheaper copy, not no copy. Streets cannot follow (the matcher *iterates* the roads
   store and loft cannot iterate a pinned one — ~230 ms per re-expose), so they parse into a flat column.
5. **Block raster cache** (step 15, §6d) — the base map is baked into 512-px world-pixel blocks and a pan
   blits them. ⚠ It **snaps the render origin** to a whole device pixel and can never be pixel-identical
   (Chromium's rasterisation is not invariant to canvas dimensions — *proven*, §6d), so its gate is three
   equalities plus a bounded delta. **Anything replacing layer data must call `map.invalidateBlocks()`.**
6. **The matcher's own cost, attacked directly** (§7i–§7m) — edges reference their source way instead of
   copying its 11 text tags; costs computed per way, not per edge; the node-dedup key is a packed i64
   rather than formatted text; `nearest_nodes` is one pass, not four; anchor candidates are memoised.
   Cold match 3327 → 1450 ms across those, every one route-identical.

✅ **The growing line is delivered** (§6b(2)) — the route was *emitted* per stretch in travel order but
nothing *rendered* it that way. `runKernel` now takes an opt-in line sink drained per yield in a
microtask (before paint); `map` accumulates stretches by slot. `DESIGN.md` §5 and `PLAN-MATCH` describe
actual behaviour again. Two things its gate then surfaced: `remove_spurs` prunes ~60% of the raw stitch
(the line visibly tightens at the end), and step 22's ladder **emits the route twice** when it rejects the
tube tier (§6b(3)) — which was both a stale number in step 16's row and a live rendering defect.

---

## 2. What is CLOSED (and the one that is only DEFERRED) — do not re-open without new evidence

Six things were investigated and **not shipped**. Each is closed by a measurement, with the probe kept so
the verdict can be re-checked rather than re-derived. *This section exists because the expensive mistake
is re-opening a door someone already measured shut* — and, for the one that is only **deferred**, walking
past it after it has quietly opened.

| | verdict | evidence |
|---|---|---|
| **18 — `par` over the stretches** | ⏸ **DEFERRED, not dead — loft plans browser `par`** | Today the app's wasm has `shared=false` and Rust's no-threads std linked in (WASM-single compiles `threading` OFF → Tier 1 sequential), so `par` is a literal no-op. **But the maintainer confirms loft has a PLAN for browser `par`; it is queued behind another bug.** So this is waiting on a capability, not blocked by a wall — and `tools/wasm_threads.mjs` (in `make test-map`) is the alarm: it **fails the day the kernel wasm gains threads**, which is the signal to build step 18. §6b B's determinism design (order the source before par; hash iteration is unordered; `gen` is loop-carried; keep reductions out of the workers) is kept for exactly that day. ⚠ Still check the DEPLOY side then: Tier 2 needs COEP/COOP headers, and GitHub Pages cannot set them — a service-worker COEP shim may be needed. |
| **19b — persist the graph per tile** | ⛔ **not worth it** | The union is only ~13–21% cheaper than building: it must still hash ~34k part-nodes against a build's 44.7k vertices, copy every edge and rebuild the CSR, and the parts duplicate just 1.5% of their nodes so no cleverer format helps. ~8% of a cold match for a store-format change, a redeploy and the plan's riskiest row (§7a(2)). |
| **`spatial<T[x,y]>` for `nearest_nodes`** | ⛔ **built, measured, reverted** | Correct (routes byte-identical) but a net loss: **+275 ms** of per-corridor index build for **zero** match improvement. Its value was finding that `nearest_nodes` was not the bottleneck at all (§7l). |
| **Pruning the anchor search** | ⛔ **corpus-rejected** | −28% at a 400 m cap but routes get *longer* by up to 62%; the corpus's own `dev_max` reaches ~1056 m so any useful cap severs legitimate paths, and every cap loose enough to preserve routes is inside the ~3.4% noise floor (§7n). |
| **Sharing anchor searches across a span** | ⛔ **corpus-rejected** | SPAN=2 verified to reproduce today's behaviour exactly; every span ≥3 was WORSE — sketch 11 gained **855 m of bridging**, sketch 19 grew **+79%** — because a block path optimised end-to-end stops passing close to the intermediate taps (§7o). |
| **A cheaper `denoise_anchor`** | ⛔ **both levers closed** | Narrowing each search (§7n) and sharing searches (§7o) are both rejected. Its ~131 ms is the honest cost of centring each anchor on its own neighbourhood; anything cheaper is a **different matcher**, not a faster one. `tools/corpus_anchor.loft` is the gate for whoever disagrees. |

---

## 2a. ✅ DONE — the rough-layer editor is ported (2026-07-23)

**The standalone app can now RESHAPE a sketch, not just append to it.** `DESIGN.md` §1's primitive set is
live: **place · drag · insert (tap + sweep) · delete (double-click / select + Delete) · contiguous-range
multi-select + bulk delete · undo/redo · shift-drag box select.** Plan of record and full write-up:
**[`PLAN-EDIT.md`](PLAN-EDIT.md)** — steps E0–E7, all done, its §9 is the definition-of-done check.

**The shape of it.** One module, `browser/rough.mjs`, owns the sketch and every input that can change it.
Three chokepoints carry the invariant (*one road in, one road out*): **input dispatch** (one pointer
handler classifies pan · move · box and delegates the camera to `map.dragTo`), **`commitEdit`** (the only
path from a mutation to a redraw, a match request and an undo record), and **`KernelQueue`** (the only road
to the kernel — one job at a time, latest-wins per key). `map.mjs` draws the sketch in the overlay pass
inside the snapped-origin block; it owns pixels, the layer owns state.

**Three defects that predate the work, found by probing and now gated:**
- a **pan drag appended a spurious rough point** (two files bound input and neither knew about the other);
- a **click during a match was silently dropped** — the drawn route ended **1417 m** from the last point;
- `renderSnappedDirect` drew **different overlays** than `render`, so the two produced different pictures.

**Performance is unmoved, and P5 now runs in a gate.** `CPU_THROTTLE=4`, medians of 6, spreads 1.1–1.2×
(⚠ load ~4, a sibling tree building): warm-move **347 ms** against 343 on record, cold **1535** against
1450. The two edits the editor added ride the same incremental path — **insert 323 ms · delete 370 ms**,
20–23% of a cold match — and `__perfHooks.matchInsert`/`matchDelete` plus a `make test-map` assertion keep
that verdict re-checkable instead of re-derived.

⚠ **A drag cannot re-match per frame**, and this is why the queue exists: a warm match is ~350–545 ms while
a drag emits ~33 moves/second. Measured, **20 move events → 6–8 matches**, with the drawn route
byte-identical to a re-match of the settled sketch. `DESIGN.md` §1's two-tier feedback is the rule — the
**rough line is instant** (pure JS, every frame), the **matched route is lag-tolerant**.

**If you extend the editor, three rules the work paid for:**
1. `map.points` and the layer's array are **ONE array**. Mutate in place (`push`/`splice`/`length = 0`);
   re-assigning it leaves the renderer holding the old sketch (PLAN-EDIT failure path 11).
2. Anything keyed on a **screen position** breaks when the map moves under it. Key on the point's **`id`**.
3. A gesture must commit **exactly once**, and only when it really changed something — that single fact is
   what makes undo, the coalescer and the match count all come out right.


## 3. Resume here (2026-07-23)

- **Read first:** `PLAN-PERF.md` — its header table is the current state, §0 the step list, and §7i–§7o
  the matcher work. Then `CLAUDE.md` § "Read the reference before you write".
- **Toolchain:** installed loft is **2026.7.2**. Routing absorbed the @PLN110 `len`/`size` flip with no
  source edits.
- **Gates** — `make test`, `test-native` (now includes **`tools/tile_border_gate.sh`**), `test-wasm`,
  `test-map` (browser render + the @PLN105 bridge probes + the step-18 threading tripwire + **the whole
  rough-editor gesture suite**, driven with real `Input.dispatchMouseEvent` / keystrokes / SHIFT), and
  **`tools/match_parity.sh`**. ⚠ **CI has no chromium**, so `test-map` and the bridge gates are local-only.
  `browser/map.test.mjs` is the DOM-free tier beneath it (projection, pan/zoom, and every editor
  invariant that is pure logic) — it runs first inside `map_render_gate.sh` and needs no browser.
  ⚠ `map_render_gate.sh` also **greps** what no run can see: every pointer/click listener lives in
  `rough.mjs`, and the app reaches the kernel from exactly **two** places, both inside queued jobs.
- **Instruments** (durable, in `tools/`): `map_profile.sh` (**always `CPU_THROTTLE=4`**),
  `match_parity.sh`, `tile_border_gate.sh` + `tile_border_probe.loft` (routes across tile borders,
  order-insensitivity), `corpus_anchor.loft` (§7 quality per sketch — the gate for ROUTE-AFFECTING
  changes), `corpus_tube.loft`, `match_phase_probe.loft` (cold-match split, 3-point **and** 40-point),
  `union_probe.loft`, `nodekey_probe.loft`, `spatial_probe.loft`, `wasm_threads.mjs`,
  `match_session_probe.loft`, `deliver_probe.sh` + `expose_probe.sh`, `tile_overhang.loft`.

**Nothing is blocked upstream.**

### Where the remaining time actually is

Native cold-match split (TUBE tier, the one a cold match uses): **corridor 20 · build_graph 93 ·
match 88**. In the browser a cold match is 1450 ms and a warm one 343 ms.

- **The warm match is the interaction users perform**, and it is now 343 ms. Most of it is the anchor
  pass, whose two levers are closed (§2).
- **The cold match's remaining bulk is `build_graph`** (93 of 201 native). Persisting it is rejected
  (§7a(2)); what is left would be making the build itself cheaper, and `add_edge`'s record construction
  is already down from 14 fields to 4.
- **A dense sketch is the honest case.** `match_phase_probe` runs a 40-point sketch as well as the
  3-point one: on 40 points the SEARCH is ~75% of a cold match, where on 3 points it is ~35%. Anchoring
  is per POINT — measure the case you intend to improve.

**Traps this session paid for, so you do not have to:**
- **A probe outside a gate is a comment.** Four instrument bugs were found in one day; every one was a
  probe no gate ran, silently invalidated by a later step. All bridge probes are now in `make test-map`.
- **A profile without its spread is not a measurement.** Sibling-tree builds put this box at load average
  25 mid-session and produced a 2.0× spread that read as a regression. Check `uptime` first.
- **A corpus average is not a claim about a specific interaction.** Step 22's first gate won on corpus
  aggregate and made the app's own sketch 1.7× slower (§7h). The app's sketch is now IN the corpus.
- **Store-format changes fail SILENTLY** — an old-schema store gives no output, no error, exit 1. And the
  file size can be byte-identical after adding fields; read a field to verify, not `ls`.

- **Known-stale below:** §§4–11 predate the `lib/` package layout and the store app; treat them as
  history. (They were §§2–9 before §§1–3 were rewritten — the range was renumbered with them.)
  ⚠ Two things in §9 are already stale in a way that matters: **PR #8 is closed** (no PRs are open), and
  Track 1d's "Leaflet base map" was superseded — the app has its **own canvas renderer** (PLAN-MAP), which
  is what §§1–3 describe.

---

## 4. What works / is merged to `main`

- **Tile-block matching** — `server/server.loft` binds the block once (`store_persist_bind`) and reads
  its corridor via `tiles_corridor_ways` per request, Overpass fallback when outside coverage. Verified
  live: 811 m / 0 bridges from tiles, no network; warm edits ~40–68 ms.
- **Match-quality instrumentation** (`lib/routing_kernel`) — `match_quality()` emits the PLAN-MATCH §7
  numbers (deviation, bridged length, on-network length, per-metre suitability penalty, road-class mix),
  captured **during assembly** (`assemble_stretch`) since the stitched route isn't a clean edge-walk.
- **Browser-app compute+data core, proven headless in wasm** (`client/app_kernel.loft`, PLAN-APP Track 1
  step 1) — loads a WHOLE test-set directly (one Overpass-JSON file via `parse_ways`, no mmap store, no
  codec) and runs the **full matcher** (`parse_ways → build_graph → match_route`) byte-identically on
  interpret == native == native-wasm (472 ways → 90-pt route on the `real_stretch` fixture). This is the
  first wasm proof of the *whole* matcher — the earlier gate only covered the geodesic. Standing gate:
  `tools/app_headless_test.sh`, wired into `make test-wasm`.
- **Serverless browser shell runs in a real browser** (`browser/`, PLAN-APP Track 1a–c), built the
  **loft-native way** — `client/web_kernel.loft` → `loft --html` → the page fetches a whole test set
  and runs the full matcher in wasm over loft's own `host_input()`/`println` channel (a 4-import shim;
  **no jco, no WASI, no npm**), draws the route on an SVG, re-matches on each map click, **no server**.
  It is **fully offline-capable**: a **service worker** (`sw.js`) caches the app shell + wasm and the test
  set is cached in **IndexedDB**, so a reload with the **network entirely off** still loads and matches.
  Verified in headless Chromium (`tools/browser_app_test.sh`, via CDP): the in-browser route is
  **byte-identical to the native reference**, a synthetic click re-matches, and a fully-offline reload
  still matches from cache. *(An earlier jco-based shell was the wrong tool and was retired for this.)*
  Remaining **Track 1d**: a **Leaflet** base map + a **GitHub Pages** deploy — no loft dependency.
  - ⚠ **loft debugger `eval`/`setValue` break in any frame with a `vector` local** (`../loft` `dc06812a`):
    breakpoints verify, the `stopped` frame inspects fine, `stepOver`/`continue` work — but `eval` returns
    `null` for *everything* (even `2 + 2`) and `setValue` is rejected once the paused frame holds a
    `vector<T>` local (scalars/structs are fine). Since real code always has vector locals, eval/setValue
    are effectively unusable. Minimal repro + narrowing in `docs/loft-feedback.md` (2026-07-07); no open
    tracker issue — maintainer's call to file.
- **Plan docs** — `PLAN-MATCH` (escalation ladder + §7 numbers + §9 mode×intent), `PLAN-ROUTING`
  (get-me-there fork), `PLAN-APP` (the standalone app; §10 concrete steps; §11 data freshness). Plus the
  pre-existing `PLAN`, `PLAN-BROWSER`, `PLAN-TILES`, `DESIGN`.
- **Open-project setup** — `LICENSE` (LGPL-3.0-or-later), `LICENSE.data` (ODbL-1.0 for the blocks), SPDX
  headers on our sources, `ATTRIBUTION.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `.github/ISSUE_TEMPLATE/`.
- **CI** (`.github/workflows/ci.yml`) — builds binaries (server + wasm client) and runs `make test` on
  every PR/push. The wasm-parity *run* is non-blocking (was gated on loft#521, now fixed — re-enable
  blocking once the fix reaches loft `main`; see §9).
- **Data-refresh workflow** (`.github/workflows/data-refresh.yml`) — monthly, **dormant** until
  `tools/build-blocks.sh` exists (see §5).
- **Pipeline tools** — `tools/gen-tiles.loft` (block generator) + `tools/geojson2overpass.py`
  (converter), rescued from scratch so the data pipeline is portable.

## 5. Open PRs

- **#8** `ci-wasm-note` — corrects the CI comment to point at loft#521 (my first note wrongly blamed
  "wasmtime 46"). Safe to merge when green.
- **(this)** `handoff` — this file + the rescued pipeline tools.

---

## 6. External dependency states (loft) — the real gating

| issue | what | state | effect here |
|---|---|---|---|
| loft#511 | collection capture into closures | **FIXED (merged)** | unblocked the server binding the block into the event loop |
| loft#513 | store re-init (bind reads full data) | **FIXED (merged)** | **⚠ changed the on-disk store format** — `.tiles` written by pre-fix loft read *empty*; regenerate with current loft |
| loft-libs-net #517 | HTTP range/bytes/headers/size stack | **implemented on branch `tuxedo-517-http-stack`, NOT merged** | needed for browser working-set **range reads** (Benelux+, PLAN-APP Track 2) |
| **loft#521** | `--native-wasm` aborted at runtime (#518 spawned a main-stack thread wasip2 can't create) | **FIXED** — loft `db19ec43` (branch `tuxedo-add-to-project`): wasm `main` runs directly, native keeps the large-stack thread. **Confirm it reached loft `main`** before trusting a fresh main checkout. | **Unblocked**: Track 1 (browser) + Track C's "prove under wasmtime" run step now work — no pre-#518 workaround needed. |
| **loft#522 / B4** | store read in wasm: heap `store_load(path)`, HTTP `store_load_url(_trusted)`, paged `store_load_key(s)` / `store_load_range` | **SHIPPED** (in the installed loft, 2026.7.1) | **Unblocked the whole PLAN-BUILD app.** `store_load` decodes a store in wasm (verified byte-for-byte under `--native-wasm`); `store_load_url_trusted` fetches over HTTP, the fetch asyncify-bridged to JS `fetch()` in the browser (verified in-browser). No codec, no jco. |

The #521 fix has landed; once it merges to loft `main`, flip the CI wasm gate back to blocking (§9).
**loft#522 / the B4 store-in-wasm gap is now SHIPPED** — the `store_load*` family reads a store in wasm and
fetches one by URL, which is what the PLAN-BUILD store app runs on (`browser/store-app.*`). The earlier
"no codec — a store file is its own serialization" bet held: the browser reads the store directly.

---

## 7. The tile data + how to regenerate it

- The block **`soverijssel.tiles`** (21 MB, southern-Overijssel, 1215 tiles) is **gitignored** (`*.tiles`)
  — it does not travel. The server matches from it if present in the launch dir, else Overpass.
- **It must be regenerated with the current loft** (loft#513 format change). Pipeline (now in `tools/`):

  ```sh
  # 1. Geofabrik extract → highways only → GeoJSON-seq (LineStrings + tags)
  osmium tags-filter <region>.osm.pbf w/highway -o roads.pbf
  osmium export roads.pbf -f geojsonseq -o roads.geojsonseq
  # 2. → Overpass-JSON shape that parse_ways/gen-tiles consume
  python3 tools/geojson2overpass.py roads.geojsonseq overpass.json
  # 3. → the tile block (native; writes an mmap store)
  loft --native-release --lib lib tools/gen-tiles.loft <region>.tiles overpass.json
  # 4. OSM snapshot date for the attribution (PLAN-APP §11)
  osmium fileinfo -e -g data.timestamp.last <region>.osm.pbf
  ```
  (`parse_ways` reads **Overpass-JSON**, not geojsonseq — step 2 is required. Verify counts: soverijssel
  = 1215 tiles / 229,117 roads.)
- **`tools/build-blocks.sh` does not exist yet** — scripting the above per-block (with the snapshot
  stamp + top index) is PLAN-APP Track C/2 work (steps F3/F4). Writing it activates the data-refresh
  workflow and Benelux/WE generation.

---

## 8. Environment to resume

- **loft** as a sibling checkout at `../loft`, built: `cargo build --release` (needs **mold** on Linux;
  `export SDKROOT=$(xcrun --show-sdk-path)` on macOS). Point the app at it via `LOFT=../loft/target/release/loft`.
  - The local `../loft` here now includes the **#521 fix** (`db19ec43`, branch `tuxedo-add-to-project`):
    `--native-wasm` runs under wasmtime, no pre-#518 workaround needed. For the wasm **build/rlib**: `rustup target add wasm32-wasip2`
    then `cargo build --release --target wasm32-wasip2 --lib --no-default-features --features random`.
- **Build/test/run:** `export SDKROOT=…` (mac); `make build`, `make test`, `make run`. CI mirrors this.
- **Browser (Track 1) needs only `node` + a `browser`** — the app is built with `loft --html` (loft's
  own browser engine), so **no jco / npm / WASI**. `node browser/build.mjs` produces `browser/web_kernel.wasm`;
  `node browser/serve.mjs` serves it. wasmtime is enough for the separate headless `--native-wasm` gate,
  and with #521 fixed it runs (verified via `make test-wasm`).

---

## 9. Next steps (from PLAN-APP §10/§11)

Do in this order; **O** and the doc/tooling are done or in-flight.

1. **Merge PR #8** (CI note) — trivial.
2. **Track C — data-access core** (headless). **⚠ Rescoped — no codec.** A store file IS its own
   byte-exact serialization (portable native↔wasm), so there is nothing to hand-decode; loading a tile is
   reading store bytes into a heap arena. The working-set data path is now **loft#522** (partial store
   load over HTTP range reads → fill a local store that behaves as if the whole store loaded), which is
   **maintainer-side loft work**. Routing side, once #522 lands: build blocks as `sorted<TTile[tkey]>`
   (range-friendly for a geographic cell window — a hash index forces near-whole-file reads), a working-set
   **resolver** (`pts+margin → tkey range`), then `store_load_range` → match. Phase 1 of #522 (plain heap
   `store_load(path)`) alone unblocks whole-block wasm loading, provable under wasmtime now (#521 fixed).
3. **F1/F2 (data freshness)** — stamp `osm_snapshot` in `gen-tiles.loft` + top index; show "data as of …"
   in the app attribution.
4. **Track 1 — browser app.** ✅ **1a–c done** — `browser/` (loft-native: `web_kernel.loft` → `loft --html`,
   `host_input`/`println` engine, no jco) fetches a whole test set and runs the full matcher in wasm,
   interactive (click → match → redraw), no server, verified byte-identical to native in headless Chromium
   (`tools/browser_app_test.sh`), with a **service worker** + **IndexedDB** so a reload with the network
   fully off still matches (verified). Remaining **Track 1d**: a **Leaflet**
   base map, deploy to Pages
   (unlisted URL). No loft dependency. The whole-file model holds until loft#522 lands the working-set
   partial load. See `browser/README.md`.
5. **Track 2 — Benelux**: `tools/build-blocks.sh` (F3) → generate blocks → top index → Release hosting
   (verify cross-origin CORS/Range) → working-set range loading. Enable the data-refresh cron (F4).
6. **Track 3 — Western Europe**: more blocks + cross-block stitching + LRU.

---

## 10. Gotchas / things that cost time (don't relearn these)

- **`store_persist_bind` (mmap write) is native-only** — but reading a store in wasm now works:
  **`store_load(r, path)`** is the heap reader for a browser / wasm target (verified byte-for-byte under
  `--native-wasm`), and **`store_load_url_trusted(r, url)`** fetches a store over HTTP and decodes it in the
  browser (the fetch asyncify-bridged to JS `fetch()`). The "no codec — a store file is its own
  serialization" bet held. (Supersedes PLAN-APP §3's fetch+decode-codec framing and the 2026-07-09
  loft-feedback "B4 gap" entry.)
- **loft#513 changed the store format** — any `.tiles` from an older loft reads *empty*; always
  regenerate after updating loft.
- **`parse_ways` eats Overpass-JSON, not geojsonseq** — hence `tools/geojson2overpass.py`.
- **loft#521** (FIXED, loft `db19ec43`): every `--native-wasm` program *used to* abort at runtime under
  any wasmtime (43 and 46) — the #518 thread-spawn, **not** a wasmtime version; a wasmtime pin did not
  help. The fix runs wasm `main` directly. If you see the abort again, you're on a loft build predating it.
- **`make test` needs** node 22 (global `WebSocket`), `fuser` (psmisc), and creates `scratch/` itself.
  `make test-wasm` needs wasmtime.
- **CI builds loft from source** (no public binary); it caches on loft's HEAD sha and builds both the
  host binary and the wasip2 rlib.
- **Scratch is ephemeral** — anything under the session scratchpad (old experiments, the netherlands
  `.pbf`, intermediate `.tiles`) is gone on a new machine. The pipeline is now in `tools/`.

## 11. Loose ends

- CI wasm-parity gate is informational; loft#521 is fixed on branch `tuxedo-add-to-project` — re-block it
  once the fix merges to loft `main`.
- `tools/build-blocks.sh` unwritten → data-refresh workflow dormant, Benelux/WE not yet generated.
- #517 not merged upstream → browser range reads pending.
- Elevation `h` in tiles is currently 0 (gen-tiles sets `h: 0`); needed for gradient/bike/climb
  (PLAN-ROUTING) — populate from terrarium at generation.
