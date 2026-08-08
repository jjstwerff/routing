<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->

# Getting loft out of the view path — the `expose` bridge and what it cost

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-03 · **Owns:** how JS reads the layout store straight from wasm memory, and the two bridge rules that cost a day

`PLAN-PERF` §4, §5, §7c, §7d, §7f and §7g. **loft does the ROUTE, JS does the MAP** — the layout
store is view-only, `view` emits roads only, and JS reads the rest through @PLN105's `expose`
bridge. Two rules here were each learned the expensive way: **`expose` pins the store read-only and
loft then cannot ITERATE it**, and **`expose` is O(collection) per call**, so calling it per frame
is not viable. ⚠ §7g is the third: **tile features are NOT clipped to their cell**, so the obvious
viewport filter provably drops features.

⚠ **Section numbers are global to `PLAN-PERF.md`** — they were not renumbered when this file was split out, so a citation of `PLAN-PERF` §7g still resolves. Its *Where each section lives* table says which file holds which §. **`PLAN-PERF` §0 is still the step list, and §1 the invariant every step is judged against.**

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
