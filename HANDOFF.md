# HANDOFF — resume state

Single entry point for picking this up on another machine. Reflects the repo as of the branch that
added this file. **Plan of record:** `DESIGN.md` (north-star) + the `PLAN-*.md` docs; this file is the
*status + how-to-resume* layer on top of them.

---

## 1. Where things stand (one paragraph)

The **standalone/serverless browser app runs in a real browser** (`browser/store-app.*`, plan of record
`PLAN-BUILD.md`): it fetches the two loft stores by URL (`store_load_url_trusted`), runs the **loft-wasm
kernel** (`client/web_basemap_kernel.loft` → `loft --html`) for the matched route, and needs **no
server**. **As of 2026-07-22, `PLAN-PERF.md` steps 1–16 and 20–22 are done; 15, 18 and 19 remain.**

Three structural changes got it there, and each is worth more than its number:
1. **loft owns the loop** (steps 4–8) — `loft_start` once, never returns; the stores, corridor `Graph`
   and `MatchState` live across commands. It used to run the one-shot model loft explicitly *rejected*,
   which meant a full match per click and a phone frozen 4.2 s at a time.
2. **loft is out of the view path** (steps 9–13) — JS reads the layout store straight from wasm memory
   through @PLN105's `expose` bridge; `view` emits roads only and serialises **no layout text at all**
   (was 4.25 MB per view). A per-tile feature extent (§7g) then lets a viewport read **6% of the tiles**.
3. **The match ladder is live** (step 22) — a cell-tube corridor tried first, escalating to the fat bbox
   when a margin-relative gate rejects it. ~65% fewer ways when accepted.
4. **JS stopped COPYING the store** (step 14, §6c) — a `vector<Coord>` is already an interleaved
   `Int32Array`, so the renderer reads coordinates straight out of wasm memory instead of materialising a
   viewport as 239k JS objects. This was the fix "pre-project into typed arrays" would have missed.
   Streets can NOT follow (the matcher iterates the roads store, and loft cannot iterate a pinned one —
   ~230 ms per re-expose), so they parse into a flat column instead. 239,135 → 4,609 retained objects.

Measured at `CPU_THROTTLE=4` (≈ a phone — **always profile with it; desktop flatters ~4×**), medians of 6
at 1.1–1.5× spread: **view 946 → 126 ms**, **pan frame 76 → 20 ms**, **cold match 6370 → 1539 ms**,
**warm match ~880 → 358 ms**. JS now retains **4,609** objects for geometry, not 239,135 (§6c), and a pan
frame is **0.6 ms** (§6d).
Every step was gated on the route staying **byte-identical** (`tools/match_parity.sh`), and step 22 — the
only route-affecting one — additionally on a 26-sketch corpus with **0 worse accepted**.

✅ **The growing line is delivered** (2026-07-22, closing the one documented behaviour that was not).
The route was already *emitted* per stretch in travel order, but nothing *rendered* it that way —
`runKernel` returned the whole response at `#EOR` and only the final `ROUTE` was drawn, so the
`frame_yield()`s bought responsiveness (worst frozen gap 11095 → 384 ms) and no growing line. Now
`runKernel` takes an opt-in line sink drained per yield in a microtask (before paint), and `map`
accumulates stretches by slot and re-strokes the route so far. `DESIGN.md` §5 and `PLAN-MATCH` again
describe the actual behaviour. See `PLAN-PERF` §6b(2) — including what its gate then surfaced:
`remove_spurs` prunes ~60% of the raw stitch, so the line visibly tightens when the match completes.
**And §6b(3)**, from profiling it straight after shipping: step 22's ladder emits the route **twice** when
it rejects the tube tier (78 stretches on a 40-point sketch, not 39), which was both a stale number in
step 16's row and a live rendering defect — now fixed and gated DOM-free in `map.test.mjs`.

---

## 1a. Resume here (2026-07-22)

- **Read first:** `PLAN-PERF.md` — its header table is the current state, §0 the step list. Then §7g(2)
  (the viewport filter), §7h(2) (the match ladder), §6b(2) (the growing line — delivered, and what its
  gate then surfaced about `remove_spurs`).
  `CLAUDE.md` § "Read the reference before you write" — the rule that would have saved this session hours.
- **Toolchain:** installed loft is **2026.7.2** (@PLN110 `len`/`size` flip: `len(text)` is CHARACTERS,
  `size(text)` is BYTES — breaking). Routing absorbed it with **no source edits**; all five gates pass.
- **Gates** — `make test`, `test-native`, `test-wasm`, `test-map` (browser: render + both @PLN105 bridge
  probes), and **`tools/match_parity.sh`** (route identity — the one that matters most).
  ⚠ **CI has no chromium**, so it runs neither `test-map` nor the bridge gates. They are local-only.
- **Instruments** (all durable, all in `tools/`): `map_profile.sh` (**always `CPU_THROTTLE=4`**),
  `match_parity.sh`, `corpus_tube.loft` (the ladder's gate sweep + cost model), `match_session_probe.loft`
  (native ground truth for the four match interactions), `deliver_probe.sh` + `expose_probe.sh` (the
  bridge), `tile_overhang.loft` + `tile_bbox_probe.loft` (tile geometry), `tile_lookup.loft`,
  `par_copy_probe.loft`, `expose_iter_probe.loft`.

**Nothing is blocked upstream.** Both 2026-07-17 blockers cleared on 2026.7.2 (§7c): @PLN108's par-copy
elision is live (probe flat 1–3 ms vs 214 ms), and the `expose` hang was root-caused — `expose` pins the
store read-only and **iterating** a store-backed hash claims a cursor record *inside it*; **reads are
fine**, and `release`/`expose` brackets it.

⚠ **`PLAN-PERF` §0 has nothing open.** 18 and 19b are both ⛔ and measured, not guessed. The graph build
was then attacked directly (**§7i**): edges now reference their source way instead of copying its 11 text
tags, and `precompute_edges` computes costs **per way** rather than per edge — **cold match 2721 → 1820
ms**, warm 644 → 526, routes byte-identical. Then the SEARCH (**§7j**): `nearest_nodes` allocated a graph-sized vector and ran
4 full scans over every node, ~3x per sketch point — **anchoring cost more than routing**. One pass
keeping the best K, identical tie-breaking, identical routes: **warm match 526 → 395 ms**. Native split
is now corridor 20 · build_graph 93 · match 88.
Then **§7k**: `EdgeCosts` indexed by WAY rather than by edge — five arrays of
37.6k entries (~188k appends) collapsed to ~7.1k, free in the hot loop because it already loads the edge
record. **cold match 1831 → 1539 ms**, warm 395 → 358.
**Next:** `nearest_nodes` is still O(nodes) per call. loft's `spatial<T[x,y]>` would make it O(log n),
but a Morton walk returns Z-order, NOT distance order — so an exact replacement needs an expanding-box
query plus an exact re-rank, with the candidate SET and its tie-breaking identical. The border gate +
`match_parity` are its acceptance.

**What to do next, in the order the evidence favours:**

1. **Steps 14–15 are DONE — the render path is finished.** A pan frame is **0.6 ms** (was 76) and a view
   **146 ms** (was 946). What is left is all in the MATCH. Before touching the renderer read `PLAN-PERF`
   §6d: the block cache is ON, it **snaps the render origin** to a whole device pixel, and it can never be
   pixel-identical (Chromium's rasterisation is not invariant to canvas dimensions — proven, not assumed),
   so its gate is three equalities plus a bounded delta. **Anything that replaces layer data must call
   `map.invalidateBlocks()`** or the map shows stale tiles that panning does not repair.
   **Read `PLAN-PERF` §6c before touching the render path**: the app no longer copies the store into JS —
   a `vector<Coord>` IS an interleaved `Int32Array` and `browser/store-geom.mjs` indexes it, so geometry
   is read straight out of wasm memory. Two rules that costs come with: **`memory.grow` DETACHES the
   buffer** (re-derive the view every frame; never cache it across a match), and the gate is a **canvas
   pixel hash**, because counts cannot see a ring read at a wrong offset.
2. **Step 18 — ⛔ DO NOT BUILD.** `par` is a **no-op in the browser** (`PLAN-PERF` §6e), proven from the
   app's own wasm: `shared=false`, Rust's no-threads std linked in, loft's WASM (single) profile compiles
   `threading` OFF → Tier 1 sequential. Tier 2 needs COEP/COOP headers GitHub Pages cannot set. Its verify
   line was "~3× **native**" — the server, not this plan's subject. `tools/wasm_threads.mjs` gates it and
   FAILS the day browser threads arrive, which is when to revisit. §6b B's determinism design is still
   correct and kept for that day.
3. **Step 19 — RE-MEASURED, and 19a is done** (`PLAN-PERF` §7a(2)). The re-sizing found the opposite of
   what §7a expected: `build_graph` is **~50%** of a cold match, not ~41% — steps 20–22 shrank the
   corridor read further than the graph build. **19a** removed the TEXT node key (`"{lat},{lon}"`
   formatted per vertex) for a packed i64: cold match **3327 → 2721 ms** browser, routes byte-identical,
   no format change. **19b is ⛔ MEASURED AND REJECTED** (§7a(2)): `tools/union_probe.loft` simulated it
   with in-memory parts and the union is only **~13–21% cheaper** than building — it must still hash ~34k
   part-nodes against a build's 44.7k vertices, copy every edge and rebuild the CSR — so it is worth ~8%
   of a cold match (~215 ms of 2721) for a store-format change, a redeploy, and the plan's riskiest row.
   Kept: `tools/tile_border_gate.sh` (in `make test-native`) and the reference `union_graphs`, whose route
   identity that gate asserts. Re-run `union_probe` first if it is ever reopened.
4. **The cold match still blocks ~3.4 s in ONE frozen gap** — the responsiveness problem is now that gap,
   not the total. Step 16's `frame_yield()`s do not reach it (the gap is in the corridor read +
   `build_graph`, before the first stretch exists).

**One thing NOT done that a reader might assume is:**
- **`server/server.loft` is not on the match ladder** (step 22 wired only `lib/map_kernel`). The server
  keeps its own `covered()` + corridor logic and an Overpass path the corpus does not cover.

**Traps this session paid for, so you do not have to:**
- **A probe outside a gate is a comment.** Four instrument bugs were found in one day; every one was a
  probe no gate ran, silently invalidated by a later step. All bridge probes are now in `make test-map`.
- **A profile without its spread is not a measurement.** Sibling-tree builds put this box at load average
  25 mid-session and produced a 2.0× spread that read as a regression. Check `uptime` first.
- **A corpus average is not a claim about a specific interaction.** Step 22's first gate won on corpus
  aggregate and made the app's own sketch 1.7× slower (§7h). The app's sketch is now IN the corpus.
- **Store-format changes fail SILENTLY** — an old-schema store gives no output, no error, exit 1. And the
  file size can be byte-identical after adding fields; read a field to verify, not `ls`.

- **Known-stale below:** §§2–9 predate the `lib/` package layout and the store app; treat them as history.

---

## 2. What works / is merged to `main`

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

## 3. Open PRs

- **#8** `ci-wasm-note` — corrects the CI comment to point at loft#521 (my first note wrongly blamed
  "wasmtime 46"). Safe to merge when green.
- **(this)** `handoff` — this file + the rescued pipeline tools.

---

## 4. External dependency states (loft) — the real gating

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

## 5. The tile data + how to regenerate it

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

## 6. Environment to resume

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

## 7. Next steps (from PLAN-APP §10/§11)

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

## 8. Gotchas / things that cost time (don't relearn these)

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

## 9. Loose ends

- CI wasm-parity gate is informational; loft#521 is fixed on branch `tuxedo-add-to-project` — re-block it
  once the fix merges to loft `main`.
- `tools/build-blocks.sh` unwritten → data-refresh workflow dormant, Benelux/WE not yet generated.
- #517 not merged upstream → browser range reads pending.
- Elevation `h` in tiles is currently 0 (gen-tiles sets `h: 0`); needed for gradient/bike/climb
  (PLAN-ROUTING) — populate from terrarium at generation.
