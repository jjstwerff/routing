<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-PERF — making the standalone app fully performant

**Status:** design. Nothing here is implemented. **Plan of record for app performance.** It does not
supersede `PLAN-MATCH` (the matcher's own ladder) — it measures it and ranks it against everything else.

**Target device is a phone.** Judge every number in the 4× column; the desktop column is only there to
show how badly a desktop profile flatters us.

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

### Two premises this falsified

**"The text bridge is the front-end bottleneck"** (`docs/loft-binary-bridge.md`, which asked loft for
@PLN105 `deliver`, and loft shipped it): JS parse is **157 ms of 1121** and `match` emits **4 KB**, so the
bridge saves a click *nothing*. The premise was true when `view` emitted the whole region; `199e7c7`
(viewport-scoped view) already fixed it.

**"loft must be in the view path":** `view` does no computing — it is `ring_hits()` (an integer bbox
compare) plus `ring_text()` formatting. The store is its own serialization (HANDOFF's no-codec bet), so
JS can read the records. **loft does the ROUTE; JS does the MAP.**

---

## 3. Phase S — the session (the bug)

**Do first. This is not an optimisation; it is restoring a fast path the app already had.**

**Invariant:** *a kernel session holds what does not change — decoded stores, the built graph, the
MatchState — and each command does work proportional to the diff.*

**Re-assertion sites: 1** — the kernel's command loop. Omission is loud (a stale/empty session draws
nothing or re-matches everything, and the profiler reports it).

| step | change | verify |
|---|---|---|
| S1 | Kernel becomes a **session**: load stores on first command, reuse after. | 2nd+ call drops ≈355 ms (view) / ≈14 ms (match) |
| S2 | Session holds the corridor `Graph` + `MatchState`. Port `covered()` + `match_incremental` from `server/server.loft` — **it exists; do not rewrite it.** | a click that adds one point re-matches only the edited window |
| S3 | Client sends the **diff** (add/move/remove point), not the whole sketch. | command blob is O(1) per click |
| S4 | `view` re-emits only the newly-exposed cells, not the whole viewport. | a small pan costs ≈ the new strip |

**Predicted (phone):** click **4481 → ~200 ms** (40–68 ms × 4), pan past the box → the new strip only.
**Falsification probe:** the server's 40–68 ms is a *desktop, native* number over a tile block. Before
building S3/S4, port S2 alone and measure one warm click on the phone profile. If a warm incremental
click is not ≈10–20× cheaper than a cold full match **on this data**, the premise is wrong and the win
is smaller — find out with S2 before designing the diff protocol around it.

**Risk:** the session is now state, and state goes stale (a moved point that invalidates a cached
window). `server/server.loft` already solved this — `covered()` is exactly that guard. Port its logic;
do not invent a second one.

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

## 6. Phase R — never block a frame

**Invariant:** *no user-visible frame waits on the kernel; the main thread only renders prepared data.*

| step | change | verify |
|---|---|---|
| R1 | Kernel → **Web Worker**; `runKernel` becomes postMessage/await. The `--html` shim already talks over `host_input()`/`println`, a channel a worker can host; store fetch is `fetch()`, which workers have. | `frameBlocking`: match lands ~all frames, longest gap ≈16 ms. Totals unchanged — that is the point. |
| R2 | UI stays live during a match; a new click supersedes the in-flight one. | a click during a match does not queue behind it |
| R3 | **Render budget:** 76 ms/frame ⇒ ~13 fps panning *with no kernel call at all*. Redraw from pre-projected typed arrays; cache per-tile rasters and blit on pan. | pan holds <16 ms/frame |

**Falsification probe:** if the wasm kernel cannot run in a worker (an `--html` shim assumption, an
asyncify constraint), R1 is dead as written and the fallback (chunking the call so it yields) is much
worse. Probe it on day one.

**Ordering note:** S shrinks the work so far that R1 matters mainly for the *rare* cold match — but R3
is independent of everything else, because 13 fps panning is lag the kernel never touches.

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
S2 probe: is a warm incremental click really ~10–20× cheaper on THIS data?
        ↓
S — the session: stores + graph + MatchState; click = diff, not rebuild   ← THE BUG
        ↓
A1 probe: can JS read the fetched image?   →   A — loft out of the view path
        ↓
R3 (render budget, independent)  ·  R1 (worker — for the rare cold match)
        ↓
C0 (trust the number)  →  C4 (persist the graph — route-neutral)  →  C1–C3 (the ladder)
        ↓                                        the outlier gets a budget too: ≤ ~500 ms
```

| interaction | today **phone** | after S | after S+A | after S+A+R |
|---|---|---|---|---|
| **click** (add/move a point) — *time* | **4481 ms** | **~200 ms** | ~200 ms | ~200 ms |
| **click** — *frozen* | **4212 ms** | ~200 ms | ~200 ms | **~0** |
| **pan** (past the box) — *time* | 1121 ms | new strip only | **~150 ms** | ~150 ms |
| **pan** — *frozen* | 779 ms | — | — | **~0** |
| **pan** frame rate | ~13 fps | 13 fps | 13 fps | **60 fps** (R3) |
| **cold full match** (rare, but still needs a budget) | **4481 ms** | 4481 ms | 4481 ms | **~500 ms** (C4 + ladder) |

**S is the whole game.** It takes a click from 4.5 s to ~200 ms by not doing the work — and it does so by
*restoring code the server already runs*, not by inventing anything.

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
