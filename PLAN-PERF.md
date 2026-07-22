<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-PERF — making the standalone app fully performant

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
| **cold match** (first click / corridor miss) | 6370 ms | **1539 ms** | 4.1× — §7h(2), §7a(2), §7i–k |
| **warm match** (one point moved — what users do) | ~880 ms | **358 ms** | 2.5× — §7i–k |
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
- **18 is ⛔ DO NOT BUILD** — `par` is a no-op in the browser (§6e), proven from the shipped wasm.
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
| **18** ⛔ | `lib/routing_kernel` + kernel | **DO NOT BUILD — `par` is a NO-OP in the browser (§6e).** The app's wasm has `shared=false` and Rust's no-threads std linked in; loft's WASM (single) profile compiles `threading` OFF so `par()` runs Tier 1 (sequential), and Tier 2 needs COEP/COOP headers that GitHub Pages cannot set. Its own verify line says "~3× **native**" — i.e. the server, not this plan's subject. `tools/wasm_threads.mjs` gates the claim and fails the day it stops holding. Original note follows. **UNBLOCKED 2026-07-22 — design it.** `par` over the stretches (§6b B). The blocker was `clone_for_worker()` byte-copying every ACTIVE parent store per worker, so par's cost tracked the **session's live heap** (RSS ~175 MB) rather than the workload — 0→122 MB of *unrelated* heap took a fixed workload **2 → 205 ms**, and 1→16 threads took it **36 → 178 ms**. On the installed **2026.7.2** that is **flat**: 1–3 ms across 0 / 61 / 122 MB and across 1 / 8 / 16 threads, with `LOFT_PAR_SHARE` **unset** (sharing is now the default dispatch; upstream `ae0c266b`, "@PLN108 par-store single-impl"). Re-measured with the same `tools/par_copy_probe.loft` that reported the blockage, per this row's own unblock criterion. **Read §6b B, not step 17's row** — 17's conclusion ("put the data in the ELEMENT") was a mis-read; large state is CAPTURED read-only. | `tools/par_copy_probe.loft` stays flat vs heap; route byte-identical (`tools/match_parity.sh`); ~3× native on the stretch loop | **perf only** |
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

## 3. Phase S — stop using loft's REJECTED model (the bug)

**The root cause of every number in §2 is one architectural choice, and loft's own docs already reject
it.** `BROWSER_INTEROP.md` § *Rejected alternatives*:

> **Export loft `pub fn`s as wasm exports + a JS→loft call ABI** (the *"JS renders, loft computes"*
> compute-core model)… **Set aside because this model does not need them: loft owns the loop and the
> synchronicity lives inside the library via the yield.**

That is precisely what `browser/store-kernel.mjs` does — `runKernel(blob)` per request, one `loft_start`
per click, *"fresh Stores each call"*. **The app is built on the alternative loft rejected**, and both
symptoms fall straight out of it: no session (⇒ a full match per click) and a synchronous call on the UI
thread (⇒ a frozen frame).

**The intended model is shipped and proven.** § *"Pretend to be synchronous" — the gather-until-enough
contract*: loft owns the loop; a function gathers inbound bytes across as many frames as it takes and
returns the finished unit; the yielding is invisible to the caller. *"This is **already proven** — the
zero-trust `ztclient` transport does exactly it: `poll_for` loops `try_recv()` and calls `frame_yield()`
each pass."* `frame_yield()` ships in `web` (`loft-libs-net/web/src/web.loft:407`).

It gives **both** things this document needs, from one change:

| problem | how the loop model solves it |
|---|---|
| no session ⇒ full match per click | `main()` never returns, so stores / graph / MatchState live in its locals across commands. `loft_start` cannot reset what it never re-enters. |
| frozen frame | *"The single load-bearing rule: 'blocking' must mean yield-and-accumulate, never a hard spin"* — `frame_yield()` hands the frame back, so **the engine keeps rendering and taking input while loft waits**. |

**Invariant:** *loft owns the loop; state lives across commands; every wait yields the frame.*

**Re-assertion sites: 1** — the kernel's gather loop. Omission is loud (a hard spin freezes the page —
exactly issue #450's repro, which the yield contract exists to prevent).

| step | change | verify | revert |
|---|---|---|---|
| **S0** | **Probe, no product change.** ~20-line `--html` loft: `main()` loops, `frame_yield()`s, keeps a counter, echoes each command. Drive it with 3 commands. | counter persists across commands **and** rAF keeps firing during the wait | delete the probe |
| S1 | Kernel `main()` becomes the gather loop; stores loaded once into its locals. No algorithm change. | 2nd command drops ≈355 ms (view) / ≈14 ms (match); `frameBlocking` shows frames landing | one commit |
| S2 | Hold the corridor `Graph` across commands (built once). Still a full match. | 2nd match skips `build_graph` (~41% per PLAN-MATCH's split) | one commit |
| S3 | Hold `MatchState`; port `covered()` + `match_incremental` from `server/server.loft` — **it exists; do not rewrite it.** | **parity gate: incremental route == full-match route, byte-identical**; a one-point click ~10–20× cheaper | one commit |
| S4 | `view` re-emits only newly-exposed cells. | a small pan costs ≈ the new strip | one commit |

**S0 is the whole risk.** If a `--html` kernel cannot own the loop and yield (an asyncify constraint, a
`web`-lib dependency the store kernel does not have), S1–S4 are all fiction and the fallback is an
upstream ask. It is ~20 lines and it gates four phases. **Run it first.**

**Predicted (phone):** click **4481 → ~200 ms**, and the frozen gap → ~0 *without a Web Worker*.
**Falsification probe for the size:** the server's 40–68 ms is a *desktop, native* number over a tile
block. Land S3 alone and measure one warm click on the phone profile before designing S4 around it.

**Risk:** state goes stale (a moved point invalidating a cached window). `server/server.loft` already
solved this — `covered()` **is** that guard. Port its logic; do not invent a second one. The parity gate
in S3 is what proves the port.

---

## 4. Phase A — get loft out of the view path (~900 ms of 1121)

**Invariant:** *JS reads the layout records; nothing serializes them to text.*

The layout store is **view-only** (match never loads it) and view is a bbox filter, not computation. So
loft has no role: JS fetches the image and reads the records.

**Re-assertion sites:** 1 per feature kind (areas / buildings / lines / labels / pois = 5). Omission is
**loud** — a kind not read is a kind not drawn.

| step | change | verify |
|---|---|---|
| A1 | **Probe the enabling claim** (below). | one PTile read in JS == the kernel's text for that tile |
| A2 | Bake the layout descriptor at build time (`LayoutDesc::to_json` — static per type). | descriptor emitted; JS loads it |
| A3 | JS reads ONE kind (areas) from the fetched buffer; kernel text path still runs; compare. | JS-read == text-parsed, feature-for-feature |
| A4 | Remaining 4 kinds; delete the text emit per kind as each is proven. | `# view:` counts identical; parse → 0 |
| A5 | Drop the layout store from the kernel command entirely. | kernel only ever loads roads (14 ms) |

**Predicted (phone):** view 1121 → **~150 ms**, then render (76 ms) is the floor — hence §6's render work.
**Falsification probe (A1 — run before anything in this phase):** fetch `enschede.layout.store` in JS,
hand `readLoftValue` (`doc/loft-deliver.js`) the fetched `ArrayBuffer` with the right `storeBase`, read
one known PTile. If it reconstructs the kernel's `cover`/ring, the phase is real. **If `store_load`
relocates/interns on adopt, A is dead as written** and the fallback is @PLN105 `deliver` (which reads the
*adopted* image and still pays the 341 ms) — worth ~700 ms instead of ~900 ms. One probe, 10× vs 1.8×.

**Risk:** JS then owns the layout format, so a store-format change (cf. loft#513) breaks the renderer
silently. Keep the kernel's text emit as a **test-only** path and gate `JS-read == kernel-text` in
`make test-map` — the parity gate IS the format guard.

**Note:** A also deletes loft's 20 MB allocation — on a phone the binding constraint may be **RAM, not
CPU**. Nothing here measures RSS; it should.

---

## 5. Phase B — validate at WRITE, not per redraw

Mostly subsumed by S1 + A, kept because the ask is upstream and worth filing properly.

`store_load_url_trusted` skips the SHA pin but is *"still structurally validated"* — 341 ms re-deriving
at **read** time a property the **generator** knew. The integrity fact belongs where the bytes are
written: `tools/gen-tiles.loft` / the store builders stamp a checksum; the reader verifies it once.
loft has the shape (`store_load_url(r, url, sha256)`); it lacks **"checksum-verified ⇒ skip the
structural walk"**. *Measure before filing:* SHA-256 over 20 MB may not beat a 341 ms walk — the ask is
probably a **cheap** checksum (CRC32/xxhash) stamped at write.

---

## 6. Phase R — the render budget

> **A Web Worker was here, and it was wrong.** An earlier draft proposed moving the kernel to a worker to
> unfreeze the page. That is loft's *rejected* model wearing a thread: it solves the freeze by routing
> around the yield contract instead of using it. **S's gather loop already unfreezes the page** —
> `frame_yield()` hands the frame back, *"so the engine keeps rendering and taking input while the library
> waits."* Deleted rather than demoted, because keeping it would have had us build a worker to fix a
> problem loft solved. *(It flips only if a wait genuinely cannot yield — e.g. a single un-splittable
> compute longer than a frame. Then the fix is to yield **inside** the compute, not to move it.)*

What is left is real and independent of loft: **`render` is 76 ms/frame on a phone ⇒ ~13 fps panning
with no kernel call at all.** Panning is laggy on its own.

**Invariant:** *a frame redraws only what the camera changed.*

| step | change | verify |
|---|---|---|
| R1 | Pre-project geometry into typed arrays once per view, not per frame. | render drops; pan frame time falls |
| R2 | Cache per-tile rasters; blit on pan, re-raster only newly-exposed tiles. | pan holds <16 ms/frame |

Same invariant as §1 — *work ∝ change* — applied to the frame. R is independent of S/A/C and can land
any time.

---

## 6b(2). The growing line — was EMITTED but not RENDERED; **DELIVERED 2026-07-22**

**The gap this section recorded is closed.** Kept in full because the *shape* of the mistake is the
reusable part: an emit that nothing consumes reads exactly like a delivered feature from the loft side,
and only a gate on the *consumer* tells them apart.

**What was wrong.** The kernel half shipped in step 16 and worked: each `SubPath` is emitted as
`STRETCH i;…` the moment it is matched, with a `frame_yield()` between, and that is what turned a
40-point route's worst frozen gap from **11095 ms into 384 ms**. But `runKernel(blob)` resolved a single
promise on `#EOR`, so JS received the *whole* response at once and `map.loadMatch(text)` drew only the
final `ROUTE`. Nothing in `map.mjs` or `store-kernel.mjs` read a `STRETCH` line — only the profiler
counted them. The yields delivered **responsiveness** (the page kept painting), not **progressive
arrival** (a line that grows). §6b's "it mimics the journey" and DESIGN §5's travel-order requirement are
claims about what the *user sees*, and the user saw nothing until the match completed.

**What delivers it** (two commits, driver then renderer):

1. `runKernel(blob, lineSink)` — an **opt-in** sink drained at each `frame_yield()`, in a **microtask**.
   The microtask is the load-bearing detail: it runs after the asyncify unwind returns to the event loop
   but *before* the browser paints, so a stretch drawn there lands in the very frame the yield handed
   back. Draining inside the import would run the sink mid-unwind; draining in the `setTimeout` wake
   would put it after the paint. Opt-in keeps the `view` path (~400 KB per response) paying nothing, so
   the driver's "never scan per print" rule survives — the scan is per YIELD, not per print.
2. `map.parseStretch` + `beginStretches`/`applyStretch`, with the click handler and `window.__match` both
   routed through one `streamedMatch()`.

**The index in `STRETCH <i>` is not decoration.** A warm edit replays *every* stretch, cached ones
included (`update_state` calls `on_stretch` on the reuse branch too), so a slot — not an append — is what
makes a re-match redraw instead of concatenating onto the previous route.

**Two rendering decisions, both consequences of §1:**
- **Work ∝ the route, not the map.** A full `render()` per stretch redraws every area, building, road and
  label — ~74 ms at `CPU_THROTTLE=4`, 39× on a real sketch — for a line that grew by ~50 points.
  `applyStretch` strokes the polyline onto the existing canvas and leaves `route` authoritative, so any
  later full render (a pan, the final `loadMatch`) still draws it correctly and at the proper z-order.
- **Re-stroke the accumulation, not the new piece.** The route is a white halo *under* a blue core, so
  stroking one stretch alone paints its halo over the previous stretch's core and leaves a **white notch
  at every joint**. Stroking the accumulation has no seam. Two transients are accepted for it: the halo
  composites toward opaque after ~3 stretches (85% when re-rendered), and a streaming stretch sits above
  the labels. Both end at the final render.

### The gate is three assertions, and none of them is a timing

Counts and exact equalities only, so a loaded machine cannot move them either way:

| assertion | what it kills |
|---|---|
| `deliveries >= stretches` | a buffered response delivers **once** however many stretches it carries — this is unreachable unless each stretch crossed into JS mid-match |
| `growSteps >= 2` on the **app's own** `streamedMatch` | a regression that reverts the app to "draw once at `#EOR`" while leaving the driver *able* to stream |
| the final ROUTE is an in-order **subsequence** of the streamed line | the growing line drawing a path the route never took |

**Containment is the load-bearing one, and point counts could not have replaced it.** loft stitches the
same sub-paths with `push_pt` and then `remove_spurs`, and both only ever DROP points — so the finished
route is *shorter than the stream by construction* and "same length" would be the wrong assertion.
Every ROUTE point appearing in the stream, in order, is the exact statement that survives that.

### ⚠ What the gate then surfaced: `remove_spurs` prunes ~60% of the raw stitch

Measured on the gate's own sketches: **537 streamed → 198 final** (10-point) and **431 → 213** (3-point).
So the growing line carries roughly 2–2.7× the points of the route it becomes, and **visibly tightens
when the match completes** — the excursions the user watched being drawn are pruned at the end.

This is **pre-existing matcher behaviour, not introduced by the streaming** — it was simply never visible
before, because nobody ever saw the pre-`remove_spurs` stitch. Two things follow, neither urgent:
- the delivered feature is honest but not seamless, and that is now documented rather than discovered by
  a user;
- a per-stretch assembly that doubles back over half its points is a **match-quality signal** worth a
  look (PLAN-MATCH §7's numbers are computed per stretch during assembly, so they see the pre-pruned
  path). Not a defect proven here — a number that did not have a reader until now.

## 6c. Steps 14–15: the split was in the wrong place (2026-07-22)

Step 14 said *"pre-project geometry into typed arrays once per view, not per frame."* Half of that was
right. The half that was wrong is the half that mattered, and the measurement is what said so.

### What a frame was actually doing

| | measured, app's own viewport |
|---|---|
| vertices projected per frame | **214,455**, to draw ~7,000 features |
| buildings drawn / loaded | **1,895 / 16,646** — ~89% of the projection discarded |
| projection as a share of the frame | **82%** (52 ms of 64 at `CPU_THROTTLE=4`) |
| JS objects retained between frames | **239,135** |
| JS heap retained | **33.3 MB** |
| the same geometry, flat | **1.64 MB** (`Int32Array` at deg×1e7) |

Two independent faults, on **orthogonal axes** — which is why fixing one did not hide the other:
**how many** features are touched (culling), and **what it costs to touch one** (layout).

### 14a — screen before projecting

Every draw loop projected a feature's whole ring and only then asked `_inView`. A per-feature lat/lon
bbox, built once per layer, screens first. Pixel-identical because `_inView` keeps a feature iff some
VERTEX is in the padded viewport, and the screen is that same rectangle unprojected — so it is a
conservative **superset** and can only skip work already discarded.

⚠ **For areas the bbox test is the only CORRECT cull**, not merely the cheaper one. Areas are filled and
deliberately had no cull: a polygon containing the whole viewport has no vertex on screen yet paints
every pixel of it. Culling areas by `_inView` would erase lakes and forests exactly when zoomed inside
one. Containment implies bbox overlap, so bounds keep them.

### 14b — the split: JS was COPYING the store out

`viewFromStore` re-materialised a viewport as JS objects — `readLoftValue` turning every struct into an
object, `degRing` exploding every vertex into a boxed `[lat, lon]`. The `expose` bridge exists so JS can
*read* the store; copying it out gave that back and cost 33 MB and a quarter-million GC-traced objects.

**Converting those objects to typed arrays would have been the wrong fix** — still a copy, just a cheaper
one. The store already holds the ideal layout, and the probe proves it rather than assuming it:

```
Coord: kind=record, size=8, fields x@0 (int), y@4 (int)
a 74-coord ring read as Int32Array(mem.buffer, base, 74*2) vs loft's own reader: 0 mismatches
```

loft-deliver stores struct vector elements **inline** at `storeBase + vRec*8 + 8`, stride `sizeOf(elem)`,
so **a `vector<Coord>` IS an interleaved `Int32Array`**. `browser/store-geom.mjs` therefore builds a
per-view *index* — per feature: ring record, length, tile origin, fixed-point bounds, ~37 bytes — and each
frame derives one `Int32Array` over wasm memory and reads coordinates where loft wrote them.

### The numbers

Quiet box (load 1.03), `CPU_THROTTLE=4`, medians of 6, spreads 1.1–1.5×:

| | before | after | |
|---|---|---|---|
| **view total** | 277 ms | **126 ms** | 2.2× |
| **storeRead** | 129 ms | **29 ms** | 4.4× — *no copy, not a faster copy* |
| **render** (view) | 73 ms | **26 ms** | 2.8× |
| **pan frame** | 64 ms | **20 ms** | 3.2× |
| **projection's share of a frame** | 82% (52 ms) | **4% (1 ms)** | over 3,170 vertices, not 214,455 |
| retained vertices | 214,455 | **3,170** | −98.5% |
| retained objects | 239,135 | **4,609** | −98.1% |
| JS heap | 33.3 MB | **24.6 MB** | −8.7 MB |

The heap did not fall by 30 MB because 33.3 MB was never all geometry — the rest is kernel buffers, the
view text, the descriptor and Chrome's own overhead. The 7.9 MB that went is ~38 bytes per boxed pair,
which is what V8's packed-double representation costs.

### Streets: the one layer that CANNOT come from the store — and got the same treatment anyway

`streets` arrive as roads **text**, and they have to. The matcher **iterates** the roads store
(`corridor_ways_impl2`'s `for t in store`, whose own comment notes keyed lookup is unreliable on a
mmap-reloaded store), and loft cannot iterate a store JS has pinned (§7d(2)). Exposing roads would need a
`release`/`expose` bracket around every match at **~230 ms per expose** (§7f) against a 644 ms warm match.
**That path is dead** until loft can either iterate a pinned store or cache the flattening — both already
filed in `docs/loft-feedback.md`.

But nothing forced the PARSE to box them. `parseStreetsFlat` reads the same text into one growable
`Float64Array` plus an offset column, interned class indices, and per-road bounds. Coordinates stay `+str`
doubles in DEGREES — deliberately never converted to fixed point, because the object path fed exactly
those doubles to `project()` and re-rounding would surface as antialiasing drift under a pixel hash.

`_drawStreetsFlat` also removes garbage the object path created for its own convenience: `drawStreets`
projected into a fresh `px` array of point objects **per visible road per frame** — ~1,077 arrays and
~19k objects — purely so the class-bucket pass could re-read them. One shared scratch with recorded
offsets replaces it, and an off-screen road rewinds the write cursor instead of allocating.

**What is left boxed** is `places` (2) + `streetLabels` (1,439) — 3,170 vertices that feed
`layoutLabels`' collision pass, a separate piece of work.

### Three places where "the same pixels" needed care, not confidence

- **Draw order.** Areas overdraw each other, so the index must push them in the same tile-then-element
  order `viewFromStore` did, or a different polygon lands on top with every count still matching.
- **`areaMinZoom`.** Recomputed from the stored bounds, converted to degrees BEFORE subtracting:
  `(a-b)/1e7` and `a/1e7-b/1e7` are different doubles, and an area on a band threshold would flip bands.
- **The fixed-point screen is scaled, not rounded outward.** Flooring would make it a larger rectangle
  than `_screen`; the paths would then disagree about features within 1e-7° of the padded edge — invisible
  in pixels (>60 px off-screen) but visible in the draw counts the gate compares.

### The gate is the pixels, and it outlived the path it was comparing

`storeRenderParity()` renders the same view twice — index off, index on — and compares an FNV-1a hash of
the raw canvas bytes. Counts cannot settle it: **a ring read at a wrong offset yields plausible integers
and a plausible count**, and only the pixels show it drew somewhere else. When the object path was
deleted from the app, the probe was changed to rebuild it **on demand** for its one call, so the gate
survives the deletion it licensed.

⚠ **`memory.grow` DETACHES the ArrayBuffer** and the kernel grows memory while matching, so the view is
re-derived every frame and the memory is held as a *function*, never a buffer. A cached `Int32Array`
would read length 0 and the map would go blank after the first match.

### And two more instrument bugs, both in `timedView`, both the same class

It happened **twice in one session**, which makes it a pattern rather than an accident: `timedView`
mirrors `ensureView`, and each time the app's layer wiring moved, the probe kept measuring the old one —
first still materialising all `STORE_KINDS`, then still calling `loadView` (boxed streets) after the app
moved to `loadRoadsFlat`. It reported *"5 ms over 22,567 vertices"* for geometry **it had created itself**.

Neither failed. Neither looked wrong on its own. **Both were caught only because two probes contradicted
each other** — `layerFootprint` reporting what the app retains against `projectionCost` reporting what it
walks. *A probe that MIRRORS an app path rots silently when that path moves; the defence is a second probe
that measures the same thing a different way, so a divergence has somewhere to show up.*

The first of the pair:
`timedView` kept materialising all `STORE_KINDS` after the app stopped — so it timed a view the app never
performs and silently re-populated `map.areas/buildings/…` behind the app's back. Caught only because two
probes contradicted each other: `layerFootprint` said 0 retained features while `projectionCost` said
214,455 vertices. **Its own comment warned about exactly this**; the comment stayed true while the code
went stale against the app it mirrors. *A probe that mirrors the app must be re-synced when the app moves
— and the way you find out is by making two probes disagree.*

## 6e. Step 18 — `par` is a NO-OP in the browser. Do not build it. (2026-07-22)

**Step 18 cannot move a single number this plan measures**, and the reason is a property of the shipped
artifact, not an opinion. Established BEFORE writing any loft, which is the only reason no time was spent
on it.

### The evidence, from the app's own wasm

```
kernel wasm: memories=1 shared=false noThreadsStd=true
```

- **The memory is not shared.** A wasm module with threads carries a SHARED memory (flags bit 1). The
  app's does not — there is no thread support in the module at all.
- **Rust's no-threads std was linked in.** `no_threads.rs` appears in the panic paths for mutex, rwlock
  and thread-local. The build had `threading` compiled OFF, not merely unused.

That matches loft's own `WASM.md`: the **WASM (single)** profile has `threading` **OFF**, and `par()`
falls back to **Tier 1 (sequential)**. Tier 2 (Web Workers) needs the `wasm-threads` feature *and*
**COEP/COOP headers**. `loft --html` — the only browser build, and the one
`browser/build-store-kernel.mjs` invokes — has no thread flag at all.

### And the deploy target cannot supply the headers either

Even if the build gained threads, Tier 2 needs COEP/COOP, and the app ships on **GitHub Pages**
(`PLAN-BUILD`), which does not let you set response headers. So the second gate is shut too.

### What step 18 would actually have bought

Its own verify line says *"~3× native on the stretch loop"* — **native**. That is `server/server.loft`,
which is not what this plan is about. In the browser the stretch loop is already streamed and
interruptible (step 16), so the sequential `par` would change nothing but the code.

**§6b B is not wasted and should not be deleted.** Its determinism analysis — order the source before
par, hash iteration is unordered, `gen` is loop-carried, keep reductions out of the workers — is exactly
right and is what step 18 would need on the day it becomes possible. It is a design waiting for a
platform, not a design that was wrong.

### The tripwire, so this does not have to be re-derived

`tools/wasm_threads.mjs`, wired into `make test-map`, asserts the state written above. **The day loft's
browser build gains threads, that gate FAILS** and says to revisit step 18 — rather than this section
quietly staying wrong. *A blocked step should leave behind the check that unblocks it.*

## 6d. Step 15 — the block raster cache: LANDED and ON (2026-07-22)

**Status: enabled.** `map.blocked = true`. Every gate green.

| | before | after |
|---|---|---|
| **pan frame** (cache warm) | 20 ms | **0.6 ms** |
| **view total** | 126 ms | **146 ms** (+20 ms: one bake, which starts warming the cache) |
| cache settle after a data change | — | 7 frames, worst 66 ms |

### The prize, and the trap next to it

A warm pan frame is **0.6 ms** against 20 ms. But the first version baked every block a viewport needs in
ONE frame, and that made `view` **26 → 387 ms** (total 126 → 509) — a **4× regression on a user-visible
interaction**, spent to make the frames after it free. Caught only by profiling after enabling; the gates
were all green, because it was a cost regression, not a correctness one. §0's rule 5 in action: *the step
moved a number it was not supposed to move.*

**Bakes are amortised.** A frame bakes at most `BLOCK_BAKES_PER_FRAME` blocks; while the cache cannot yet
cover the viewport the frame is drawn DIRECTLY — from the **same snapped origin** the blocks use, so the
image does not jump by a device pixel when the cache takes over — and asks for another frame. A view pays
one bake (+20 ms) and every pan frame after costs 0.6 ms.

*An amortised cache's number is not its total: it is FRAMES TO SETTLE and the WORST single frame on the
way there, because that is what a user feels.* The gate reports both.

### Why it CANNOT be pixel-identical — inherent, not a shortcut

Canvas rasterisation depends on a path's **sub-pixel phase**. A block fixes that phase when it is baked;
the viewport origin (`cameraWorld - width/2`) is fractional and moves continuously. Blitting at the true
fractional offset resamples the block — a blurred map on every pan. Blitting at a rounded offset shifts by
up to one device pixel. Every tile renderer meets this and all of them snap.

**Measured: the snap alone changes 261,499 of 557,000 pixels.** So the gate cannot be "equals the current
render". It has to compare blocked against a **direct render at the same snapped origin**
(`renderSnappedDirect`), which separates *does the cache change anything* from *does the snap change
anything*. Conflating those is how a raster cache ships with a seam nobody notices.

Deliberately **not** snapped: `project`/`unproject`. They stay exact, so `map.test.mjs`'s pan/zoom
anchoring invariants are untouched — the snap is a RENDERING decision, not a projection one.

### Four couplings found and fixed — none of them about rasterisation

1. **Origin split.** The route and labels drew from the camera origin while the base came from the snapped
   one, putting the map a sub-pixel under the things drawn on top of it.
2. **`_inView` is a VERTEX test, and is invalid as a per-block cull.** A road crossing a block with no
   vertex inside it is drawn by the direct render and dropped by that block's bake. Exactly the class of
   error that made a bbox test mandatory for filled areas (§6c).
3. **Label anchors were screen-space**, so each block's were relative to that block's corner. Now recorded
   in WORLD pixels and claimed by the single block whose interior contains them.
4. **`fits` is greedy first-come**, so label ORDER decides which labels win a contested spot — and blocked
   collects block-by-block where direct collects in index order. Now sorted by feature index.

### The 10.7% — found, and it was three unrelated things

Bisected, not guessed. `59,704 -> 8,191` differing pixels, and the remainder is proven irreducible.

| | px | what it was |
|---|---|---|
| **1. origin key mismatch** | **35,424** | `renderBlocked` returned `{ox, oy}`; `_origin` is read as `.x`/`.y`. Every overlay projection in a blocked frame was **NaN**, so labels and the route silently vanished. All three label passes now diff 0. |
| **2. POI edge cull** | ~1,600 (maxDelta 178 → 68) | A **latent bug in the DIRECT renderer**, not the cache. |
| **3. canvas-size rounding** | **8,191**, every one ±1..15 | A **platform property**. Not fixable. |

**#2 is a real app fix and it is worth stating on its own.** A POI glyph is drawn from its CENTRE, but
the cull tested the bare viewport rect — so a marker just off-screen vanished instead of half-showing.
A block extends past the viewport, so the blocked path drew them and was **more correct than the app**.
`POI_EDGE_PAD` (largest radius 4.5 + halo → 8) fixes it, and it is why the canvas hash moved
`c85280c8 → 917244eb`.

**#3 is why step 15's gate can never be equality**, and it was established by experiment rather than
assumed. `offscreenRoundTrip(pad)` changes ONLY the canvas geometry, with every feature keeping its
sub-pixel phase:

```
pad 0   (canvas identical to the viewport)      → diff 0        ← an offscreen round-trip IS exact
pad 32  (canvas 64 px larger, origin shifted)   → diff 5,026, maxDelta 15
```

Chromium's canvas rasterisation is **not invariant to canvas dimensions**. A bleed margin necessarily
changes them, so **no raster cache of this design can be pixel-identical** — the residual is antialiasing
rounding on feature edges, ±1 in a channel.

### A cache bug the bisect could not see

Building-label anchors are produced only by a **bake**, so a fully-cached frame reset the list and never
refilled it — every building label would have vanished on the second frame of a pan. The bisect cleared
the cache on every run, so it structurally could not observe this. Anchors are now cached with their
block, and `coldVsWarm == 0` asserts it. *A probe that always starts cold cannot test a cache.*

### The gate: two equalities and one bound

```
✓ block cache: cached==baked, labels exact, vs snapped-direct 1.47% of px at
  maxDelta 15 (canvas-size rounding) · pan 0.9ms warm / 91.3ms cold, 6 blocks
```

- **cached == freshly baked** — exact. The cache's own correctness.
- **every label pass** — exact. Structural; this is what caught #1.
- **vs snapped-direct** — *bounded*: a small per-channel delta is what "no structural difference" looks
  like once #3 is understood. A `maxDelta > 16` means something real broke.

### Three things it needed before it could be ON, and two gates that were lying

- **Invalidation.** A block is baked from whatever features were loaded, and the store index is built for
  ONE viewport window — so a block baked before a data load can be missing features that window did not
  include. **A stale raster is a failure that looks like a correct map.** `loadView`/`loadRoadsFlat`/
  `setStoreIndex` now invalidate.
- **A byte budget, not a block count.** A block is `(512+64)² × dpr² × 4` bytes, so a phone at dpr 3
  stores 9× what this desktop does — a fixed cap of 24 would have been a ~250 MB cache there. Capped at
  48 MB, minimum 4 blocks.
- **DOM-free degradation.** `map.test.mjs` drives the renderer against a stub canvas on purpose, so
  `render()` falls back to the direct path when there is no `document` or no `drawImage`.

And two gates that would have passed **vacuously** — both found by trying to make them fail:

- `storeRenderParity` toggles `_sidx` and re-renders. With blocking on, both renders blit the **same
  cached blocks** and agree no matter what: it would have been comparing a cache against itself. It now
  drives the direct path. (Its hash returning to `917244eb` is how the fix was confirmed.)
- The staleness check first reloaded the **same** text, which leaves stale blocks correct — so it passed
  with invalidation deliberately disabled. It now loads an EMPTY road set: **93,080 stale px without
  invalidation, 0 with.**

*A gate that cannot fail is worse than no gate, because it reads as evidence.*

### The method note, which is the reusable part

`renderDiff`'s per-layer and per-label bisect found #1 **in one run**, after four blind fixes had found
nothing — and **two of those four changed literally zero pixels**. *When a comparison fails and you
cannot say WHERE, stop fixing and build the instrument that localises it.* A hash is a smoke alarm: it
tells you there is a fire, and nothing about which room.

## 6b(3). Escalation emits the route TWICE — and step 16's headline number was stale (2026-07-22)

Both found by profiling §6b(2) immediately after shipping it, which is the only reason they were found
at all. The gates were green; the gates were also all running sketches that do not escalate.

### The measurement that did not match the document

| | step 16's row said | measured, twice, `CPU_THROTTLE=4` |
|---|---|---|
| 40-point sketch, stretches emitted | 39 | **78** |
| 40-point sketch, worst frozen gap | 384 ms | **2567 / 2773 ms** |
| 40-point sketch, total | — | **16.2 / 16.9 s** |

**78 is exactly 2 × 39, reproducibly** — so the route is matched twice. `do_match_session_streamed`
matches on the cell tube, and when the §3 gate rejects that tier it rebuilds on the fat bbox and re-runs
`match_incremental_streamed` with the same `on_stretch`. Every stretch is emitted once per tier.

**Nothing regressed: the document did.** Step 16's numbers were measured *before* step 22 wired the
ladder, and step 22 doubled the emit for any sketch whose tube is rejected. This is `CLAUDE.md`'s "a
spec's premise goes stale" rule landing on this plan's own table — the row was correct when written and
wrong eight commits later, and only re-measuring caught it.

### It was also a live defect in the renderer

`applyStretch` strokes onto the existing canvas, so a second pass left the **rejected tier still painted
under the accepted one**, and the slots blended: `route` briefly held new stretch 0 beside the rejected
tier's stretches 1..n — a line that was never matched. The delivered route was never wrong (the final
`ROUTE` replaces everything); what the user *watched* was.

Fix: **a non-increasing stretch index means a new pass** — clear the slots and repaint. A single pass
emits 0,1,2,… strictly increasing, so the indices already carry the signal; no kernel change, no second
channel. Gated **DOM-free** in `map.test.mjs`, because the browser gate structurally cannot reach the
case (it needs the ladder to *reject* a tier, and every sketch it uses is accepted first try), and
verified to FAIL without the fix before being kept.

### Two things this leaves open, neither urgent

- **A rejected tier is wasted work, and it is not small.** On the 40-point sketch the app pays a complete
  tube match *and* a complete bbox match. Whether that matters depends on how often real sketches get
  rejected — the 40-point probe is a straight synthetic line across 8 km, which is close to the worst
  possible case for a tube gate (a real drawn route follows roads, so it deviates far less). **Do not
  read 16 s as a user number.** Sizing it needs the §7h corpus, not this probe.
- **The 3-point profile is unaffected** (2 stretches, no escalation), which is why every headline number
  in this document's table still stands.

## 6b. The match arc — a line that GROWS, on all the cores

**This supersedes the framing of §7's ladder.** The ladder tries to make one big search cheaper. This
makes it *many small independent ones the user watches arrive* — which is both faster to first paint and
the shape `par` wants.

### The matcher is already per-point; only its presentation is monolithic

`build_state` is two passes, each a loop over INDEPENDENT items:

```loft
for i in 0..m       { anchors += [denoise_anchor(g, ct, i, ec, sc, gen)]; }         // per POINT
for i in 0..(m - 1) { subs += [assemble_stretch(g, ct, anchors, i, ec, sc, gen)]; } // per STRETCH
```

`subs` is *"one matched sub-path per stretch"*. The route IS a growing line already — it is just
collapsed into one blocking call and one final `ROUTE` line. Nothing here needs inventing; it needs
un-collapsing.

### The chunk size is already right (measured, native, one corridor)

| points | stretches | ways | total | **per stretch** |
|---|---|---|---|---|
| 3 | 2 | 13077 | 199 ms | **99 ms** |
| 10 | 9 | 13077 | 376 ms | 41 ms |
| 20 | 19 | 9376 | 540 ms | 28 ms |
| **40** (a real drawn route) | **39** | 9376 | 972 ms | **24 ms** |

A realistic route is **39 chunks of ~24 ms** (≈96 ms on a phone): long enough to dwarf dispatch, short
enough to stream. **Drawing more points makes each chunk cheaper AND the corridor tighter** (13077 →
9376 ways — `corridor_margin` scales with tap spacing). *Every other number in this document was measured
on a 3-point sketch — the pathological end: 2 huge stretches over the widest corridor.*

### A — present per point (fixes the lag; needs nothing from loft)

**Invariant:** *a stretch is drawn the moment it is matched; the user sees progress, never a stall.*

**And the progress is honest, not a decoration.** The route streams in the ORDER THE USER DREW IT, stretch
by stretch — so the line retraces the same gesture they just made. That is a progress indicator with no
indicator: it needs no spinner, no percentage, and no invented estimate, because the thing being shown IS
the work being done. A spinner says "something is happening"; this says "here is your route, arriving".
It also degrades honestly — a stretch that is slow to match is a stretch the user watches take its time,
which is information, not a stall.

**It also mimics the journey itself.** The stretches arrive in TRAVEL order, so the growing line is the
walk/ride unfolding in the direction the user will actually do it — a preview of the trip, not merely a
loading animation. This app is for planning a route you are about to travel; watching it draw itself
along the way you will go is the closest a plan gets to rehearsing it.

**So arrival ORDER is load-bearing, not incidental.** Emit stretches out of order and this stops being a
journey and becomes a jigsaw filling in — same pixels, none of the meaning. That is a real constraint on
B below, and the good news is it costs nothing: loft's `par(b=worker(a), N)` *"runs the worker in parallel
over the source and **iterates the results in order**"* (THREADING.md). Parallel work, sequential reveal —
the two compose exactly, and a stretch that finishes early simply waits its turn to be drawn.

Emit each `SubPath` as it lands and `frame_yield()` between them. First segment on screen in ~96 ms, then
~10 per second, the page painting throughout. **The 4.4 s does not shrink — it stops being a freeze and
becomes a line growing at a natural pace.** That is the difference between "hanging" and "loading", and
it is the whole of the lag problem (§0a): cost is a separate axis, addressed by B and §7.

Works today, on the single-threaded browser build, with no loft change and no route change.

### B — `par` over the stretches (fully utilise the processor)

**Invariant:** *each stretch is a self-contained chunk; workers share nothing, so nothing locks — and the
results are still revealed in travel order, for the same route as a sequential run.*

#### ⚠ `par` is NOT deterministic by default — and determinism is a design requirement

DESIGN §5 / PLAN-MATCH §2 require *same input → same match*. `par` does not give that for free. Three
sources, in the order they will bite:

**1. A `par` loop over a HASH visits in a different order.** THREADING.md: *"A hash uses an unsorted
bucket walk for par (`hash_unsorted`) since the queue has no use for the hash's key order — so a par loop
over a hash may visit elements in a different order than sequential `for x in h`."* `tiles_corridor_ways`
iterates `for t in store` — a `hash<TTile[tkey]>`. Par it and the **way order changes**, so `build_graph`
assigns different node/edge indices, so Dijkstra breaks ties differently, so **the route changes run to
run from identical input**. This is the dangerous one: it is silent, plausible, and only shows as a route
that "wobbles". *Fix:* do not par the corridor read, or materialise the tiles in `tkey` order first.

**2. `gen` is a loop-carried counter.** The stretch loop does `gen = gen + 1` and hands `gen` to
`assemble_stretch` to invalidate the shared `Scratch`. Under par that is a shared mutable and a race.
*Fix:* it disappears with B1 — a per-worker `Scratch` gets a per-worker `gen`, and neither is shared.

**3. Float summation order**, if any per-stretch cost is ever reduced across workers. Not an issue today
(each `SubPath` is independent and `emit_route` sums in order), but it is the classic way a parallel
refactor silently changes a length by 1e-12. *Fix:* keep every reduction in the ordered body, never in
the workers.

#### The shape that fixes it: ORDER THE SOURCE, then let par sequence the results

The two requirements — deterministic route, in-travel-order reveal — collapse into one rule, because
`par`'s *"iterates the results in order"* means **in the order of its SOURCE**:

1. **Give the source an ordering BEFORE par.** A range (`0..m-1`) already has one — which is why the
   stretch loop is safe as written. A **hash does not**: par materialises it with an unsorted bucket walk,
   so "in order" becomes "in an arbitrary order that may differ run to run". So the corridor read must
   either not be parallelised, or materialise its tiles **`tkey`-sorted** first. Sorting is the fix;
   par is not the problem.
2. **Emit the moment the next index lands** — index 0, then 1, then 2 — not when all workers finish.
   That is what keeps time-to-first-stretch low *with* par: the user still sees the line start growing
   immediately, while later stretches are computed behind it.
3. **Hold the ones that arrive early.** A worker that finishes stretch 5 before stretch 2 is done has its
   result kept until 2, 3, 4 land. That is a reorder buffer, and it is exactly what loft's `par` already
   does when it iterates results in order — so this costs us no code, only the discipline of (1).

The result: parallel work *behind* a sequencer. The compute order is whatever the scheduler likes; the
reveal order is the journey; the route is identical to a sequential run. A stretch finishing early simply
waits its turn to be drawn — and waiting costs nothing, because the user is watching the earlier ones.

**The buffer stays near the POOL size — but that is a tendency, not a hard bound.** The dispatcher is a
queue: while the head stretch is still running, the other N−1 threads keep pulling *further* work and
finishing it, so the pending set grows roughly as **(head cost ÷ typical cost) × N**, not N. It is close
to N in practice only because stretch costs are similar (measured: ~24 ms each across 39 stretches). Do
not design as if N were a guarantee:

- **Memory is still a non-issue, and does not depend on the bound holding.** Even the degenerate case —
  every remaining stretch buffered behind a stuck head — is ~39 `SubPath`s for a real route. Small
  whatever the jitter. loft's `par` owns the buffer; we do not size it.
- **The reveal stalls by the SLOWEST in-flight stretch, not a typical one.** That correction matters:
  costs are *not* uniform (a 3-point sketch's stretches are ~99 ms vs ~24 ms at 40 points — a 4× spread,
  and a stretch crossing a dense corridor is worse). So the pause is one *slow* stretch long, then several
  successors land at once. Still the honest-degradation property — the line hesitates exactly where the
  matcher struggled, and catches up instantly — but the pause is bounded by the worst stretch in flight,
  not by the average.

**And the luck cuts both ways — mostly in our favour.** Whether a slow stretch is felt depends on WHERE it
sits in the order:

- **Slow stretch at the head** → the worst case above: the reveal waits, successors pile up behind it.
- **Slow stretch late** → *invisible*. By the time the eye reaches stretch 30, the workers have been
  chewing on it for as long as the user spent watching stretches 0–29. It is already done.

So `par` hands every stretch a head start **proportional to how late it is** — and only the first few have
no head start at all. That inverts what the buffer is: **the pending results are not overhead, they are
LOOKAHEAD.** The work runs ahead of the eye, and the "buffer" is simply how far ahead it has got.

This is the real prize of par + ordered streaming, and it is bigger than the ~3× on the total. Sequential
streaming makes the reveal wait for each stretch in turn, so the line advances at `sum(costs)`. Par + an
ordered reveal makes the line advance at the pace the user watches, stalling only when the head is not yet
ready — i.e. cost is hidden behind attention rather than added to it. A route whose expensive stretches
are anywhere but the start can be *entirely* hidden.

So `par`'s non-determinism is bounded in the sense that matters most — the *route* becomes deterministic
once the source is ordered (1) — while the *buffering* is merely well-behaved: near-N under uniform cost,
degrading gracefully under jitter, never large enough to matter at route scale, and in the good case not a
cost at all but the lookahead that hides the work.

**The gate is therefore determinism, not just parity:** run the SAME match N times with par enabled and
assert the route is byte-identical every time — and identical to the sequential run. `tools/match_parity.sh`
already compares session-vs-one-shot on the route (excluding `ways=`, which is corridor size); the par
work extends it with an N-run repeat. A one-shot comparison would pass on a wobble that only appears one
run in ten, so the repeat is the point.

That is `par`'s core — divide the work into chunks big enough to be worth dispatching, with no shared
state. Per stretch the inputs are **read-only** (`g`, `ct`, `anchors`, `ec`) and the output is a fresh
`SubPath`. **Exactly one thing is shared and mutable: `sc` (the `Scratch` buffer)**, threaded through
every call and reused across iterations with a `gen` counter to invalidate it — a *sequential*
optimisation (reuse the buffer, don't reallocate) that is now the only thing forcing locking.

**Give each worker its own `Scratch` and the loop is embarrassingly parallel.** Same for Pass 1's
`denoise_anchor`, which shares the same `sc`. So the work is not "add threads to the matcher" — it is
**un-share one buffer**, which is also what makes it streamable.

> **MEASURED 2026-07-17 — the decomposition changes; `par` still works.** A par worker may not read a
> captured **reference**, only scalars — so `g`/`ct`/`anchors`/`ec` cannot be handed to a worker that way.
> But *"only the loop element may be a reference"* is the route: **put the data in the ELEMENT** — make
> each stretch a self-contained job carrying the slice it needs. That is the ordinary data-parallel
> decomposition, and measured it scales:
>
> | slice per job | sequential | `par(…,8)` | |
> |---|---|---|---|
> | 100 | 96 ms | **26 ms** | **3.7×** |
> | 1000 | 88 ms | **22 ms** | **4.0×** |
> | 10000 | 69 ms | 42 ms | 1.6× — the per-element copy eats it |
>
> Results identical throughout. **So the constraint is: give a worker what its part needs, not the world,
> and keep the slice small** — the element is copied into the worker's isolated store clone.
>
> Two corrections to what this section assumed: (a) **we were never blocked on `Scratch`**, the shared
> *mutable* — the pressure is on the read-only *inputs*; (b) the work is not "un-share one buffer" but
> "**slice the corridor per stretch**". Sizing that slice is the open design question, and the copy column
> above is what decides it. §6b A (streaming) is unaffected and already shipped — it was always the half
> that fixed the lag. THREADING.md: *"`Stores::clone_for_worker()` creates **locked copies of all in-use stores for
> each worker thread**."* Two consequences, pulling opposite ways:
> - **The un-sharing may be automatic.** If each worker gets private stores, `Scratch` is already
>   per-worker and step 17 is a no-op. Refactoring it by hand first would be work done for nothing.
> - **But it copies ALL in-use stores, per worker** — including the corridor `Graph` (13077 ways). Eight
>   workers ⇒ eight graph copies. That could cost more than the ~3× it buys, and it is a *memory* cost on
>   the device where RAM already binds (the session is at 188 MB).
>
> So **measure before refactoring**: run `par` over the stretch loop as-is and read (a) wall clock vs
> sequential, (b) `wasmBytes`, (c) whether the route stays byte-identical. That probe answers whether
> step 17 is needed, unnecessary, or moot because 18 is too expensive. Doing 17 first assumes an answer
> the docs already put in doubt. *(Extra context args ARE forwarded — `par(b = scale(a, mult), N)` — so a
> worker can take `g`/`ct`/`anchors`/`ec`; that part of the design holds.)*

Measured ceiling: `par(…, 8)` gives **3.3×** natively here (101 → 31 ms on a synthetic load). On a phone's
8-core big.LITTLE expect ~3× — the 4 little cores are not equal to the prime one, and the thread count
should come from `navigator.hardwareConcurrency`, never a constant (this box reports 24).

**Browser gating (measured, not assumed):** threads need `crossOriginIsolated`, which needs COOP/COEP.
Our own page, same bytes:

| served | `crossOriginIsolated` | `SharedArrayBuffer` |
|---|---|---|
| no headers (as GitHub Pages serves it) | `false` | undefined |
| + COOP/COEP | **`true`** | **`function`** |

Two response headers are the whole difference. GitHub Pages sends no custom headers, but a **service
worker can inject them** (the `coi-serviceworker` pattern; the older `browser/` app already shipped an
`sw.js`). The real gate is loft-side: today's `--html` wasm **exports an unshared memory** and the shim has
no workers/SAB/atomics — loft's `C3` (*"WASM threading deferred — Web Worker pool cost > benefit today"*)
and roadmap A10 8a. **Flag for that work:** our kernel now leans on asyncify for both the store fetch and
`frame_yield`, and BROWSER_INTEROP calls asyncify *"one suspendable stack"* — threads plus one suspendable
stack is exactly where this goes quietly wrong. Probe that combination first.

#### B2 — what "slice the corridor per stretch" actually requires (read before coding)

`assemble_stretch` is `dijkstra_win(g, ai, [aj], win, ec, sc, gen)` — `ai`/`aj` are node **indices into
g**, and the search walks the whole graph bounded by the deviation window `win`. To make a stretch a
self-contained job (the only shape `par` accepts — see B above) each job must carry its own sub-Graph.
Three things follow, and the second is the one that bites:

1. **The envelope must be a SUPERSET of what the full search would touch**, or the route changes. The
   natural candidate is the deviation window itself (`win` + `DEV_TOL`), since that is what bounds
   `dijkstra_win` — but "what the search *could* reach" needs proving, not assuming. Too tight and the
   route silently degrades; too loose and the copy cost (B's table: 10k elements ⇒ the win is gone) eats
   the parallelism. **That trade IS step 18a.**
2. **Renumbering must be MONOTONIC.** A sub-Graph renumbers nodes, and the search's tie-breaks depend on
   node/edge indices — the same mechanism as the hash-ordering hazard above. If the subgraph's nodes keep
   the parent's *relative* order, equal-cost ties resolve identically and the route is preserved; an
   arbitrary remap changes which of several equal-cost paths wins. So: build the slice **in parent index
   order**. This is cheap to do and silent to get wrong.
3. **The path must map back** to parent indices/coords before it reaches `SubPath`.

**Do not start 18b before 18a answers (1).** The gate (`match_parity.sh`) would catch a wrong envelope,
but only as "the route changed" — it will not tell you which envelope is right, and this is a design
question with a correctness answer, not a tuning knob.

**And weigh it against what streaming already bought.** §6b A took a real route's worst freeze from
11095 → 744 ms with no threads. `par` shortens the *total* (~4×), which the lookahead already hides for
every stretch but the first few. The honest case for 18 is now the **cold match** (~5.3 s, the first
click in a fresh area) — the one thing streaming cannot hide, because there is nothing on screen yet to
watch. Steps 19–20 (persist the built graph, cell-tube corridor) attack the same number without touching
the matcher's internals or risking a route. **Do those first, and re-measure before committing to 18.**

### Order

```
A  stream per stretch + yield        ← fixes the LAG. No loft change, no route change, works today.
B1 per-worker Scratch                ← un-share the one mutable. Prerequisite for par; no behaviour change.
B2 par(…) over stretches             ← ~3x on native/Android today; browser gated on loft C3 + COOP/COEP.
```

A is independent of everything and should land first: it is the only one that changes what the app *feels*
like, and it needs no permission from anyone.

---

## 7b. Steps 20 + 21 — the tube drops 66% of the ways and is NOT route-neutral (so §3's gate IS needed)

**Step 20 (`tiles_corridor_ways_tube`, inert)** keeps only tiles near the polyline, not every tile in its
bbox rectangle. The test is per-TILE, never per-way (PLAN-MATCH §1 measured a per-vertex sweep past a
2-minute budget). On three hand-picked sketches it dropped 43–60% of the ways with an **identical route**,
and I concluded it was route-neutral — a margin-faithful tube being "the same tier computed better"
rather than a cheap tier, so §3's gate might not apply to it.

**Step 21 (`tools/corpus_tube.loft`) falsified that on the fourth sketch it looked at.** 25 deterministic
sketches across the block (varying origin, direction, bend, and 3/9/15/21 points):

```
CORPUS 25 matched: identical=17  diverged=8          ← 32% diverge
WAYS  bbox=200708  tube=68529  dropped=132179 (66%)
```

**Three sketches said 0% divergence; 25 say 32%.** That is the sampling error this document warns about
in §2, made by the author of the warning, one commit after writing it. *Any corridor claim needs the
corpus, not a sample.*

**PLAN-MATCH §1 was right:** *"uniform tightening is NOT accuracy-neutral."* The §3 gate is required.

**But the divergences are not uniformly worse — which is exactly why the gate is a QUALITY gate:**

| sketch | bbox | tube | |
|---|---|---|---|
| i=3 | dev_max 1639 m, bridged 222 m | dev_max **725 m**, bridged **0 m** | tube **better** |
| i=7 | len 12489 m, dev_max 484 m | len 16548 m, dev_max 1003 m | tube **worse** |
| i=2 | len 13383, bridged 0 | len 9888, bridged 559 | different trade |

The tube is not a worse corridor; it is a **different** one — better on some sketches, worse on others.
Judging that per-segment on deviation + penalty share, and escalating when it fails, is precisely
PLAN-MATCH §3. So the ladder's shape was right and this plan's §7b guess was wrong.

**Where that leaves it:** the tube stays **inert** — which is why step 20 was specified inert, and it paid
for itself. It is a genuine ~66% way reduction (and ~2–3× on the corridor read) available the moment
step 22's gate can accept it per-segment and fall back to bbox when it cannot. `tools/corpus_tube.loft`
is the harness that tunes and then guards that gate; it prints the §7 numbers (dev_max/dev_mean/pen_m/
bridged_m/class_m) for both tiers per sketch.

---

## 7j. Attacking the SEARCH — anchoring cost more than routing (2026-07-22)

Once §7i fixed the graph build, the search became the largest slice. Same method: attribute first, with
temporary phase timing inside `build_state`.

| phase | cost (3-point sketch, 114 ms search) |
|---|---|
| **anchors (3 points)** | **60 ms — 53%** |
| `precompute_edges` | 27 ms |
| stretches (2) | 18 ms |
| `new_scratch` | 7 ms |

**Anchoring cost more than routing** — and unlike the stretches it is per POINT, so a realistic 40-point
sketch pays it forty times (this is the ~8 s freeze §6b A recorded for a dense sketch).

### The scan nobody had looked at

`nearest_nodes` is called ~3× per point. It allocated a `taken` vector **the size of the graph** (33,948
booleans) and then ran **`VITERBI_K` = 4 full selection scans over every node**. The comment above it
records that the *metric* was already optimised from Vincenty to flat-earth multiplies — *"turns ~17M
Vincenty calls into cheap multiplies"* — but **the scan itself was never touched.** One pass keeping the
best K replaces four passes plus the allocation.

**The result is IDENTICAL, not merely equivalent, and the tie-breaking is why.** The old code scanned
ascending with a strict `d < bestd`, so among equal distances the LOWEST node index won. The insertion
shifts only while `d < bd[pos-1]` — also strict — so an equal-distance node stays behind the one found
earlier. Anchors feed the Viterbi, so a different tie is a different route.

| | before | after |
|---|---|---|
| search (native) | 115 ms | **88 ms** (−23%; median of 10, 83–94, spread 1.16×) |
| cold match (native, TUBE) | 223 ms | ~205 ms |
| **warm match (browser, `CPU_THROTTLE=4`)** | 526 ms | **395 ms (−25%)** |
| cold match (browser) | 1820 ms | 1831 ms — **unchanged, within the 1.1× spread** |

**The win lands on the WARM match, and that is the point.** `update_state` recomputes only the edited
window, so a warm match is almost entirely anchor work — while a cold match is still dominated by the
corridor read and `build_graph`, where a 27 ms search saving disappears into the noise. Warm is *"the
interaction users actually perform"* (this document's own words), so an improvement that shows up only
there is the one worth having.

Routes byte-identical: all four tile-border fingerprints and all three `match_parity` lengths.

### 7k — `EdgeCosts` indexed by WAY, not by edge

`precompute_edges` was ~27 ms of the 88 ms search: five arrays of ~37.6k entries — about **188,000 vector
appends per cold match** — holding ~7.1k distinct values, because every edge of a way has identical costs.

The arrays are now one entry per WAY, indexed by `GEdge.w`. **The indirection is free where it matters:**
the hot relaxation loop already loads `e = g.edges[ei]` for `e.a`/`e.length`, so `e.w` costs nothing and
the arrays it indexes are 5× smaller — better locality, not worse. Four read sites, all with `e` already
in scope.

| | before | after |
|---|---|---|
| search (native) | 88 ms | **~66 ms** (−25%) |
| cold match (native, TUBE) | ~205 ms | **~187 ms** |
| **cold match (browser)** | 1831 ms | **1539 ms** (−16%) |
| **warm match (browser)** | 395 ms | **358 ms** (−9%) |

Routes byte-identical. Quiet box, spreads 1.0–1.1×.

⚠ **The first attempt to measure this was thrown away**, and that is the process working: the box was at
load 16 and the probe spread opened to 1.7× (match 70–121 ms). The commit landed on its correctness proof
with the timing explicitly *not* claimed, and the numbers above were taken later on a quiet box. *A
change can be committed on a gate; it cannot be characterised on a contended one.*

### 7l — the spatial index: BUILT, MEASURED, REVERTED. And it found the real bottleneck.

`nearest_nodes` was still O(nodes), so it was replaced with loft's `spatial<T[x,y]>` — an expanding-box
query plus an exact re-rank, tie-breaking by lowest node index explicitly (Morton order does not give it
for free, and anchors feed the Viterbi). **It worked: routes byte-identical on all four border corridors
and all three `match_parity` lengths.** It is still reverted, because it is a large net loss:

| 40-point sketch, native, quiet box | before | with spatial index |
|---|---|---|
| build_graph | 70 ms | **345 ms** (+275, ~5×) |
| match | 259 ms | **~260 ms** — *no change* |
| total | 350 ms | **~635 ms** (+81%) |

Two things paid for by building it, both worth more than the change would have been:

1. **33,948 radix-tree inserts per corridor is not free** — it costs ~275 ms, five times the entire graph
   build. An index that must be built per corridor has to earn that back, and this one earned nothing.
2. **`nearest_nodes` was NOT the bottleneck.** §7j's one-pass top-K had already made the scan cheap; what
   is left in anchoring is `denoise_anchor` running a **full `dijkstra_win` from point i−1 to point i+1
   for every interior point** — 38 extra Dijkstras on a 40-point sketch, on top of pass 2's 39. *The scan
   was the visible thing; the search behind it was the expensive thing.*

**So the next attack on the search is `denoise_anchor`'s per-point Dijkstra, not its nearest-node lookup.**
Ideas worth measuring before building: reuse one search per pair of points instead of one per interior
point, or bound the anchor search radius (it only needs the best node near point i, not a full path from
i−1 to i+1).

⚠ And a note for anyone reaching for `spatial<T[x,y]>` elsewhere: it is sound but **not wired to its own
exact queries**. `loft2/src/spatial.rs` carries exact `nearest`/`within`, but it is `#![allow(dead_code)]`
and nothing references `spatial::` — only `radix_db`'s surface is reachable from loft. The outward walk
`xs[(x,y)..:n]` is `Near`, which loft's own source calls approximate: *"never for a correct radius or
k-NN"*. Only the BOX slice is sound, and it returns a superset that the caller must filter
(`tools/spatial_probe.loft` asserts exactly that).

## 7i. Attacking the corridor read and the graph build directly (2026-07-22)

With 18 and 19b both closed on measurement, the cold match was attacked where it actually is. The
attribution came first, and it named a culprit nobody had proposed.

### Where `build_graph`'s 163 ms went

Measured by variant (replace one part, re-time):

| component | cost |
|---|---|
| **`add_edge`** | **~108 ms (66%)** |
| node hashing | ~55 ms |
| per-edge geodesic | ~6 ms |
| `build_adj` (the CSR passes) | ~6 ms |

**Neither the trig nor the CSR mattered.** The cost was constructing ~37.6k `GEdge` records of
**fourteen** fields — eleven of them text tags that are *identical for every edge of the same way*. A
corridor has ~7.1k ways behind those 37.6k edges, so every tag was being copied five times over.

### The fix, and two wrong turns worth keeping

`GEdge` now holds `w`, an index into a per-way tag table on the `Graph`. Both wrong turns were caught by
measuring rather than by reasoning:

1. **`etags` first returned `Way`** — which carries its `coords`. Reading one per edge copied a
   coordinate vector and `match` went 199 → 450 ms: the entire `build_graph` saving handed straight back.
   Hence `WayTags` — 11 text handles, no geometry.
2. **Even `WayTags` cost too much copied per edge** (~380 ms). The fix was not a cheaper copy but *not
   copying*: `precompute_edges` now computes its five cost arrays **per WAY**, and the per-edge pass is
   five array reads. `way_penalty` alone is ~40 string comparisons and was running 37.6k times instead of
   7.1k — so this ended up **faster than the original**, not merely recovered.

### Result

Native, TUBE tier (what a cold match uses):

| | corridor | build_graph | match | total |
|---|---|---|---|---|
| this morning | 71 | 180 | 124 | 375 ms |
| after 19a | 29 | 153 | 130 | 311 ms |
| **now** | **20** | **93** | **115** | **223 ms** (−41%) |

Browser, `CPU_THROTTLE=4`, spreads 1.0×: **cold match 2721 → 1820 ms**, **warm match 644 → 526 ms**.
Routes byte-identical throughout — all four tile-border fingerprints and all three `match_parity`
lengths unchanged.

⚠ Hit a loft **codegen bug** on the way: a `text` field read directly off a struct-returning call emits
Rust returning `&str` where `String` is expected (`--native` only, and it surfaces as a rustc error
against generated code). Bind the struct to a local first. Filed in `docs/loft-feedback.md`.

## 7a(2). Step 19 RE-MEASURED (2026-07-22) — and 19a landed without a format change

§7a said to re-size step 19 before building it. Done, with a new instrument
(`tools/match_phase_probe.loft`), and it changed what to build.

### Where a cold match actually goes

Native, medians, the app's own sketch:

| tier | corridor | **build_graph** | match | total |
|---|---|---|---|---|
| **TUBE** — the tier a cold match uses (step 22) | 71 ms | **180 ms** | 124 ms | 375 ms |
| BBOX — what it escalates to when the gate rejects | 121 ms | 394 ms | 199 ms | 735 ms |

**`build_graph` is ~50% of a cold match — MORE than §7a's recorded ~41%, not less.** Steps 20–22 shrank
the corridor READ further than they shrank the graph build, so its share rose while the total fell.
Step 19's premise is *stronger* than when it was written. That is the opposite of what §7a expected, and
is exactly why it said to re-measure.

### 19a — the text node key, removed. No format change, no risk.

`node_idx` deduped nodes with a TEXT key, `"{lat},{lon}"`, formatted **per vertex of every way** — ~45k
float→string conversions plus text hashing per cold match. Now the fixed-point degrees packed into one
i64.

**Safe only because the text key was INJECTIVE, which was checked, not assumed.** Had loft's float
formatting been rounding, the text key would have been silently snapping nearby nodes together — that
snapping would be load-bearing, and swapping keys would change routes.
`tools/nodekey_probe.loft` asks the real corridor: **44,739 vertices → 33,948 distinct nodes under BOTH
keyings.** Route fingerprints byte-identical across all 5 `match_parity` cases.

| | before | after | |
|---|---|---|---|
| cold match, native | 375 ms | **311 ms** | −17% |
| **cold match, browser** (`CPU_THROTTLE=4`) | 3327 ms | **2721 ms** | −18% |
| build_graph, native | 180 ms | 153 ms | |
| corridor read, native | 71 ms | 29 ms | the text keys left ~34k live strings per graph; heap pressure slowed the allocating work around them |

### 19b's acceptance gate exists NOW — and it already de-risked the change

`tools/tile_border_gate.sh` (in `make test-native`) is §268's acceptance — *"a corridor spanning ≥2 tiles
matches identically"* — standing **before** the change it judges:

```
#B [0] ways=7138 tiles=14 route_pts=213 crossings=6 fp=13491979666115
#B [1] ways=7138 tiles=14 route_pts=213 crossings=6 fp=13491979666115
#B [2] ways=4501 tiles=6  route_pts=82  crossings=5 fp=2009382494520
#B [3] ways=552  tiles=4  route_pts=70  crossings=5 fp=1467589415931
#B ALL PASS — every corridor spans tiles, crosses borders, and is order-insensitive
```

**The matcher is ORDER-INSENSITIVE.** Feeding the same ways REVERSED and ROTATED gives a byte-identical
route, on all four corridors. §6b B warned the chain — way order → node/edge indices → Dijkstra
tie-breaks → a different route from identical input — and a per-tile union necessarily numbers nodes
differently from one global build. It does not matter: **19b's risk is the node SET it merges, not the
order.** That removes a canonical-node-ordering requirement the change would otherwise have carried.

**Non-vacuity is asserted, not hoped for.** Each corridor must span ≥2 tiles *and* its route must actually
cross a boundary — a green run over corridors that never touch a border proves nothing. The golden check
was verified to FIRE by perturbing one fingerprint by 1.

### 19b — MEASURED AND REJECTED. Do not build it.

Its whole case is that unioning persisted per-tile graphs is much cheaper than building one from ways.
That had never been measured. `tools/union_probe.loft` simulates the change with in-memory parts —
partition the corridor's ways by storing tile, build each tile's graph (the work that would become
persisted), then time the **union alone** against a straight build of the same corridor:

| corridor | build | union | saving |
|---|---|---|---|
| 14 tiles, 7138 ways | 154–158 ms | 132 ms | ~16% |
| 6 tiles, 4501 ways | 92 ms | 73 ms | ~21% |
| 4 tiles, 552 ways | 16–21 ms | 14–18 ms | ~13% |

**And the structural reason, so it is not just three numbers:**

```
hashed: build=44739 vertices vs union=34454 part-nodes (parts duplicate only 506)
```

The union must still hash **every part-node** to merge the parts — only **23% fewer** than the vertices a
build hashes — and it still copies every edge and still rebuilds the CSR. All it genuinely skips is the
per-vertex coordinate walk and one geodesic per edge. With the parts duplicating just **1.5%** of their
nodes, **there is no headroom for a cleverer persisted format either**: any union has to merge ~34k nodes.

**Sizing it.** `build_graph` is ~49% of a cold match and the union saves ~16% of that, so 19b is worth
**~8% of a cold match — about 215 ms of the browser's 2721 ms.** In exchange for a `TTile` format change,
regenerating and redeploying 23.5 MB of stores, a loader-side merge, and the riskiest row in the plan.
**19a delivered 606 ms the same afternoon for a one-line key change.**

⛔ **NO-GO.** Found for the cost of a probe rather than a regeneration, a redeploy, and a route-regression
hunt. `union_graphs` is kept as the reference implementation — correct, and where a future revisit starts
— with its route identity asserted in the border gate rather than left to rot as unexercised code.

**If it is ever reopened**, re-run `tools/union_probe.loft` first: the verdict is a ratio between two
costs, and either could move (a cheaper node hash, or a corridor small enough that the constant factors
change the balance).

---

## 7a. Step 19 scoped — persisting the graph is a FORMAT change (read before starting)

Its one-line summary undersells it. `PLAN-TILES` §268 is not "prebuild one graph": *"the generator
persists per-tile `GNode`/CSR adjacency alongside (or instead of) `Road`s; the loader unions the loaded
tiles and merges their **exact-integer border nodes, splicing adjacency**… Do this **only after**
single-tile read (B.2 / D.4) works."* A graph is corridor-specific, so what can be persisted is a graph
**per tile**, re-unioned per corridor. That means all of:

1. **`TTile` gains `GNode`/CSR fields** — a store-format change.
2. **`tools/gen-tiles.loft`** builds and writes them.
3. **The stores are regenerated** (enschede: 20 MB layout + 3.5 MB roads) and re-deployed.
4. **The loader unions the corridor's tiles and splices border nodes** — the risky part: borders must
   merge on exact-integer coords, or a route crossing a tile edge changes. §268's own check is "a corridor
   spanning ≥2 tiles matches identically".
5. Only then does the kernel skip `build_graph`.

**Prerequisite status:** §268 says "only after single-tile read works". The paged API **is** shipped
(`store_load_key` / `store_load_keys` / `store_load_key_text`, loft#522) and there is prior art in
`client/basemap/load_working_set.loft` — but the app's kernel does **not** use it: it loads whole stores.
So the prerequisite is *available*, not *met*.

**Sizing, honestly.** Since step 7 the graph is built once per corridor and reused, so `build_graph` now
costs only on a corridor MISS — i.e. the cold match (~5.3 s), where it is ~41% (~2.2 s). Real, but this is
a format change plus a border splice that can silently alter a route, for one number.

**So do step 20 first.** The cell-tube corridor is *additive and inert* (tube beside bbox, bbox still the
default), changes no format, regenerates nothing, and shrinks the ways — which makes **both** the corridor
read and `build_graph` cheaper, attacking the same cold match from the cheap end. Re-measure after it;
19's ~41% may be a smaller slice of a smaller number by then, and 22's gate may matter more than either.

---

## 7. Phase C — the match ladder (the rare cold match)

`PLAN-MATCH` §2–§5, unchanged; its step 0 (quality instrumentation) is already done (`match_quality()`).

**Rare is not an excuse for slow.** S makes the cold full match the *outlier* — a first click, or a
sketch leaving the built corridor — but a user still hits it on every fresh area, and 4.5 s is not
acceptable there either. The outlier needs a budget too: **≤ ~500 ms on a phone.** Two levers get it
there, and they compose:

| lever | what it removes | size |
|---|---|---|
| **C1–C3** — the cell-tube ladder | ways in the corridor (20,472 → 6,945) | ~3× on both build and search |
| **C4** — persist the BUILT graph (`PLAN-TILES` §268) | `build_graph` entirely | **~41%** of a cold match |

That 41% is not a guess — PLAN-MATCH's own table splits the 886 ms cold match as **build 367 + search
519**. The graph is derived data with a static input (the tile block), so building it per match is the
same §1 violation as everything else in §2: *work proportional to the data, not to the change.* Building
it at **generation** time and loading it is the write-time move Phase B makes for integrity.

Composed: tube (~3×) on a search that no longer pays build ⇒ **4370 → ~500 ms**, without touching the
accuracy floor. **C4 does not need the §3 gate** — it changes no route, only where the graph comes from —
so it is safe to do *before* C3, and it is the better first step.

**⚠ C0 first — the number is not trustworthy.** Match kernel time was **1123 / 1017 / 3132 ms** across
runs of the *same* route. A 3× spread cannot judge "drops toward ~300 ms". Suspect session history (wasm
memory grown/fragmented by preceding views). That is itself a finding: if cost depends on what the
session did before, users feel it.

| step | change | verify |
|---|---|---|
| C0 | Reproducible match timing (fixed route, warm/cold stated, N runs + spread). | spread < 10% |
| **C4** | **Persist the built graph** (PLAN-TILES §268): build at generation, load it. Route-neutral ⇒ no gate needed ⇒ do it FIRST. | identical route; cold match drops ~41% |
| C1 | Cell-tube corridor beside today's bbox; both available, bbox default (inert). | way-count drops; no behaviour change |
| C2 | Offline corpus compare: cheap vs fat tier on the §7 quality numbers. | the data that tunes the gate |
| C3 | Wire the §3 gate + escalation; fat corridor stays the floor. | where the gate accepts, quality tracks fat |

**Falsification probe (C2 is the probe):** PLAN-MATCH's own table shows the cheap tube returning a
*different, worse* route with **0 bridges**. If quality diverges on a material fraction of the corpus,
the gate cannot accept it and the win is smaller than 3×. Publish that fraction before C3.

**C3 is the only step in this document that can return a worse route.** Everything else is subtraction.

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


## §7c — Blocker re-validation (2026-07-22, installed loft **2026.7.2** @ 09:01)

CLAUDE.md's rule (*re-measure a doc's premise before building on it*) applied to this plan's own
blockers. **Nothing is blocked upstream any more.** The binary moved under us again — 2026.7.2 is five
days newer than the 2026.7.1 these blockers were measured against, and it changed both answers.

| blocker | claim | verdict (2026-07-22) |
|---|---|---|
| **18** → @PLN108 | par copies the parent heap per worker | **GONE.** Flat 1–3 ms across 0/61/122 MB and 1/8/16 threads, flag unset. Was 214 ms / 162 ms. See the step-18 row. |
| **9–13** → @PLN105 | *"`expose` pins a store unreadable"* | **NOT AN UPSTREAM BLOCKER, but the earlier finding was substantially RIGHT** — see §7d. `release`/`expose` bracketing makes it buildable today. |
| **14–15** | render budget, loft-independent | unchanged; pure JS, nobody blocking |

**The 2026-07-17 row for 9–13 said this was "wrong twice over". That verdict was itself wrong.** It came
from reading the Phase-3 retraction as clearing the *whole* earlier entry, when the retraction only ever
addressed `deliver`'s hash handling and never touched the pin. Step 9 was attempted on that reading and
hung the app the same afternoon. See §7d and `docs/loft-feedback.md` (2026-07-22).

### Why 9–13 is not blocked

**@PLN105 is CLOSED** (GH `loft-lang/plans#105`, 2026-07-16T09:25:08Z; language work merged as #580). Its
plan states: *"Language-side prerequisites are all done; what remains is genuinely consumer work in
`../routing` (owned by that agent)"* — **steps 9–13 ARE @PLN105's Phase 4.** Calling them "blocked on
@PLN105" had it exactly backwards: @PLN105 is waiting on *us*.

**`expose` pins a store unreadable** — wrong, and it is the same fragment-reading error CLAUDE.md opens
with. Pinning (`lock_store`) is the *feature*: it keeps the read valid ACROSS FRAMES, and loft has a test
proving JS reads survive an asyncify yield (`deliver_expose_survives_cross_frame_yield_in_js`) — which is
precisely routing's `frame_yield` situation.

**A `hash` will not deliver** — **RETRACTED, this was wrong too** (`docs/loft-feedback.md`). `deliver` of
a hash does fail, but that is the **loopback test reconstructor** (`deliver_reconstruct` →
`read_via_descriptor`) refusing `FlatArray` — the very node Phase 3 emits for a hash. **`expose` is a
different function** and never goes near it (`ffi_deliver.rs:56`): it calls `collect_keyed` (Phase 3's
pre-flattening) → `to_delivery_json(&flat)` (the `(rec,pos)` redirect map) → `lock_store` (the pin) →
`loft_host_expose`, and its body is `#[cfg(target_arch = "wasm32")]` — **only live on the `--html` target**,
which is why it is a silent no-op on the plain backend.

**So step 9 stands exactly as written: `expose(1, layout)` on the layout hash.** No per-tile flattening
workaround is needed — `collect_keyed` does it inside loft. Steps 9–13 need no upstream anything; they
need us.

**The lesson, since I paid for it twice in one hour:** probe the function the STEP ACTUALLY CALLS. Both
wrong conclusions came from testing `deliver`'s loopback and generalising to `expose`'s bridge, and from
reading a `cfg`-disabled no-op as evidence about loft rather than about my probe.

### Where steps 9–11 leave the bridge (2026-07-22)

All three are green and gated in `make test-map`: loft hands JS a live handle (9), JS reads any one tile —
or one FIELD of it — without materialising the rest (10), and the areas it reads match loft's serialised
areas exactly (11). **Step 12 can switch the render source for areas.** Two things to carry into it:

- **`readMs=96` for all 2252 areas across 1089 tiles is NOT comparable to the profiler's numbers.** The
  bridge gate runs unthrottled; `tools/map_profile.sh` runs at `CPU_THROTTLE=4`. Measure step 12's win
  with the profiler, never from this gate's number.
- **The store read is EXACT; the text path is LOSSY** (6 printed decimals). So step 12 does not merely
  move where areas come from — it slightly *improves* their precision. Harmless at these zooms, but it
  means the render is not expected to be pixel-identical, so the parity gate must stay a tolerance check
  and must not become a screenshot diff.

## §7f — The bridge's interim cost: `expose` is O(collection) PER CALL (2026-07-22)

**Steps 9–12 made `view` slower, on purpose and temporarily. Do not read the number as a regression in
the bridge, and do not "fix" it before step 13.**

`view` total went **927 → 1447 ms** at `CPU_THROTTLE=4`. The obvious suspect — step 12's store read
added on top of the still-running text parse — is **not** the cause. A/B on the same binary, removing
only step 9's two-line `release`/`expose` bracket:

| | with bracket | without | delta |
|---|---|---|---|
| **empty-bbox view** (emits NOTHING — scan + bracket only) | **483 ms** | 253 ms | **+230 ms** |
| view, kernel | 1141 ms | 721 ms | +420 ms |
| view, total | 1447 ms | 927 ms | +56% |
| wasm binary | 1 098 479 B | 1 048 840 B | +48 KB |

The empty-bbox row isolates it: no features are emitted, so ~230 ms is the bracket itself. **`expose`
re-runs Phase 3 on every call** — `collect_keyed` → `build_hash_sorted_vec` rebuilds a key-sorted
materialisation of all 1089 tiles, allocates a scratch record, and re-serialises the descriptor
(`ffi_deliver.rs:56`). Not a leak: wasm working set was 254.9 MB with the bracket vs 265.1 MB without.

**Why it is unavoidable right now, and why 13 ends it.** The bracket exists because loft cannot iterate a
store it has pinned (§7d(2)), and `do_view_bbox` iterates the layout to emit its text. So every view must
unpin and re-pin. **Once step 13 deletes the layout text emit, nothing in loft walks the layout** — the
bracket collapses to one `expose` at load, and this cost goes to zero. That makes 13 worth more than its
own row claims: it removes the serialize (~658 ms), the JS parse (~202 ms) *and* this ~420 ms.

Filed upstream in `docs/loft-feedback.md` (2026-07-22) with two asks — cache the flattening on an
unmodified store, or let loft iterate a pinned one (which removes the need to release at all).

**A consequence to design for in 13:** `areasFromStore` scans all 1089 tiles because `emit_areas` does.
When loft stops iterating, JS becomes the only thing that does — so the tile-level pre-filter deliberately
skipped in step 11 (a behaviour change needing its own equality proof) becomes the next real win.

### §7f(2) — Step 13 landed; the prediction held, and the cost moved to JS (2026-07-22)

| phase, `CPU_THROTTLE=4` | before the bridge | step 12 | **step 13** |
|---|---|---|---|
| kernel | 706 | 1141 | **63** |
| parse | 142 | 202 | **12** |
| **storeRead** (JS walk) | — | *(not in the probe)* | **468** |
| render | 72 | 109 | 67 |
| **total** | **946** | 1447 | **606** |
| text emitted | 4.25 MB / 29 144 lines | 4.25 MB | **398 KB / 3 114 lines** |
| empty-bbox view | 261 | 483 | **21** |

**The loft side is essentially gone**: kernel 1141 → 63 ms (18×), and the `expose` bracket collapsed to
one call per session exactly as predicted — `view` no longer touches the layout, so the pin survives.

**The remaining cost is the one §7f named in advance.** `storeRead` is **468 ms of the 606**: JS walking
all 1089 tiles and decoding six kinds, because it inherited `emit_*`'s "scan every tile" shape. That is
now the whole view budget, and the tile-level pre-filter skipped in step 11 is the obvious next move.

**ANSWERED 2026-07-22 — features are NOT clipped, and the naive filter is dead. See §7g.**

**Instrument note.** `timedView` did not perform the store read, so the first step-13 profile read
`total 91 ms` — a view the app never performs. Fixed by adding a `storeRead` phase; the 180 s hard
timeout also had to grow, because it was sized for a probe that no longer exists. Both are the §7e
lesson again: **when a step moves work between layers, the probe that measures that work moves too.**

## §7g — Tile features are NOT clipped to their cell (2026-07-22). The naive viewport filter is dead.

The question §7f(2) said to answer before writing the tile pre-filter. Answered both ways — from the
code and from the data — because either alone would have been a guess.

**The code.** `client/basemap/build_store.loft` keys each feature by its **first vertex only**
(`g0 = geom.item(0); tx = cell_ix(to_fixed(g0.lon), cell)`), then stores **every** vertex as an unclipped
offset from that tile's origin. `encode_areas.loft:5` says it in prose: *"bins its ring into the PTile of
its cell (keyed by the first vertex)"*. So a feature straddling a cell boundary provably can overhang,
by as much as the feature is long.

**The data** — `tools/tile_overhang.loft` over the real enschede store (1089 tiles, `CELL_P = 50000`
≈ 500 m). A feature inside its own cell has `0 <= x,y < CELL_P`; anything else is overhang:

| kind | coords | outside its cell | margin a screen would need | vs a cell |
|---|---|---|---|---|
| areas | 487 038 | 99 243 (**20%**) | 352 974 (≈ 3.9 km) | 705% |
| **buildings** | **1 033 161** | 23 968 (2.3%) | **33 726 (≈ 375 m)** | 67% |
| lines | 39 871 | 9 838 (**25%**) | 805 575 (≈ 9 km) | 1611% |
| labels | 26 787 | 4 964 (19%) | 504 364 (≈ 5.6 km) | 1008% |
| **pois** | 27 912 | **0** | **0** | 0% |

**So a single global margin is useless.** At zoom 16 the app's padded viewport is ≈ 0.047° × 0.032°;
widening it by the worst margin (0.0806° per side) gives a box ≈ **27× the viewport area**, which selects
essentially every tile. A filter built on the "obvious" assumption would have been *worse than nothing* —
and had it been built without the margin, it would have silently dropped 20–25% of area/line/label
vertices near cell edges, which the parity gate catches only when a viewport happens to clip one.

**But per-kind it is very much alive, and it covers the bulk of the data:**

- **pois — margin 0.** Filter freely; a point's tile is derived from the point itself, so it cannot overhang.
- **buildings — margin ≈ 375 m**, which expands the viewport by only ~1.4× in area. And buildings are
  **1.03 M of the 1.61 M coordinates (64%)**, so this alone is most of the `storeRead` budget.
- areas / lines / labels: leave unfiltered, or fix the data (below).

**The better fix is upstream, in the tiles.** Binning by the first vertex is what creates the overhang;
binning by a feature's **bounding box** (or splitting features at cell borders) makes every margin 0 and
the filter trivial and exact. That is a `build_store.loft` change plus a store regeneration — the same
class as step 19's format change, and worth pairing with it rather than doing twice.

**Re-run `tools/tile_overhang.loft` whenever the tiles are regenerated:** the margin is a property of the
DATA, not of the code, so it can move under a filter that hard-codes it.

### §7g(2) — DONE: per-tile feature extent + an EXACT viewport filter (2026-07-22)

**Not bbox *binning*.** Re-binning by bounding box does not reach margin 0 either — a 9 km river does not
fit in a 500 m cell whichever vertex keys it, so only clipping/splitting would, and that changes what a
ring *is*. The exact fix keeps the geometry untouched and records each tile's **actual feature extent**:
`PTile` gains `fcount` + `fmnla/fmnlo/fmxla/fmxlo` (absolute fixed-point), sealed by `seal_extents` after
the geometry vectors are complete. The filter then tests real geometry — no margin, no guess.

**Measured first, on the real store** (`tools/tile_bbox_probe.loft`, one zoom-16 viewport):

| policy | tiles read | features found | missed |
|---|---|---|---|
| ALL — today | 1089 | 33 481 | — |
| ORIGIN — the naive screen | 50 | 33 427 | **54** ❌ |
| **BBOX — shipped** | **72 (6%)** | 33 481 | **0** ✅ |

That the naive screen loses 54 features is the empirical half of §7g: it is not a theoretical hazard.

**Result at `CPU_THROTTLE=4`:**

| | pre-bridge | step 12 | step 13 | **+ filter** |
|---|---|---|---|---|
| storeRead | — | — | 468 | **125** |
| **view total** | 946 | 1447 | 606 | **270** |

**946 → 270 ms, 3.5×**, with every kind still byte-equal to loft's own emit (the `viewtext` gate is what
proves the filter exact — a dropped feature shows up as a count mismatch immediately).

**Two facts about the format change, both learned the hard way:**

1. **It is BREAKING, and it fails SILENTLY.** The committed store (old schema) no longer loads under the
   new one: `store_load` gives no output, no error, exit 1. So `browser/stores/enschede.layout.store` had
   to be regenerated and re-committed, and any deployed copy must be replaced in the same push. The
   `fcount == 0` fallback in the filter is therefore belt-and-braces, not a migration path — it keeps an
   extent-less store *correct* (full scan) rather than blank, but such a store will not load anyway.
   **Worth filing upstream:** a schema mismatch on `store_load` should say so.
2. **The file is byte-identical in SIZE** (20 776 816 before and after) despite 5 new integer fields ×
   1089 tiles — the new fields fit existing record slack. Do not use file size to check whether a
   regeneration took: read a field (`tools/tile_lookup.loft` prints `EXTENT`).

Regeneration is ~21 s: `loft --native-release --lib lib client/basemap/build_store.loft <6 fixtures>
browser/stores/enschede.layout.store` (fixtures are gitignored; they are present locally at ~170 MB).

## §7h — Step 22 attempted and REVERTED: an absolute `DEV_TOL` is the wrong gate (2026-07-22)

**Status: wired, measured, reverted. The tree is clean and the ladder is not live.** PLAN-MATCH §3's
threshold is correctly *tuned* (0 worse accepted) and still makes the app **slower**. Both are true, and
the second was invisible until the ladder was costed rather than just validated.

**The corpus said go.** `tools/corpus_tube.loft` now simulates the ladder and times both tiers:

```
GATE DEV_TOL=900: accepted=13 escalated=12 WORSE_ACCEPTED=0
COST bbox_only=15552ms ladder=8272ms  (53% of bbox-only)
```

**The app said stop.** Wired into `do_match_session_streamed`, the profiler's cold match went
**5899 → 10064 ms** at `CPU_THROTTLE=4`. On the profiler's own sketch:

```
tube: ways=7138  bridged=0  devmax=1047  ms=245
bbox: ways=13077 bridged=0  devmax=1047  ms=538
GATE=ESCALATE  ladder_ms=783  bbox_only_ms=538      ← 1.46x SLOWER for an IDENTICAL result
```

**The mechanism.** `dev_max` measures how far the matched route sits from the **drawn sketch** — mostly a
property of *where the user drew*, not of which corridor was used. A line drawn 1 km from any road has
`dev_max ≈ 1000` under **both** tiers. The gate then reads a large `dev_max` as "the cheap corridor
clipped something" when it actually means "this sketch is far from the network", escalates, and pays the
fat tier to produce the same answer. In the corpus, **8 of the 12 escalations have `t_devmax ==
b_devmax`** (rows 0, 13, 15, 19, 20, 21, 22, 23) — pure loss, by construction.

The corpus average hid this because the *accepted* sketches happen to be the expensive ones (9606, 8066,
9477 ways) while the escalations are mostly sparse. So the aggregate wins while the sketches the app
actually runs lose. **An average over a synthetic corpus is not a claim about a specific interaction** —
the same lesson as §7e, one level up.

**Two candidate redesigns, neither tuned yet:**

1. **Drop `DEV_TOL`; gate on `bridged_m == 0` alone.** §3's own finding 1 says connectivity does most of
   the work (2 of 3 worse cases). Costs: i=7 would be accepted (dev 1003 vs bbox's 484) — 1 worse
   accepted in 25. Cheap to evaluate: re-run the corpus with `DEV_TOL` at infinity.
2. **Make the deviation test SCALE-RELATIVE — the more principled one.** The tube keeps tiles within
   `corridor_margin(pts)` of the polyline, so `dev_max > margin` means the route is straying to where the
   tube's ways run out, while `dev_max <= margin` means it sits comfortably inside and nothing was
   clipped. That tests the *corridor*, which is what the gate is for, instead of the sketch. It also
   self-scales per sketch, so no constant is fitted to a corpus.

**Whichever is chosen, the acceptance criterion must change too.** "0 worse accepted" is necessary and
not sufficient; the gate must also be shown to cost less **on the sketches the app runs**, not only in
corpus aggregate. The step-22 row now says so.

**What was kept:** `tools/corpus_tube.loft` gained the ladder simulation, per-tier timing, and the
`WORSE_ACCEPTED` / `COST` lines — that harness is what caught this, and it is what will tune either
redesign. The kernel wiring itself is reverted; `tools/match_parity.sh` is byte-identical again.

**A note in the ladder's favour, so it is not written off:** on `match_parity`'s case C the tube was
accepted and produced a byte-identical route from **4501 ways instead of 11287**. The tier is genuinely
good; only the gate is wrong.

### §7h(2) — Option 2 shipped: the margin-relative gate, cold match 1.96× (2026-07-22)

`bridged_m == 0 && dev_max <= corridor_margin(pts) * K`. It asks the question the gate is *for* — did the
route stray to where the tube's ways run out? — instead of "did the user draw far from a road?", which is
what an absolute `dev_max` answers and why it escalated 8 cases for nothing.

**K was swept, not chosen.** `corridor_margin` is capped at `CORRIDOR_MAX_M = 200 m` while corpus
`dev_max` runs 339–2390 m, so a literal `dev_max <= margin` accepts nothing and the useful ratio had to
be read off the data. The corpus now includes **the app's own sketch** (i=25) for exactly the reason §7h
records — an aggregate can win while that sketch loses:

| K | accepted | WORSE | ladder cost | app sketch |
|---|---|---|---|---|
| 5 | 11 | 0 | 90% | escalates |
| **6** | **13** | **0** | **83%** | **ACCEPT** |
| 8 | 16 | 0 | 77% | ACCEPT |
| 9 | 17 | **1** | 70% | ACCEPT |

**K = 6, not the cost-optimal 8.** §3's asymmetry decides it: the gate can only make us escalate (spend
more), never accept something the fat tier would improve on — so headroom is cheap and a wrong acceptance
is the only real failure. 6 sits two full steps below the first bad acceptance and still accepts the
sketch the app runs.

**Measured A/B, one quiet machine, `CPU_THROTTLE=4`, every spread 1.1×:**

| | ladder off | ladder on | |
|---|---|---|---|
| **cold match** | 6370 ms | **3253 ms** | **1.96×** |
| warm (one point moved) | ~880 ms | **584 ms** | 1.5× |
| repeat (nothing changed) | ~450 ms | **306 ms** | 1.47× |

The warm/repeat gains were not predicted: the session now *holds* the accepted tube corridor, so every
later incremental match runs over ~half the ways too. The ladder pays twice over.

**Gated on the COLD path only.** Re-gating warm edits was tried and showed a 4.6× spread on the warm
number — an edit that tripped the threshold turned a ~700 ms incremental match into a full corridor
rebuild. It is also redundant: `covered()` already requires every point within `margin * 0.85` of a
corridor this session built, so a covered edit is by construction inside the tube that was accepted.
**`covered()` is the warm-path guard; the gate chooses a tier at build time.**

**A measurement note that nearly cost a wrong conclusion.** The first post-wiring profile showed cold
6903 ms with a **2.0× spread** and warm at **4.6×** — the machine was at load average 25 from sibling-tree
builds. Both the ladder-on and ladder-off numbers above were taken after it quiesced. *A profile without
its spread is not a measurement*, and this repo's own instrument prints the spread for that reason.

**Not wired: `server/server.loft`.** Step 22's row says "server + kernel", but the server keeps its own
`covered()` + corridor logic and an Overpass path with a different accumulate-vs-replace policy that the
corpus does not cover. Wiring it on this evidence would be speculative; it needs its own corpus over the
Overpass path first.

## §7d — Step 9 attempt 1: `expose(1, layout)` hangs the app (2026-07-17)

**Status: reverted, undiagnosed.** The tree is clean and the app works. The observable is built and
committed; the kernel change is not. Whoever picks this up starts here, not from the step-9 row.

**What was done.** One additive line in `client/web_basemap_kernel.loft`, right after the layout store
loads (inside the `layout_url != layout_at` guard, so once per session):

```loft
if store_load_url_trusted(layout, layout_url) {
  layout_at = layout_url;
  expose(EXPOSE_LAYOUT, layout);     // <- this line
}
```

Nothing else changed — the text path still emits every feature, JS still renders from it.

**What happened.** The app **never becomes ready**: `window.__storeApp.ready` stays false through a 100 s
poll, and **no JS exception is thrown** — it is a silent hang or trap, not an error. Isolated properly:
`git stash` + rebuild the wasm ⇒ `tools/map_profile.sh` runs green; restore + rebuild ⇒ dead again. So it
is this line, not the harness and not a pre-existing break.

**The tooling is the deliverable of this attempt.** `tools/expose_probe.sh` → `browser/cdp_expose.mjs`
asserts step 9's observable where the call actually lands (the host import), and will fail loudly instead
of silently: expose called exactly once, descriptor parses (not `{__parseError}`), `storeBase`/`rec`
nonzero (`rec == 0` is `expose_value`'s early return).

---

### §7d(2) — DIAGNOSED 2026-07-22: it is the ITERATION, and there is a one-line fix

**Status: root-caused off-browser on the installed 2026.7.2, in one native run — and step 9 has since
LANDED on this diagnosis and is green.** The hypothesis above was right, and the "other cells" table was
never needed. Full write-up in `docs/loft-feedback.md` (2026-07-22).

**Two things the landing turned up that the diagnosis did not predict:**

1. **`release` pulls in a NEW host import** — `loft_host_release`. The shim did not provide it, so the
   wasm failed to instantiate outright (`LinkError: Import #5 "loft_io" "loft_host_release": function
   import requires a callable`). A loud, immediate failure, unlike the silent trap the pin causes —
   added to `browser/store-kernel.mjs`, where it drops the stale handle.
2. **The observable itself had never passed, and two bugs were hiding behind that.** It read
   `window.__storeKernel`, a global the app never publishes (the handle lives on `window.__perfHooks`),
   and it only ever called `process.exit` on the FAIL path — so the first genuine PASS hung forever on an
   open WebSocket. Both were latent from the day it was written: a probe that has only ever failed has an
   **untested success path**, and step 3's rule (*a probe gates a block*) is worth nothing if the gate
   cannot report green. Fixed with the step.

**The mechanism.** `expose` pins the store read-only (`lock_store`). `do_view_bbox` then **iterates** the
layout (`for t in layout` in `emit_areas`/`emit_buildings`/…), and **iterating a store-backed keyed
collection claims a 546-byte cursor record inside that same store.** The pin rejects the claim:

```
thread panicked at src/store.rs:647:9:
Claim on read-only store (size=546) (locked by: lock_store(store_nr=1, rec=1))
```

In wasm that panic is a silent trap — the kernel dies mid-command, never emits `#EOR`, the page waits
forever. That is exactly the "never becomes ready, no JS exception" symptom above.

**Reads are NOT the problem** — this is the narrowing that makes the step buildable. Each row its own
process, real 20 MB store, `loft --native`:

| after `expose(1, layout)` | result |
|---|---|
| `len(layout)` · `layout[key]` · field reads · text interpolation | ✅ all fine |
| **`for t in layout { }`** — empty body | ❌ panic |

**The fix — bracket loft's own walk:**

```loft
expose(EXPOSE_LAYOUT, layout);   // pin: JS reads PTiles from wasm memory
…
release(EXPOSE_LAYOUT, layout);  // unpin before loft iterates
do_view_bbox(layout, roads, arg3);
expose(EXPOSE_LAYOUT, layout);   // re-pin (verified: re-expose works)
```

Verified natively: `release` restores iteration (`ITERATE AFTER RELEASE OK n=1089`) and the subsequent
`expose` succeeds. This also restores the **additive migration order** steps 10–13 depend on — land the JS
reader beside the text path, compare, then delete the text path — since loft can unpin, emit, and re-pin
during the overlap. Once step 13 deletes the text emit, nothing in loft iterates the layout and the bracket
collapses back to a single `expose` at load.

**Correction to the method note below: `expose` IS probeable off `--html`.** Only the *host-call* half of
`expose_value` is `cfg`-gated to wasm; `lock_store` runs on **every** target (`ffi_deliver.rs:80-84`). The
whole diagnosis came from adding one line to `client/basemap_kernel.loft` — the path-loading twin of the
browser kernel — and running it natively against the same store files. **When a browser-only symptom has a
non-browser code path underneath it, probe that path first; a `cfg` on part of a function is not a `cfg` on
the function.**

**Superseded method note (kept because the reasoning error is the lesson).** This section used to end with
a rule that *every* probe of `expose` must go through the browser. That was false, and believing it is what
made this cost an afternoon in Chromium instead of a minute at the shell. The observation behind it was
real — `expose` printed nothing on the plain backend — but the inference was not: silence meant the *host
call* was gated, not that the *function* was inert.

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