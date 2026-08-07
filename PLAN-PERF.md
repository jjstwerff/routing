<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-PERF — making the standalone app fully performant

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-03 · **Owns:** the step list, the one invariant, the baseline and the instrument discipline — the spine; four children hold the cost centres

**Status (2026-07-22):** steps **1–16 and 20–22 IMPLEMENTED** (16 including its presentation half —
§6b(2); 14 rescoped by measurement — §6c; 15 landed and ON — §6d); **18 is ⛔ not buildable in the
browser — §6e**; **open:**
**18** (`par`), **19** (persist the graph). **Nothing is blocked upstream** — re-validated against the
installed loft **2026.7.2**, see §7c. All five gates pass on it (`test`, `test-native`, `test-wasm`,
`test-map`, `match_parity.sh`), including through the breaking @PLN110 `len`/`size` flip.
**Plan of record for app performance.** It does not supersede `PLAN-MATCH` (the matcher's own ladder) —
it measures it and ranks it against everything else.

**Where it stands** — `CPU_THROTTLE=4`, medians of 6, spreads 1.1×, route proven byte-identical by
`tools/match_parity.sh` at every step:

| interaction | before | now | |
|---|---|---|---|
| **view** (pan past the box) | 946 ms | **126 ms** | 7.5× — §7g(2), §6c |
| **pan frame** (camera moved, no reload) | 76 ms | **20 ms** | 3.8× — §6c |
| JS objects retained for geometry | 239,135 | **4,609** | −98.1% — §6c |
| **cold match** (first click / corridor miss) | 6370 ms | **1450 ms** | 4.4× — §7h(2), §7a(2), §7i–m |
| **warm match** (one point moved — what users do) | ~880 ms | **343 ms** | 2.6× — §7i–m |
| repeat match (nothing changed) | ~450 ms | **367 ms** | 1.5× |
| layout text loft serialises per view | 4.25 MB / 29 144 lines | **0** | §0 step 13 |

The two structural wins behind those: **loft owns the loop** (one `loft_start` per session, stores decoded
once — steps 4–8), and **loft is out of the view path entirely** (JS reads the layout store through
@PLN105's bridge; `view` emits roads only — steps 9–13).

**Open, in the order the evidence favours:**
- **Nothing in §0 is open.** 18 is ⛔ (`par` is a no-op in the browser, §6e) and **19b is ⛔ measured and
  rejected** (§7a(2): the union is only ~16% cheaper than building — ~8% of a cold match — for a format
  change and the plan's riskiest row). 19a landed the cheap part (−18%, routes byte-identical).
- **The cold match is now 1820 ms** (§7i: edges reference their way instead of copying its tags; costs
  computed per way, not per edge). Native split is now corridor 20 · build_graph 93 · match 115 — the
  SEARCH is the largest slice for the first time.
- **18 is ⏸ DEFERRED, and its loft-side blocker is GONE** (2026-07-29) — loft's browser `par` **landed**
  (@PLN117) and is verified working on the installed 2026.7.2: a `loft --html` bundle dispatches `par`
  across **8 Web Workers** with the interpreter's value. The kernel is still unthreaded only because it
  has **no reachable `par`**. What gates 18 now is the **deploy host**: Tier 2 needs COOP/COEP and GitHub
  Pages cannot send it. ⚠ `tools/wasm_threads.mjs` was **BLIND** and is fixed — it is not, and never was,
  the cue for step 18 (§6e).
- **18 — `par` over the stretches.** Unblocked 2026-07-22 (@PLN108's copy elision is live).
- **19 — persist the built graph.** ⚠ Its "~41% of a cold match" premise predates steps 20–22 and must be
  **re-sized against 3327 ms, not 5899** (§7a says to do exactly this).
- **The cold match still blocks ~3.4 s in one frozen gap** — the responsiveness problem is now that gap,
  not the total.

**Target device is a phone.** Judge every number in the 4× column; the desktop column is only there to
show how badly a desktop profile flatters us.

**§0 is the executable step list.** The rest of the document is the evidence and reasoning behind it;
if you only want to *do* the work, §0 is the whole thing.

---

## Where each section lives

**This doc was 2 231 lines and is now five.** Nothing was rewritten — whole sections moved, keeping
their numbers, so **`PLAN-PERF` §7e still means §7e**; this table says which file holds it. What stays
here is the spine: the step list, the one invariant, the baseline every number is measured against, and
the instrument discipline that decides whether a number may be believed at all.

| § | subject | file |
|---|---|---|
| **§0, §1, §2** | the step list, the ONE invariant, and the measured baseline | **here** |
| **§8, §9** | order, end state, residual | **here** |
| **§7e** + the 2026.8.0 store fixes | re-measurement, and the four times an instrument lied | **here** |
| **§4, §5, §7c, §7d, §7f, §7g** | getting loft out of the view path — the `expose` bridge and its cost | `docs/view-path-bridge.md` |
| **§6, §6b(2), §6c, §6d** | what a FRAME does, and how it got cheap | `docs/render-frame-cost.md` |
| **§3, §6b, §6b(3), §6e, §7** | the MATCH — a line that grows, on all the cores | `docs/match-performance.md` |
| **§7a, §7a(2), §7b, §7h, §7i, §7j, §7p** | where a COLD match's time goes: corridor, graph, search, and the route gate | `docs/cold-match-cost.md` |

---

## 0. The step list

Rules that make these steps safe, and that every row below obeys:

1. **One commit, one observable.** A step changes behaviour **or** structure — never both.
2. **All four gates stay green at every commit** (`make test`, `test-native`, `test-wasm`, `test-map`).
3. **Additive before subtractive.** New path lands *beside* the old one and is proved equal; only then
   does the old one go.
4. **Revert is one `git revert`.** No step leaves the tree needing a follow-up to be correct.
5. **Every step names the number it should move.** If the number doesn't move, the model is wrong —
   stop and re-measure rather than continue (`tools/map_profile.sh` after each).

| # | file(s) | change | verify | behaviour |
|---|---|---|---|---|
| **1** ✅ | `browser/cdp_profile.mjs`, `browser/store-app.mjs` | Label the existing match probe `matchColdFull`; add `matchWarm` (2nd click, one point added). | **DONE** — warm/cold = **0.91×**: adding one point costs 91% of a full rebuild. That equality is the bug, stated as a number. | none (test-only) |
| **2** ✅ | `browser/loop_probe.loft`, `browser/cdp_loop_probe.mjs`, `tools/loop_probe.sh` | **Probe:** `main()` loops on `host_input()`, `frame_yield()`s, keeps a counter, echoes. | **PASSED** — see §2a | none — **gated 4–8; they are GO** |
| **3** ✅ | `browser/read_probe.loft`, `tools/read_probe.sh` | **Probe:** is the store FILE the record image? Deliver a PTile; look for its bytes in the file. | **PASSED** — see §2b | none — **gated 9–13; GO, via `expose`** |
| **4** | `client/web_basemap_kernel.loft` | Wrap the existing body in `loop { cmd = host_input(); if cmd == "" { return; } … }`. Still one command per `loft_start`. | all gates green; profiler unchanged | **none** (structure only) |
| **5** | `browser/store-kernel.mjs` | Drive the loop: keep `loft_start` running, `loftPush` each command, resolve per output. | 2 commands in one `loft_start` → 2 outputs | none (app still sends 1) |
| **6** | `client/web_basemap_kernel.loft` | Move the two `store_load_url_trusted` calls **above** the loop. | 2nd command −355 ms (view) / −14 ms (match) | **perf only** |
| **7** | `client/web_basemap_kernel.loft` | Hold the corridor `Graph` across commands; rebuild only when the corridor changes. | 2nd match −~41% (`build_graph` gone) | **perf only** |
| **8** | `client/web_basemap_kernel.loft` | Hold `MatchState`; port `covered()` + `match_incremental` from `server/server.loft`. | **route byte-identical to the full match**; warm click ~10–20× cheaper | **perf only** (gate proves it) |
| **9** ✅ | `client/web_basemap_kernel.loft`, `browser/store-kernel.mjs` | `expose(EXPOSE_LAYOUT, layout)` per view command, **wrapped in the release/expose bracket** — loft's own `do_view_bbox` ITERATES the layout and an exposed store rejects the iteration cursor's claim (§7d(2)). The bare one-liner this row used to specify hangs the app; the additive form is `release` → load/emit → `expose`. Also added `loft_host_release` to the shim (a new host import `release` pulls in). | **DONE** — `tools/expose_probe.sh` green: `descLen=1955`, **17 descriptor nodes** naming `PTile`/`Area`/`Building`/`Line`/`Label`/`Poi`/`Coord`, `storeBase=29126376 rec=1 pos=8`, bracket balanced. View output **byte-identical** (`A=2252 B=16646 L=1231 P=4460 labels=1441 R=3112`); all five gates green. | none |
| **10** ✅ | `browser/loft-deliver.js` (vendored), `browser/loft-store.mjs`, `store-app.mjs`, `build-site.mjs` | Wire loft's own `readLoftValue` (vendored verbatim from loft `40daabd0`; the release does not install it) + a routing-side `flat*` accessor layer that indexes the pre-flattened keyed collection, so a caller can reach ONE element instead of materialising all 1089. `loft_host_deliver` was NOT needed — `expose` is the path, and `deliver` is its one-shot sibling. | **DONE** — `tools/deliver_probe.sh`: JS and loft agree on the whole line for tile 2047399103 — `ox=68300000 oy=521650000 areas=4 buildings=1 lines=0 labels=1 pois=0 ring0=17` — plus an interned text decoded (`"Meddelerweg"`) and the cheap `flatScalar` screen proven to agree with the full walk. | none |
| **11** ✅ | `browser/map.mjs`, `store-app.mjs` | `areasFromStore()` — reads **areas only** (not the other four kinds) through the bridge, mirroring `emit_areas` + `ring_hits` exactly, **beside** the text path. | **DONE** — `tools/deliver_probe.sh`: **A=2252 emitted · 2252 store hits · 2252 renderable · 2252 text-parsed**, 0 cover mismatches, 0 ring-length mismatches, `maxCoordDelta ≈ 5e-7` — *exactly* half a unit in loft's last printed decimal, so the geometry is identical and only the TEXT side is lossy. Zero order mismatches also proves the pre-flattened array is key-ordered the way `for t in layout` walks. | none (text still drives render) |
| **12** ✅ | `browser/map.mjs`, `store-app.mjs`, `cdp_verify_store.mjs` | Switch render to the store-read areas (`areaRenderList` mirrors `parseAreas`'s tail — same <3-vertex drop, same `minZoom`); keep the text emit as the **parity gate**, now asserted on the app's own view in `make test-map`, not only in the probe. | **DONE** — `✓ areas render from the store, 2252 == loft's 2252 text areas`; `# view:` counts unchanged. **⚠ Interim cost measured, see §7f: view total 927 → 1447 ms** — not step 12's read, but step 9's per-view `expose`, which re-flattens all 1089 tiles. Step 13 removes it. | **render source** |
| **13** ✅ | `map.mjs`, `store-app.mjs`, `map_kernel`, web kernel | Repeat 11–12 per kind (buildings, lines, pois, labels→places+streetLabels), then delete the layout text emit: `view` is now **roads-only** (`do_view_roads_bbox`). The full emit survives as the gate-only `viewtext` command so the parity reference does not die with it. | **DONE** — every kind store==text (`2252 · 16646 · 1231 · 4460 · 2 · 1439`). At `CPU_THROTTLE=4`: **kernel 1141 → 63 ms**, parse 202 → 12, text **4.25 MB → 398 KB**, empty-bbox view 483 → **21 ms**, and step 9's per-view `expose` bracket collapsed to one per session. **View total 1447 → 606 ms** (946 before the whole bridge). ⚠ **`storeRead` is now 468 ms of the 606** — see §7f. | one kind per commit |
| **14** ✅ | `browser/map.mjs`, **`browser/store-geom.mjs`** (new), `store-app.mjs` | **Its premise was half wrong — see §6c.** Landed as two orthogonal fixes: **14a** screen features by lat/lon bounds BEFORE projecting (the frame projected 214,455 vertices to draw ~7,000), and **14b** stop COPYING the store into JS at all — a `vector<Coord>` is already an interleaved `Int32Array`, so the renderer reads coordinates straight out of wasm memory. "Typed arrays" would have been the wrong fix: still a copy. | **DONE.** Quiet box, `CPU_THROTTLE=4`, spreads 1.1–1.5×: **view 277 → 126 ms**, **storeRead 129 → 29 ms**, **pan frame 64 → 20 ms**, retained objects **239,135 → 4,609**, JS heap 33.3 → 24.6 MB. Streets cannot come from the store (the matcher iterates it) but parse into a flat column instead. Gated on a canvas PIXEL HASH, identical (`c85280c8`) across every variant — counts cannot see a ring read at a wrong offset. | **perf only (pixel-identical)** |
| **15** ✅ | `browser/map.mjs` | Cache per-block rasters in WORLD-PIXEL space; blit on pan. | **DONE and ON — see §6d.** Pan frame **20 → 0.6 ms**; view 126 → 146 ms (one amortised bake). Bakes are bounded per frame after the first version made `view` 4× worse. Its difference from a direct render is fully accounted for: an origin-key bug (35,424 px, fixed), a latent POI edge-cull bug in the DIRECT renderer (fixed — a real app fix), and **canvas-size rasterisation rounding, which is a platform property** proven by a minimal control and cannot be removed. Gate is three equalities (cached==baked, data-load invalidates, labels exact) and one bound (maxDelta ≤ 16). | **visual: the origin snaps to a whole device pixel** |
| **16** ✅ | `lib/routing_kernel` + kernel, then `store-kernel.mjs` + `map.mjs` + `store-app.mjs` | **Stream per stretch** (§6b A): emit each `SubPath` as it is matched, `frame_yield()` between — **and render it**. | **DONE, in two halves.** *Frozen frame* (2026-07-22, first): the `frame_yield()`s broke the one un-interruptible block up — 3-point cold match worst gap **~4212 → ~1300 ms**. ⚠ **This row's original "40-point route, 39 stretches, worst gap 384 ms" is STALE and has been re-measured** — step 22 landed after it; see §6b(3). *Presentation* (2026-07-22, second): `runKernel` gained an opt-in line sink drained per yield in a microtask, and `map` grew `beginStretches`/`applyStretch`, so the line now GROWS in travel order on the app's own click path. Gated in `make test-map` on three non-timing assertions — `deliveries >= stretches`, `growSteps >= 2`, and the final ROUTE being an in-order **subsequence** of the streamed line — plus a DOM-free restart test in `map.test.mjs` (§6b(3)). Cost of the growing line, `CPU_THROTTLE=4`, two runs: **−125 ms (0.97×) and −245 ms (0.94×)** — not distinguishable from zero. See §6b(2). | **responsiveness + presentation** |
| **17** ⚠ | throwaway probe | **DONE but its CONCLUSION WAS WRONG** — kept only as the record of a mis-read. I read *"only the loop element may be a reference"* as "workers can't read captured state, put the data in the ELEMENT". loft's THREADING fix (`97af1b52`, my own finding) says the opposite: **large state is CAPTURED read-only and never passed** — only *extra scalar args* have that restriction. See §6b B, which is superseded. | — | none |
| **18** ⏸ | `lib/routing_kernel` + kernel | **DEFERRED — `par` is a no-op in THIS kernel, but loft's browser `par` has LANDED (@PLN117) and is verified (§6e, 2026-07-29).** ⚠ Do **not** wait for `tools/wasm_threads.mjs` to fail: that gate watches OUR artifact, which only gains threads once we add a reachable `par`, so it cannot announce a toolchain change — and until 2026-07-29 it could not even see a threaded wasm. The remaining gate is COOP/COEP on the deploy host. The app's wasm has `shared=false` and Rust's no-threads std linked in; loft's WASM (single) profile compiles `threading` OFF so `par()` runs Tier 1 (sequential), and Tier 2 needs COEP/COOP headers that GitHub Pages cannot set. Its own verify line says "~3× **native**" — i.e. the server, not this plan's subject. `tools/wasm_threads.mjs` gates the claim and fails the day it stops holding. Original note follows. **UNBLOCKED 2026-07-22 — design it.** `par` over the stretches (§6b B). The blocker was `clone_for_worker()` byte-copying every ACTIVE parent store per worker, so par's cost tracked the **session's live heap** (RSS ~175 MB) rather than the workload — 0→122 MB of *unrelated* heap took a fixed workload **2 → 205 ms**, and 1→16 threads took it **36 → 178 ms**. On the installed **2026.7.2** that is **flat**: 1–3 ms across 0 / 61 / 122 MB and across 1 / 8 / 16 threads, with `LOFT_PAR_SHARE` **unset** (sharing is now the default dispatch; upstream `ae0c266b`, "@PLN108 par-store single-impl"). Re-measured with the same `tools/par_copy_probe.loft` that reported the blockage, per this row's own unblock criterion. **Read §6b B, not step 17's row** — 17's conclusion ("put the data in the ELEMENT") was a mis-read; large state is CAPTURED read-only. | `tools/par_copy_probe.loft` stays flat vs heap; route byte-identical (`tools/match_parity.sh`); ~3× native on the stretch loop | **perf only** |
| **19a** ✅ | `lib/routing_kernel` | Replace the TEXT node-dedup key (`"{lat},{lon}"`, formatted per vertex of every way) with the fixed-point degrees packed into one i64. | **DONE** — cold match **3327 → 2721 ms** browser, 375 → 311 native; routes byte-identical (5 `match_parity` cases, and the §7a(2) border gate). Safe because the text key was proven INJECTIVE first (44,739 vertices → 33,948 distinct nodes under both keyings). No format change. | **perf only** |
| **19b** ⛔ | `tools/gen-tiles.loft` + kernel + **regenerate the stores** | Persist the **built graph** per tile (PLAN-TILES §268) and union it at match time. | **MEASURED AND REJECTED — §7a(2).** The union is only ~13–21% cheaper than building (it must still hash ~34k part-nodes vs 44.7k vertices, copy every edge, rebuild the CSR), so 19b is worth ~8% of a cold match for a format change, a redeploy, and the plan's riskiest row. The acceptance gate and the reference `union_graphs` are kept. | **not built** |
| **20** ✅ | `lib/routing_kernel` | Cell-tube corridor **beside** bbox; bbox still default. `tools/tube_probe.loft`. | **DONE** — drops 43–60% of the ways, read −40…−64%, **route identical** on all 3 sketches. See §7b. | **none** (inert) |
| **21** | — | Corpus compare: cheap vs fat tier on the §7 quality numbers. | the table that tunes the gate | none (offline) |
| **22** ✅ | kernel (`lib/map_kernel`) | Wire the §3 gate + escalation, **MARGIN-RELATIVE** (`bridged_m == 0 && dev_max <= corridor_margin * 6`) — the absolute `DEV_TOL` form was wired first and made the cold match 1.7× **slower** (§7h). Cell tube is tier 1, bbox is the floor; gated on the cold path only (`covered()` guards warm edits). | **DONE** — A/B on one quiet machine, `CPU_THROTTLE=4`, all spreads 1.1×: **cold 6370 → 3253 ms (1.96×)**, warm 880 → 584, repeat 450 → 306. Route **byte-identical on all 5 `match_parity` cases**; corpus **0 worse accepted** at K=6. ⚠ `server/server.loft` keeps its own match path and is NOT wired — see §7h. | **⚠ route-affecting — the only one** |

**Steps 2 and 3 are probes and come first**: each is an afternoon and each gates a block (2 → steps
4–8; 3 → steps 9–12). If a probe fails, that block is fiction and the fallback is named in its phase.

**Step 22 is the only row in this table that can return a worse route.** Everything else is subtraction
or a pure representation change. That is not an accident — it is why the ladder is last.

**Stop-and-think rows:** 6, 7, 8, 18, 19 each predict a specific drop. A step whose number does not move
means the model is wrong; re-measure before taking the next one.

---

## 1. The one invariant

> **Every interaction does work proportional to what CHANGED — never proportional to the size of the
> data. Never do everything again; build from what you have.**

Every number in §2 is a violation of it. That is the whole design: there is no clever algorithm here,
there is a stateless app repeatedly rebuilding a world that did not change.

The app **already knows how to obey it** — `server/server.loft` does: `covered()` + `match_incremental`
*"diffs `pts` against the cached MatchState and recomputes only the edited window"*, and lands a warm
edit in **40–68 ms**. The browser app **regressed that** when it went stateless: `runKernel` is a pure
function of its command string, so every click re-loads the stores, rebuilds the graph, and re-matches
the whole sketch from scratch.

**So the headline cost is not slow code. It is a full match on every click, when the sketch changed by
one point.**

---

## 2. The measured baseline — and what each number violates

`tools/map_profile.sh` (headless Chromium, `_site` over HTTP, enschede stores: 20 MB layout + 3.5 MB
roads, zoom 16, medians). `CPU_THROTTLE=4` ≈ a mid-range phone.

| what | desktop | **phone (4×)** | what changed | what it should cost | violation |
|---|---|---|---|---|---|
| **match** — full, per click | ~1040 ms | **4481 ms** | one point | one edited window (~40–68 ms warm on the server) | **rebuilds the whole match** |
| ├ store load (roads) | 5 | 14 | nothing | 0 | reloads a loaded store |
| └ compute | ~1035 | **4370** | one point | the edited window | full corridor + `build_graph` + full search |
| **view** — per pan past the box | 287 ms | **1121 ms** | the newly-exposed strip | that strip | re-emits the whole viewport |
| ├ store load (layout 341 + roads 14) | 90 | **355** | nothing | 0 | re-validates a static 20 MB file |
| ├ serialize | 124 | **544** | — | 0 (JS can read records) | formats coords into strings JS re-parses |
| ├ JS parse | 37 | **157** | — | 0 | undoes the line above |
| └ render | 22 | **76** | the camera | a blit | redraws every feature per frame |

Store load, split per command — the structural fact §4 turns on:

| store | size | `view` | `match` | phone load |
|---|---|---|---|---|
| **layout** | 20 MB | ✅ | ❌ **never** | **341 ms** |
| **roads** | 3.5 MB | ✅ | ✅ | 14 ms |

### And the app is FROZEN while it happens

`__perfHooks.frameBlocking` drives rAF across a kernel call and counts landed frames (4×):

| call | duration | frames landed | longest frozen gap |
|---|---|---|---|
| `view` | 925 ms | **6 of ~55** | **779 ms** |
| `match` | 4225 ms | **3 of ~253** | **4212 ms** |

The kernel runs synchronously on the UI thread, so the cost lands as one un-interruptible block: **the
phone is dead for 4.2 s.** Lag and cost are different problems — *cheaper work still freezes; the same
work on a worker does not.* Both need fixing, and obeying §1 shrinks what is left to move off-thread.

### 2b. Step 3's verdict — the store FILE *is* the record image (steps 9–13 GO, via `expose`)

`tools/read_probe.sh` delivers one PTile from a `store_load`ed layout image and looks for its bytes in
the file:

| check | result |
|---|---|
| PTile record present in the file **verbatim** | ✅ @ `0x0055af88`, 8-byte aligned (rec 701937) |
| fields read straight from the file bytes | `tkey=2047327105 ox=68600000 oy=521600000` — **identical** to loft's own output |
| `addr(rec,pos) = storeBase + rec*8 + pos` | works with **storeBase = 0** on the raw file |
| documented text interning (len at `id*8+4`, bytes at `id*8+8`) | **exact match** — "Buurserstraat" at string id 539252 |
| header magic | `"Sto1"` |

**HANDOFF's no-codec bet holds all the way to JS**: `store_load` *adopts* the image, it does not decode
into some other shape.

**But the root is not discoverable from the file alone — so use `expose`, not standalone parsing.**
`readLoftValue(mem, storeBase, desc, typeId, rec, pos)` is *handed* its entry point; it does not find
one, and the `"Sto1"` header/root layout is **not documented** in `doc/claude/`. Reverse-engineering it
to read the file with no loft at all would be fragile and needs an upstream ask. Unnecessary: loft
already ships the documented long-lived variant —

> `expose(tag, value)` — **LONG-LIVED: pins the value's store; read it each frame**

So the kernel `store_load`s the layout **once per session** (step 6) and `expose`s the root; JS then
reads PTiles **zero-copy from wasm memory** for the rest of the session. A warm pan pays **no load, no
serialize, no parse** — the same end state as standalone file reading, using only shipped, documented
API. The 341 ms load becomes a one-time startup cost instead of a per-pan one, which is what §1's
invariant asks for anyway.

*(The standalone-file path stays a live option — the bytes are provably right — and flips to attractive
if loft ever documents the header, or if startup load must be zero too.)*

### 2a. Step 2's verdict — loft CAN own the loop (steps 4–8 are GO)

`tools/loop_probe.sh` — a `--html` kernel whose `main()` loops on `host_input()` and `frame_yield()`s
between commands, driven with four commands in a real headless browser:

```
echo=alpha   count=1 polls=0
echo=bravo   count=2 polls=149
echo=charlie count=3 polls=222
echo=quit    count=4 polls=294
```

| question | answer |
|---|---|
| does state persist across commands? | **YES** — `count` 1→2→3→4. `main()` never returns, so `loft_start` never re-enters and never rebuilds the Stores. |
| does the frame keep painting while loft waits? | **YES** — 145 rAF frames during ~2.4 s of polling. |
| is it yielding or hard-spinning? | **yielding** — `polls` climbs ~60–70 per 1.2 s wait ≈ **one poll per frame**, exactly the gather-until-enough contract. |

**Cost to the shim: exactly one import.** The probe's wasm requires `loft_io` (`loft_host_print`,
`loft_host_input_len`, `loft_host_input_copy` — `store-kernel.mjs` already provides all three) plus
**`loft_web: ws_yield`**, which it does not. Exports are identical to the store kernel (`memory`,
`loft_start`, `asyncify_*`), so `ws_yield` suspends through the AsyncifyCtrl that already exists for the
fetch. Note `frame_yield` moves the build to loft's **full engine shell** (273 KB page / 174 KB wasm vs
the minimal engine-less one) — a size cost to measure at step 5, not a blocker.

### Two premises this falsified

**"The text bridge is the front-end bottleneck"** (`docs/loft-binary-bridge.md`, which asked loft for
@PLN105 `deliver`, and loft shipped it): JS parse is **157 ms of 1121** and `match` emits **4 KB**, so the
bridge saves a click *nothing*. The premise was true when `view` emitted the whole region; `199e7c7`
(viewport-scoped view) already fixed it.

**"loft must be in the view path":** `view` does no computing — it is `ring_hits()` (an integer bbox
compare) plus `ring_text()` formatting. The store is its own serialization (HANDOFF's no-codec bet), so
JS can read the records. **loft does the ROUTE; JS does the MAP.**

---

## 8. Order and end state

```
S0 probe (~20 lines): can a --html kernel own the loop + frame_yield and keep state?
        ↓                                   ← gates S1–S4. If it fails, everything below S changes.
S1 loop + stores  →  S2 hold Graph  →  S3 hold MatchState (parity gate)  →  S4 view diff
        ↓                                   ← THE BUG: the app uses loft's REJECTED one-shot model
A1 probe: can JS read the fetched image?   →   A1–A5 — loft out of the view path
        ↓
R1–R2 (render budget — independent of loft, can land any time)
        ↓
C0 (trust the number)  →  C4 (persist the graph — route-neutral)  →  C1–C3 (the ladder)
                                             the outlier gets a budget too: ≤ ~500 ms
```

Every step is one commit, independently verifiable and revertible; each keeps all four gates green.
Two probes (S0, A1) come first because each gates a whole phase and each is an afternoon.

| interaction | today **phone** | after S | after S+A | after S+A+R |
|---|---|---|---|---|
| **click** (add/move a point) — *time* | **4481 ms** | **~200 ms** | ~200 ms | ~200 ms |
| **click** — *frozen* | **4212 ms** | **~0** (frame_yield) | ~0 | ~0 |
| **pan** (past the box) — *time* | 1121 ms | new strip only | **~150 ms** | ~150 ms |
| **pan** — *frozen* | 779 ms | **~0** (frame_yield) | ~0 | ~0 |
| **pan** frame rate | ~13 fps | 13 fps | 13 fps | **60 fps** (R) |
| **cold full match** (rare, but still needs a budget) | **4481 ms** | 4481 ms | 4481 ms | **~500 ms** (C4 + ladder) |

**S is the whole game**, and it unfreezes the page as a side effect: it takes a click from 4.5 s to
~200 ms by not doing the work, and the frame_yield contract keeps the UI live meanwhile. It invents
nothing — it adopts loft's intended model (proven by `ztclient`) and ports the incremental matcher the
server already runs.

**Re-run `tools/map_profile.sh` after every step**, and fix its labelling first: it currently reports a
cold full match as "match", i.e. it measures the outlier as if it were the common case. Add a warm/
incremental row — that is the number the app lives or dies on.

---

## 9. Residual

- **A real phone.** CDP throttling scales CPU only — not memory bandwidth, cache, or GC. It says the
  ranking holds; a real device is what settles it. Cheap: `chrome://inspect` against `_site`.
- **Memory.** The phone's real limit may be RAM, not CPU (20 MB layout + wasm heap on a tab that gets
  evicted). A deletes that allocation. Nothing measures RSS.
- **Cold fetch.** The 341 ms is validation of an HTTP-*cached* store; a first visit adds download.
- **Session history.** C0's 3× spread suggests earlier work affects later cost — worse on a phone.
- **Zoomed-out viewports**, where the emit re-inflates and A's win grows.


## §7e — Re-measurement on 2026.7.2 (2026-07-22), and the blind probe it exposed

`CPU_THROTTLE=4`, `tools/map_profile.sh`, runs that agree within ~5%. **What still holds:**

- **The session holds** — `loft_start` entered **1× for 47 commands**, **2 store fetches for 47 commands**.
  Steps 5–6 are live and working exactly as documented.
- **Streaming holds** — a real 40-point route: **39 stretches, longest frozen gap 384 ms** (was 11095 ms).
- **View** — kernel 706 ms, first view 1286 ms vs 946 ms after, i.e. the 341 ms store load is paid once.

### The "warm 1.79× cold" scare — RETRACTED the same day. The instrument was blind.

**First reading (wrong):** warm 840 ms vs "cold" 470 ms was written up here as an *inversion of step 8's
premise*. **There is no regression.** The probes had swapped meanings while keeping their names.

**Why.** `matchColdFull` was written at step 1, when the app was stateless and every match really was
cold. **Step 6 gave the app a persistent session and silently invalidated it**: the profiler sends the
same sketch 6× into a session that now survives, so every iteration after the first measured the
*nothing-changed* case — while still being labelled "cold". The ratio was warm ÷ **repeat**, which is
*expected* to exceed 1: moving a point is more work than changing nothing.

**The calibrated reading** — `tools/match_session_probe.loft`, native, honest labels, plus the corrected
browser harness:

| interaction | native | browser (phone 4×) |
|---|---|---|
| **COLD** — session dropped: corridor + `build_graph` + full seed | 750 ms | **6119 ms** |
| **REPEAT** — identical sketch, nothing changed (the floor) | 58 ms | 442 ms |
| **MOVED** — one point ~20 m (what users do) | 123 ms | 844 ms |
| **warm ÷ TRUE cold** | **0.16×** | **0.14×** |

Step 8's premise is **confirmed on both backends**: a moved point costs ~14% of a cold match. The two
independent measurements agreeing to 0.02 is the calibration.

**What the fix bought — a number nobody had.** A genuinely cold match on a phone is **~6.1 s**. It was
invisible for two months because nothing measured it: the probe that claimed to had stopped being cold.
That is now the largest user-visible cost in the app (a first click, or a sketch leaving the corridor) and
it is exactly what steps 19–22 target — so this *strengthens* the plan's ordering rather than upsetting it.
Do **not** compare it against the historical 4481 ms: that was a different profiler on the pre-session
model, and no before/after exists on one binary.

**The instrument changes** (all landed):
- `client/web_basemap_kernel.loft` — a `reset` command drops the session so a cold match can be timed
  without also re-fetching the stores (which would charge it a 355 ms decode it never really pays).
- `browser/store-app.mjs` — `matchTrueCold` (resets first), `matchRepeat` (honest name for what
  `matchColdFull` actually measured), `matchWarm` unchanged.
- `browser/cdp_profile.mjs` — reports warm ÷ TRUE-cold as the headline, prints warm ÷ repeat with an
  explicit *"expected to be >1, do not read as a regression"*, and carries the native reference inline.
- `tools/match_session_probe.loft` — the native ground truth to check the browser against.

**The lesson, and it is the reusable half.** A probe's *name* is an assertion about the state it runs in,
and a later step can falsify that assertion without touching the probe. Step 6 was additive and correct;
it still broke a measurement two files away. **When a ratio implies a subsystem is broken, calibrate the
instrument before believing it** — here, reading the harness took two minutes and the native probe ten,
against a wrong entry in this plan that would have sent someone into `match_incremental` after a bug that
does not exist.

### The "C0 confound" — also wrong, and also the session. Fixed; the real freeze is now visible.

I guessed the 5651 ms / 5292 ms frozen gaps were the wasm `memory.grow` (188.9 MB) leaking into sections
that start before the plateau. **Wrong — third fragment-based hypothesis of the day to fail.** `warmup()`
already reaches the plateau before any of them, and `reset` does not free linear memory, so growth was
never in those cells.

**It was session-state contamination again, one probe inheriting the previous one's corridor:**
`matchExtend` runs 5th and leaves the *extended* corridor; `streamProgressN` then builds a **straight-line
interpolation** — different geometry from the standard sketch — so it misses and rebuilds; the 40-point row
is then covered by the corridor the 3-point row just built; and `frameBlocking('match')` sends the standard
sketch into the straight-line corridor and misses again. Every one of those cells was timing an
*unannounced cold rebuild*.

**Fixed** by making each probe declare its entry state (`reset` first for the cold cases; a new
`matchWarm` blocking case that establishes the corridor first). Deterministic now:

| case | total | longest frozen gap |
|---|---|---|
| view | 738 ms | 739 ms |
| **match — COLD** (session dropped) | 6477 ms | **2994 ms** |
| **match — WARM** (one point moved) | 730 ms | **451 ms** |
| density, COLD: 3 pts → 2 stretches | 6180 ms | 2734 ms |
| density, COLD: 40 pts → 39 stretches | 9629 ms | **1802 ms** |

**What this says, and it is a better target than the guess it replaces.** The warm path — the common
interaction — blocks for **451 ms**. The freeze that remains is the **cold rebuild**, and step 16's
per-stretch streaming cannot reach it: on a cold match the ~3 s is spent in `tiles_corridor_ways_streamed`
+ `build_graph_streamed` **before the first stretch exists**. More points break the gap up (2734 → 1802 ms)
but cannot remove it, which is exactly the signature of a floor that lives in the pre-stretch phase and is
independent of stretch count.

So the cold-match freeze is one problem with two live remedies already in this plan — **step 19** (persist
the built graph: no `build_graph` at all) and **step 20** (the cell-tube corridor, measured to drop 43–60%
of the ways, already landed and inert). It is not a new work item.

**One thing to re-measure, not to trust:** `4cc84f8` recorded *"TICK_EVERY measured FLAT — don't tune it;
the ticks aren't what bounds the gap"*. That measurement was taken on the contaminated instrument, so it
may have been reading a cold rebuild it did not know it had. Re-run it against the fixed probes before
relying on it either way — I am not asserting it is wrong, only that it is unanchored.

---

## The 2026.8.0 store fixes — what they cost and what they bought

⚠ **Anchored to the binary, per CLAUDE.md.** `/usr/local/bin/loft` is **2026.8.0**, md5
`ea0486770b1ed2d703f4a5187d3b1b0f`, dated **2026-08-02 12:50** — and it is **byte-identical** to
`../loft/target/release/loft`, whose log carries loft#729 (three commits), #730 and #731, landed
10:10–12:36 the same day. It is **not** the binary HANDOFF describes (md5 `13311104…`): that one moved
under us.

> **INHERITED AND RE-MEASURED HERE, 2026-08-02.** The kernel was rebuilt on this binary
> (`browser/store-kernel.wasm`, sources hash unchanged at `221ac6fbd28d…` — the toolchain is the only
> variable) and two of upstream's claims were re-run on this box, on our own data:
>
> | claim | measured here |
> |---|---|
> | run coalescing removes round-trips, byte-neutral | the app's paged roads read: **33 → 29 range reads for the same 2.0 MB** (`map_render_gate`, old wasm vs new, same store) |
> | binding a block compacts it, content unchanged | `nl-east.roads.store` **161 793 096 → 81 271 776 (1.99×)**, 5 008 tiles / 822 452 roads read back, and a full `census` of **all 23 categories is identical** (`tools/store_compact_probe.loft`) |
> | the upgrade changes no route | `match_parity.sh` **byte-identical on all 5 cases, 3 distinct routes**; the browser gate's route is unchanged (`len=12428.0m`, 199 pts) on both wasms |
>
> ⚠ **Anything that binds a block now rewrites it, smaller.** That is the fix working, not a hazard — but
> it means the next generator run over `blocks/` silently halves those files, and a *published* block
> only shrinks when it is re-bound and re-uploaded. The blocks in this tree are **not** re-bound yet.

Everything below is upstream's own measurement **on our own `nl-east.roads.store`**; the rows not marked
above still need re-measuring here before they are written into any status doc.

| upstream change | measured on our block |
|---|---|
| **#729** read a record's body in one fetch (not 4 bytes at a time) | 1 073 065 resolve calls → **832**; a wide viewport loads **0.32 s → 0.16 s**; bytes identical |
| **#729** one request per **run** of pages | 42-key viewport **89 → 56 requests**, same bytes |
| **#729** a working set is sized by what it holds, not what it grew to | 42-tile working set **4.89 MB → 2.20 MB (2.22×)** — browser memory, per viewport |
| **#730** compaction at bind, automatically | file **161.8 → 81.3 MB (1.99×)**; 42-key viewport 4.92 → 3.67 MB (69 → 52 req); **wide viewport 31.1 → 22.3 MB, 466 → 332 req** |
| **#729** page size is now a real choice | 16 KiB: **−19% bytes and −8% requests** on a 42-key viewport; the wide viewport trades 46% fewer bytes for 35% more requests. Default stays 64 KiB — *the consumer's own viewport mix decides it, and that consumer is us* |
| **#731** a collection declared **and** iterated inside an `else if` compiles on `--native` | the mode-driven generator shape (`if mode == "write" … else if mode == "load" …`) is writable again |

**What it means for this design.**

* **The floor got cheaper to hold** — a working set is 2.2× denser, so §5's resident index competes with
  less pressure, and the fine layer costs less to re-page after the pan the floor is covering.
* **The pan itself got cheaper** — a wide viewport is 332 requests instead of 466 and 22.3 MB instead of
  31.1, before anything in this plan is built.
* **`LOFT_PAGE_BYTES` is now ours to choose.** The app's mix is *many small viewports* (a pan) plus *one
  wide one* (a band crossing) — precisely the two rows that disagree in the table. It is a measurement
  step, not a knob to guess: §7 P6.
* **⚠ Two conditions, or none of it lands.** The reader fixes live in the **wasm runtime**, so
  `browser/store-kernel.wasm` must be rebuilt with this binary; the file-size half only appears when the
  blocks are **re-bound and republished**. A green gate on an old wasm proves nothing about either.
* **⚠ It does NOT change the whole-vs-paged rule.** Nothing in #729–#731 touches how a working set is
  composed, so §5's falsified alternative stays falsified and the resident floor stands on its own.

**Out of scope here, worth costing after step 13:** the blocks halving moves the ceiling that
Western-Europe publishing runs into (§6f / D2 — the site outgrows Pages before the read path breaks).
That is a re-costing, not a design change, and it belongs in PLAN-SCALE.

---

### What it did to the published data (2026-08-02)

Applied to the regenerated country, compaction at bind more than pays for the route table the same
regeneration added:

| region | v1 published | v2 raw | v2 compacted |
|---|---|---|---|
| nl-west | 99.4 MB | 104.0 MB | **53.6 MB** |
| nl-midwest | 122.9 MB | 129.1 MB | **62.6 MB** |
| nl-mideast | 102.0 MB | 108.5 MB | **55.2 MB** |
| nl-east | 154.3 MB | 166.0 MB | **84.2 MB** |
| **total** | **478.6 MB** | 507.6 MB | **255.5 MB — 0.53×** |

⚠ **Anything that binds a block now rewrites it, smaller.** That is the fix working, not a hazard — but
the next generator run over `blocks/` silently halves those files, and a PUBLISHED block only shrinks when
it is re-bound and re-uploaded. `tools/store_compact_probe.loft` is the measurement, and it REWRITES what
it is given: point it at a copy.
