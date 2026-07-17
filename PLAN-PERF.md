<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-PERF — making the standalone app fully performant

**Status:** steps 1–16 IMPLEMENTED (2026-07-17); 17–22 open. **Plan of record for app performance.** It
does not supersede `PLAN-MATCH` (the matcher's own ladder) — it measures it and ranks it against
everything else.

**What landed** (all at `CPU_THROTTLE=4`, route proven byte-identical by `tools/match_parity.sh`):
a click moving a point **4481 → 711 ms**; a repeat match **5274 → 339 ms** (15.6×); stores loaded **once
per session** (2 fetches for 16 commands, was ~2/command); a real 40-point route's worst frozen frame
**11095 → 744 ms** — the route now **streams per stretch**, arriving in travel order.
**Open:** the view path (9–13, blocked upstream — see §2b and `docs/loft-feedback.md`), the render budget
(14–15, ~13 fps panning, independent of loft), `par` (17–18), the cold match (19–22).

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
| **9** | `client/web_basemap_kernel.loft` | `expose(1, layout)` once after the session load (§2b: `expose` pins the store; JS reads it each frame). | JS receives descriptor + storeBase/rec/pos | none |
| **10** | `browser/store-kernel.mjs` | Implement the `loft_host_deliver` import; wire `readLoftValue` (`doc/loft-deliver.js`). | one PTile read in JS == the kernel's text for that tile | none |
| **11** | `browser/map.mjs` | Read **areas only** via `readLoftValue`, **beside** the text path; compare in the gate. | JS-read areas == text-parsed areas | none (text still drives render) |
| **12** | `browser/map.mjs` | Switch render to the JS-read areas; keep the text emit as the **parity gate**. | `# view:` A= count identical | **render source** |
| **13** | ×4 + kernel | Repeat 11–12 per kind (buildings, lines, labels, pois); then delete the layout text emit. | counts identical per kind; serialize → ~0 | one kind per commit |
| **14** | `browser/map.mjs` | Pre-project geometry into typed arrays once per view, not per frame. | pan frame time falls | **perf only** |
| **15** | `browser/map.mjs` | Cache per-tile rasters; blit on pan. | pan <16 ms/frame | **perf only** |
| **16** | `lib/routing_kernel` + kernel | **Stream per stretch** (§6b A): emit each `SubPath` as it is matched, `frame_yield()` between. | first segment on screen ~96 ms; line grows ~10/s; no frozen frame | **presentation** |
| **17** ✅ | throwaway probe | **DONE.** `par` workers can't read a captured reference — the data must go in the ELEMENT. Measured ~4× with a small slice; the copy eats it at 10k. See §6b B. | boundary + scaling established | none |
| **18** | `lib/routing_kernel` | **Slice the corridor per stretch** into self-contained jobs, then `par` over them (threads from `hardwareConcurrency`). NOT the `Scratch` refactor this row used to say. | ~4× native/Android; route identical over N runs; slice size is the design question | **perf only** |
| **19** | `tools/gen-tiles.loft` + kernel | Persist the **built graph** (PLAN-TILES §268); load instead of build. | identical route; cold match −~41% | **perf only** |
| **20** | `lib/routing_kernel` | Cell-tube corridor **beside** bbox; bbox still default. | tube ⊂ bbox; way-count drops | **none** (inert) |
| **21** | — | Corpus compare: cheap vs fat tier on the §7 quality numbers. | the table that tunes the gate | none (offline) |
| **22** | `server` + kernel | Wire the §3 gate + escalation; fat corridor stays the floor. | quality tracks fat where the gate accepts | **⚠ route-affecting** |

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

### Order

```
A  stream per stretch + yield        ← fixes the LAG. No loft change, no route change, works today.
B1 per-worker Scratch                ← un-share the one mutable. Prerequisite for par; no behaviour change.
B2 par(…) over stretches             ← ~3x on native/Android today; browser gated on loft C3 + COOP/COEP.
```

A is independent of everything and should land first: it is the only one that changes what the app *feels*
like, and it needs no permission from anyone.

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
