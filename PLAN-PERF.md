<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-PERF — making the standalone app fully performant

**Status:** steps 1–16 IMPLEMENTED (2026-07-17); 17–22 open. **Blockers re-validated 2026-07-22** against
the installed loft **2026.7.2** (reinstalled 09:01) — see §7c: **nothing is blocked upstream any more.**
Step 18's copy cost is gone (@PLN108 landed and is active — flat vs heap and vs thread count), and step 9's
hang is root-caused with a working in-language fix (§7d). All four gates pass on 2026.7.2 unchanged,
including through the @PLN110 len/size flip. **Plan of record for app performance.** It
does not supersede `PLAN-MATCH` (the matcher's own ladder) — it measures it and ranks it against
everything else.

**What landed** (all at `CPU_THROTTLE=4`, route proven byte-identical by `tools/match_parity.sh`):
a click moving a point **4481 → 711 ms**; a repeat match **5274 → 339 ms** (15.6×); stores loaded **once
per session** (2 fetches for 16 commands, was ~2/command); a real 40-point route's worst frozen frame
**11095 → 744 ms** — the route now **streams per stretch**, arriving in travel order.
**Open:** the view path (9–13 — unblocked, see §7d for the fix step 9 needs), the render budget
(14–15, ~13 fps panning, independent of loft), `par` (17–18 — unblocked 2026-07-22), the cold match (19–22).

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
| **13** | ×4 + kernel | Repeat 11–12 per kind (buildings, lines, labels, pois); then delete the layout text emit. | counts identical per kind; serialize → ~0 | one kind per commit |
| **14** | `browser/map.mjs` | Pre-project geometry into typed arrays once per view, not per frame. | pan frame time falls | **perf only** |
| **15** | `browser/map.mjs` | Cache per-tile rasters; blit on pan. | pan <16 ms/frame | **perf only** |
| **16** | `lib/routing_kernel` + kernel | **Stream per stretch** (§6b A): emit each `SubPath` as it is matched, `frame_yield()` between. | first segment on screen ~96 ms; line grows ~10/s; no frozen frame | **presentation** |
| **17** ⚠ | throwaway probe | **DONE but its CONCLUSION WAS WRONG** — kept only as the record of a mis-read. I read *"only the loop element may be a reference"* as "workers can't read captured state, put the data in the ELEMENT". loft's THREADING fix (`97af1b52`, my own finding) says the opposite: **large state is CAPTURED read-only and never passed** — only *extra scalar args* have that restriction. See §6b B, which is superseded. | — | none |
| **18** | `lib/routing_kernel` + kernel | **UNBLOCKED 2026-07-22 — design it.** `par` over the stretches (§6b B). The blocker was `clone_for_worker()` byte-copying every ACTIVE parent store per worker, so par's cost tracked the **session's live heap** (RSS ~175 MB) rather than the workload — 0→122 MB of *unrelated* heap took a fixed workload **2 → 205 ms**, and 1→16 threads took it **36 → 178 ms**. On the installed **2026.7.2** that is **flat**: 1–3 ms across 0 / 61 / 122 MB and across 1 / 8 / 16 threads, with `LOFT_PAR_SHARE` **unset** (sharing is now the default dispatch; upstream `ae0c266b`, "@PLN108 par-store single-impl"). Re-measured with the same `tools/par_copy_probe.loft` that reported the blockage, per this row's own unblock criterion. **Read §6b B, not step 17's row** — 17's conclusion ("put the data in the ELEMENT") was a mis-read; large state is CAPTURED read-only. | `tools/par_copy_probe.loft` stays flat vs heap; route byte-identical (`tools/match_parity.sh`); ~3× native on the stretch loop | **perf only** |
| **19** | `tools/gen-tiles.loft` + `lib/routing_kernel` + kernel + **regenerate the stores** | Persist the **built graph** (PLAN-TILES §268) — a TILE FORMAT change, not a one-liner. See §7a. | identical route across a tile border; cold match −~41% | **perf only, but format-breaking** |
| **20** ✅ | `lib/routing_kernel` | Cell-tube corridor **beside** bbox; bbox still default. `tools/tube_probe.loft`. | **DONE** — drops 43–60% of the ways, read −40…−64%, **route identical** on all 3 sketches. See §7b. | **none** (inert) |
| **21** | — | Corpus compare: cheap vs fat tier on the §7 quality numbers. | the table that tunes the gate | none (offline) |
| **22** | `server` + kernel | Wire the §3 gate + escalation; fat corridor stays the floor. **Thresholds tuned** — PLAN-MATCH §3: `bridges == 0 && dev_max <= 900` (cycling_road); PEN_TOL unusable on this corpus. | corpus: 0 worse-accepted; re-run `tools/corpus_tube.loft` after wiring | **⚠ route-affecting — the only one** |

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