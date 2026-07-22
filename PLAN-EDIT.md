<!-- Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-EDIT — the rough-layer editor, on the canvas seam

> **Status (2026-07-22): re-seated and open.** The 2026-07-12 version of this doc was written against
> **Leaflet** and deferred with the note *"editing must be built once, on the canvas renderer's seam"*.
> [PLAN-MAP](PLAN-MAP.md) has landed, so that condition is met and this doc is rewritten against
> `browser/map.mjs` + `browser/store-app.mjs`. The **invariant survived the re-seat; the mechanisms did
> not** — §2 and §3 record which of the old doc's claims the probes killed.

**Goal.** The standalone app can **append** to a sketch and nothing else. `DESIGN.md` §1 makes editing the
rough layer *the* interaction — *"Correcting a wrong match = move the points, not the line"* — so the
missing half is: **see the sketch · insert · drag · delete · bulk-delete · undo.**

This is a **port**, not a redesign. The working implementation is **`rough.js`** at the repo root (366
lines, Leaflet, from the pre-loft-native app); `DESIGN.md` §1 is the design of record. Nothing here touches
the matcher — §2's probe P5 proves the kernel already supports every edit shape.

---

## 1. The one principle — only the rough layer is editable

**The rough sketch is the single source of truth and the ONLY editable geometry.** The matched line is a
pure function of the sketch and is never edited directly (`DESIGN.md` §1). To fix a wrong match you nudge a
**rough** point and re-match; *zoom is precision*, and the steering falls out of the matcher's deviation
cost — **no extra mechanism**.

---

## 2. Probes first — five premises tested against the running app

Run before designing, because the old doc's premises were eight weeks and one renderer stale. Driver:
`Input.dispatchMouseEvent` over CDP against `_site`, the same harness `tools/map_render_gate.sh` uses.
**Four of five came back ⚠.** Each is now a required assertion in §6.

| # | premise | verdict |
|---|---|---|
| **P1** | *"the app appends reliably; editing is the missing half"* | ⚠ **FALSE — a pan drag appends a spurious point.** `map.mjs:654` binds `mousedown`→pan-grab, `store-app.mjs:141` binds `click`→append; a browser fires `click` after a mouseup on the same element even if the pointer moved 200 px. Measured: drag (300,200)→(500,267) ⇒ **1 rough point** and a moved camera. Invisible for two months because a rough point renders as one unlabelled 4-px dot. |
| **P2** | *"`DOUBLE_TAP_MS` is Leaflet ceremony"* | ⚠ **FALSE — a double-click double-adds.** Two points at one spot. `rough.js`'s 250 ms / 12 px dedupe is load-bearing here too, and is a **precondition** for double-click-to-delete. |
| **P3** | *"draw the rough layer via the `onRender` seam"* | ⚠ **FALSE — `onRender` fires with `map._origin === null`**, i.e. *outside* the step-15 snapped-origin block (`map.mjs:909`). A line drawn there sits up to one device pixel off the map under it — the exact defect `map.mjs:905` records having already been fixed once for the sketch dots. **The seam must be extended, not consumed.** |
| **P4** | *"append is stale-free; only editing needs a chokepoint"* | ⚠ **FALSE — a click during a match is silently dropped.** `store-app.mjs:147` reads `if (sketch.length < 2 \|\| busy) return;` — the point is added, the re-match is not. Measured: 4 points, last two clicked 120 ms apart ⇒ the route ends **1417 m** from the last rough point. `busy` is also **shared with `ensureView`**, so a map load in flight swallows a match too. |
| **P5** | *"`match_incremental` covers insert/move/delete — no kernel work"* | ✅ **TRUE.** Insert and delete stay in the warm band, far from cold. |

**P5, measured** (`CPU_THROTTLE=4`, medians of 5, against the app's own `__perfHooks` baselines):

| | cold | repeat | warm (move) | **insert** | **delete** |
|---|---|---|---|---|---|
| ms | 1695 | 385 | 545 | **422** | **357** |

⚠ **The numbers are not publishable — the box was at load average 10 and the spreads are 1.24–2.44×**
(`CLAUDE.md`: *a profile without its spread is not a measurement*). The **verdict** survives the noise —
insert/delete sit at ~¼ of cold, in the same band as a move — but re-record the ms on a quiet box before
quoting them. The quiet-box references are cold **1450** / warm **343** (HANDOFF §1).

*A note on how P5 was nearly reported backwards.* The first run labelled a **warm repeat** "cold", making
insert/delete look like cold fallbacks. `store-app.mjs:862` documents that exact trap — *"two different
interactions wearing each other's names"* — and the app already ships the honest baselines
(`matchTrueCold` issues `reset`). **Use `__perfHooks`; do not hand-roll a baseline.** What `__perfHooks`
genuinely lacks is `matchInsert` / `matchDelete`, which E7 adds.

---

## 3. What did NOT survive the re-seat — the mechanism was Leaflet's, not the design's

**The "two stacked polylines" are not the load-bearing trick.** `rough.js` draws a fat `opacity: 0`,
`weight: 18` hit line under a `interactive: false` visible line. On a **canvas there is no hit testing at
all** — a transparent stroke is not a tap target, it is nothing. Porting the stacked pair literally
produces a decoration that catches no events.

What actually transfers is the **tolerance and the priority order**, which the stacked pair was merely
Leaflet's way of expressing:

| `rough.js` (Leaflet) | here (canvas) |
|---|---|
| `HIT_WEIGHT = 18` transparent polyline | segment hit if perpendicular screen distance **≤ 9 px** |
| `TOUCH_BOX = 30` marker icon | point hit if within **15 px** of the point |
| z-order: marker above hit line above map | explicit order: **point → segment → empty map** |
| `interactive: false` on the visible line | (nothing — a canvas stroke never receives events) |
| `L.LineUtil.closestPointOnSegment` | our own point-to-segment, in **screen** px via `seam.project` |

This is the over-unification guard of Design Protocol 1 applied to a *port*: the elegant-looking mechanism
was an artifact of the old substrate. Keep the constants, discard the trick.

**Also dead:** `map.mjs`'s `hitTest(x, y)` is a **stub returning `null`** (`map.mjs:1500`) and `seam`
exposes it. The old doc said the editor "rides the seam"; in fact the editor must **build** it.

---

## 4. The invariant, and the three points that enforce it

**Invariant.** *Every pointer event enters the app at exactly one place and leaves as at most one sketch
mutation; every sketch mutation leaves at exactly one place; and the sketch is the only state in between.*
A gesture never tested (insert-then-drag, delete-to-one-point, drag-during-a-match) is correct because it
is **a sketch mutation like every other**, and there is only one road in and one road out.

The old doc named **one** chokepoint (commit). P1 and P4 prove that is **necessary but not sufficient** —
both failures happen where no commit exists yet: one in input dispatch, one in scheduling. The pipeline is
`pointer → gesture → sketch → commit → schedule → match → render`, and it needs its **two ends and its
throttle** pinned:

1. **Input (`onPointer`)** — one `pointerdown`/`move`/`up` handler owns the canvas. It hit-tests, classifies
   the gesture (**pan · move-point · insert-sweep · delete · append**), and *delegates* pan to the camera.
   Nothing else binds a pointer or click listener. → kills **P1**, **P2**.
2. **Commit (`commitEdit(committed)`)** — the only function that reads the sketch, redraws it, requests a
   match and (if `committed`) records undo. Every gesture ends here; nothing else calls the matcher.
3. **Schedule (`requestMatch`)** — **at most one match in flight and at most one pending; a new request
   REPLACES the pending one.** → kills **P4**, and makes a live drag affordable.

**Re-assertion-site count.** Today input has **N = 2** owners (`map.mjs` pan, `store-app.mjs` append) that
do not know about each other, and commit has **N = 2** (the click listener and the `__match` hook). Both
are **silent** when they disagree — P1 is a wrong point, P4 is a stale route, neither throws. Each new
gesture would add another site to both. The design drives **N → 1 at each end**, so a forgotten
re-assertion becomes impossible rather than merely unlikely.

**Over-unification guard.** Two absorptions to refuse:
- **Do not fold pan/zoom into the sketch model.** The dispatcher *classifies* a drag as pan, then hands it
  to `map.panTo` — one classifier, two owners. Camera state is not sketch state.
- **Do not fold the matched line into the editable-point model.** It is read-only and derived
  (`DESIGN.md` §1). Keeping it separate is the design, not an omission.

**Why the schedule chokepoint is not over-engineering.** A warm match is **545 ms throttled**. A 60 fps
drag emits ~33 commits per second of movement. Queue them and a 2-second drag owes **66 matches ≈ 36 s**;
drop them (today's `busy`) and the route is stale on release. Coalescing to *latest-wins* gives ~2 matches
per second of drag and a guaranteed-correct final one. This is `DESIGN.md` §1's own **two-tier feedback**:
the **rough line and its length follow the finger every frame** (pure JS, free), the **matched route is
lag-tolerant**. The old doc's *"drag re-matches every frame — acceptable"* was written when a server did
the matching; it is false on a phone.

---

## 5. Failure paths (enumerated before coding)

| | failure | disarmed by |
|---|---|---|
| 1 | a pan appends a point (**measured, P1**) | chokepoint 1: a drag past the slop radius is a pan, and a pan never commits |
| 2 | a double-click double-adds (**measured, P2**) | 250 ms / 12 px dedupe in chokepoint 1 — and it is what makes dblclick-delete possible |
| 3 | the rough line sits a device pixel off the map (**measured, P3**) | draw inside the snapped-origin block, beside `drawRoute` — **not** via `onRender` |
| 4 | an edit during a match is dropped → stale route (**measured, P4**) | chokepoint 3: latest-wins pending slot, never a drop |
| 5 | the rough line is baked into the block raster and goes stale on every point move | it is an **overlay**, drawn per frame; it never touches `_drawBase` and never calls `invalidateBlocks()` |
| 6 | a drag queues 33 matches/second | chokepoint 3 + rough-line-only live feedback |
| 7 | insert picks the wrong segment | nearest segment judged in **screen pixels** (what the user saw), not degrees |
| 8 | delete below 2 points | `commitEdit` matches only at `≥ 2`; below that it clears the route and says so — no throw |
| 9 | touch has no dblclick or right-click | tap-select + a **Delete** button (+ `Delete`/`Backspace` on desktop) |
| 10 | a match in flight when the sketch changes blends two routes into `_stretches` | `beginStretches()` already restarts a pass (`map.mjs:553`, gated in `map.test.mjs`); the coalescer must call it per accepted match, and a superseded match's stretches must be discarded by generation number |
| 11 | `map.points` and `sketch` are two copies of one truth (**exists today**: `store-app.mjs:145` rebuilds `map.points` from `sketch` every click, so resetting `map.points` silently does nothing) | one `RoughLayer` owns the ordered list; `map` holds a reference, never a copy |
| 12 | the sketch is lost on a pan because points are stored in screen space | points are `{id, lat, lon}`; screen space exists only inside a gesture |

---

## 6. Steps — each one commit, one observable, gates green

> **E0 is the falsifier and ships first**: it fixes two measured live bugs (P1, P4) while adding **no**
> gesture, so its check is "today's behaviour, minus the defects". E1 is what answers the user's actual
> complaint (you cannot see your sketch), and can follow the same day.

### E0 — the three chokepoints *(no new gesture)* ✅ **DONE**
- **Built.** `browser/rough.mjs`: `RoughLayer` owns `[{id, lat, lon}]` **and all pointer input**
  (`pointerDown/Move/Up`, screen-space and DOM-free so the classifier is unit-testable), `commitEdit`, and
  `KernelQueue` — one job at a time, coalescing per key. The canvas `click`→append left `store-app.mjs`
  and the pan binding left `map.mjs`'s `enableInteraction`; pan is now the explicit `map.dragTo(mouse,
  grab)` the dispatcher calls. `busy`/`again` are gone: **view and match are separate keys on one queue**,
  so neither can swallow the other. `window.__match` was moved onto the queue too — a hook that reaches
  the kernel by a private road cannot catch a scheduling bug.
- **Measured.** P1 pan ⇒ **0** points (and the camera still pans) · P2 double-click ⇒ **1** point ·
  P4 the route ends **15 m** from the last rough point, *was 1417 m*. `tools/match_parity.sh`
  **byte-identical** across all 5 cases / 3 distinct routes; `make test-map` green including every bridge
  probe.
- **Two extra invariants the runtime cannot see**, so they are grepped in `tools/map_render_gate.sh`:
  every pointer/click listener lives in `rough.mjs` (4, one dispatcher), and the app reaches the kernel
  from **exactly 2** places, both inside queued jobs. A second road to either is invisible at runtime until
  the two disagree — which is precisely how P1 and P4 survived two months.
- ⚠ **A note for E1–E6:** `map.points` and the layer's array are now **the same array**. Mutate it in
  place (`push`, `splice`, `length = 0`); re-assigning `map.points` re-opens failure path 11.

### E1 — the sketch is visible *(the original complaint)* ✅ **DONE**
- **Built.** `map.drawRough()`, called in the overlay pass **inside** the snapped-origin block beside
  `drawRoute()` and *above* it (the thing you can grab is the thing on top). Styling ported verbatim from
  the Leaflet client's `styles.css` so the two apps look the same: dashed line `#2b6cff` / width 3 /
  alpha 0.9 / dash `6 7` / round caps, and dots with a 2 px white ring and a soft drop shadow —
  **start `#17b26a` 18 px · mid `#2b6cff` 14 px · finish `#f04438` 18 px**. Roles are positional, so an
  insert or delete re-roles the ends with no bookkeeping. `render()` now reports `_stats.rough`.
- **The seam was FIXED, not doubled.** The plan said to add an overlay hook beside `onRender`. `onRender`
  had **no consumers**, and `map.mjs:12` already advertises it as *"what PLAN-EDIT builds on"* — so the
  honest repair was to move it inside the snapped block rather than leave a documented trap next to a new
  hook. One seam, now correct.
- ⚠ **`renderSnappedDirect` had to learn the same overlays.** It drew route + labels but never the dots,
  so it and `render()` were already producing different pictures — harmless while the sketch was 4-px dots
  drawn only by one of them, and a false "rasterisation difference" in the block-cache gate the moment the
  sketch grew a line. Both paths now draw the same three overlays.
- **Checked.** `map.test.mjs`: `drawRough` sees a **live snapped origin** via `renderSnappedDirect` (the
  one path that snaps without a DOM), the origin is restored afterwards, the `onRender` hook and the sketch
  see the *same* origin, roles are positional, and the sketch draws **above** the route. Browser: the
  sketch's own pixels are isolated — a box on the segment *between* two points is captured, the points are
  hidden, and it is captured again; **3/3 mid-segment samples change**, which only a line can explain.
  (Colour matching was rejected: the route's `#1a73e8` and the sketch's `#2b6cff` are near-neighbours and
  alpha 0.9 over the map shifts both.)
- ✅ **The predicted hash churn did not happen.** §6c/§6d's `917244eb` is **unchanged**, because the parity
  and block captures run before any sketch exists. The comparisons are path-vs-path on identical state, so
  a sketch present would shift both sides equally — the printed value depends on gate ORDER, the verdict
  does not. Nothing to re-record.

### E2 — hit test + insert (tap and sweep) ✅ **DONE**
- **Built.** `RoughLayer.hitTest(x, y)` → `{kind:'point'|'segment', index, d, t}` or null, screen-space,
  priority **point (15 px) → segment (9 px)**, over pure `pointToSegment` / `nearestSegment`. Press on a
  segment inserts at `index+1` **uncommitted**, `pointermove` repositions it live, `pointerup` commits
  **once** — insert-and-position is one gesture and one edit. A plain tap on the line inserts at the press;
  a press on a *point* is inert (reserved for E3) and, critically, does **not** fall through to append.
  A cancelled sweep still commits — its point is on the map either way.
- **The stub was deleted, not filled.** `map.hitTest` returned `null` and `seam` exported it, but hit
  testing decides *which gesture a press is* — it is input classification, so it belongs beside the
  tolerances in `rough.mjs`. Filling in the stub would have left the geometry in one file and the decision
  in another; keeping it would have left a second `hitTest` answering `null` forever in the file the header
  comment points readers at.
- ⚠ **E2 SUBSUMED the P2 dedupe, and E0's port of it had to be removed.** A tap appends a point **at** the
  press, so the second click of a double-click lands within `HIT_POINT_PX` (15) of it and resolves to that
  **point** — and 15 > `DOUBLE_TAP_PX` (12), so the timer could never fire first. It was not merely dead
  but **harmful**: it keyed on *screen* position, which a pan invalidates, so tap → flick → tap-the-same-spot
  inside 250 ms swallowed a legitimate point that no longer had anything under it. P2 is now enforced by
  **priority**, which is stronger (it holds at any delay). **E4's double-click-to-delete needs its own
  detector keyed on the point's `id`, not a screen spot** — the same reason in reverse.
- **Checked.** Unit: `pointToSegment` incl. both clamped ends and a zero-length segment; priority (a press
  satisfying *both* tests resolves to the point); both tolerance boundaries; a one-point sketch has no
  segment; the sweep inserts once, uncommitted, follows the finger, and commits exactly once; a second
  press at the same spot hits the **new point**, so the line cannot be double-inserted; and the
  screen-vs-degrees case — an L-shaped sketch where degrees picks segment 0 and screen picks segment 1, so
  a drift back to degrees fails loudly. Browser: press-on-line + drag ⇒ **ids `5,7,6`** — spliced between
  its neighbours, at the release position.

### E3 — drag a point ✅ **DONE**
- **Built.** A press on a point captures it; `pointermove` moves it and redraws the sketch every frame;
  the matched route trails through the coalescer; `pointerup` commits **once**.
- **The sweep and the drag turned out to be ONE gesture.** E2's insert-then-position and E3's drag differ
  only in whether the point existed beforehand, so they collapsed into a single `move` gesture carrying a
  `created` flag. That flag is not decoration — it decides the release: a press on an existing point that
  **never moved past the slop is not an edit** and must not commit, or it would re-match for nothing and
  (from E6) push an undo step that undoes nothing. A press that *created* a point always commits.
  ⚠ **E4 takes over exactly that do-nothing press** and turns it into a selection.
- **`commitEdit` now uses `requestRender`, not `render`.** A drag emits `pointermove` faster than the
  display refreshes (a 125 Hz mouse against a 60 Hz screen); rendering per *event* draws frames nobody
  sees. In node there is no `requestAnimationFrame` and it falls through to a synchronous render, so the
  unit tier still observes results immediately.
- **Checked.** Unit: every move is a live *uncommitted* edit and the release commits exactly once; a drag
  never changes the point count and never moves the neighbours; a press + slop-sized jitter commits
  **nothing**; a drag starting on a point never pans; dragging the start *past* the other points keeps it
  the start (order is positional — silently re-sorting a trace would re-route the whole sketch); a
  cancelled drag keeps its point and commits. And the coalescer against a slow stub kernel: **24 moves →
  2 matches**, the last one for the final position.
- **Measured in the browser: 20 move events → 6 matches**, and the drawn route is **byte-identical to a
  re-match of the settled sketch** — which is the real anti-staleness check, stronger than "the route
  changed". On a phone the ratio only improves: slower matches coalesce more.

### E4 — delete one point
- **Build.** Double-click a point (mouse, behind the P2 dedupe); tap-select + a **Delete** button in
  `index.html` (touch); `Delete`/`Backspace` and `Esc` on desktop.
- **Check.** Browser: double-click a mid point ⇒ gone, route re-matches; delete to 1 point ⇒ HUD says
  "add ≥2", no throw, no route (failure path 8).

### E5 — multi-select a range + bulk delete
- **Build.** Port `_toggleSelect` / `_selectedIds` / `deleteSelected`: tap first + last of a stretch selects
  the contiguous range; the button deletes the lot; survivors at the ends re-role.
- **Check.** Select a 3-point range, delete ⇒ those 3 gone, ends re-roled, **one** undo step.

### E6 — undo / redo
- **Build.** Port `undo.js`: per-session snapshot stack, recorded **only** on `commitEdit(true)`;
  `Ctrl+Z`/`Ctrl+Shift+Z`/`Ctrl+Y`; an `applying` guard so replay does not record itself; the
  **"Deleted N · Undo" snackbar** on a bulk delete (`DESIGN.md` §1 makes undo a primitive, not an extra).
- **Check.** move → insert → delete, then `Ctrl+Z` ×3 returns to the start state and the route re-matches
  each time; a bulk delete shows the snackbar and one tap restores.

### E7 — box select + gates
- **Build.** Shift+drag box select (desktop only, least load-bearing). Add `matchInsert` / `matchDelete` to
  `__perfHooks` so §2's P5 becomes a standing measurement. Re-record the PLAN-PERF pixel hashes.
- **Check.** `make test`, `test-native`, `test-wasm`, `test-map` green; `tools/match_parity.sh`
  byte-identical throughout; PLAN-PERF's warm/cold rows re-measured on a **quiet** box.

---

## 7. Test plan — two tiers, and every probe becomes a gate

`CLAUDE.md`: **a probe outside a gate is a comment.** All five §2 probes graduate into the gates below;
none stays a script.

**Tier 1 — `browser/map.test.mjs` (DOM-free, stub canvas, milliseconds).** Everything that is pure logic,
including the branches a browser is bad at reaching:
- point-to-segment distance and hit **priority** (point beats segment beats empty) at several zooms;
- `nearestSegment` in screen space, incl. the degrees-space trap;
- sketch mutations: insert at index, delete, delete-to-1, delete-to-0, role recomputation;
- the **coalescer**: N requests during one in-flight match ⇒ exactly **1** pending, latest wins, generation
  number rejects a superseded match's stretches (failure path 10);
- the **double-tap dedupe** (250 ms / 12 px) as a pure predicate;
- undo stack: only committed edits recorded, replay does not re-record.

**Tier 2 — `browser/cdp_verify_store.mjs` (real Chromium, real `Input.dispatchMouseEvent`).** The gate that
already exists (*"✓ the click path works: 3 clicks → 3 rough points, route 28 pts"*) grows one assertion
per gesture, plus the four regressions as permanent guards:
- **P1** a pan drag adds 0 points · **P2** a double-click adds 1 · **P4** rapid clicks leave a fresh route
  (< 50 m from the last point) · **P3** the overlay hook sees a snapped origin;
- insert-on-segment · drag-a-point · double-click-delete · range bulk-delete · `Ctrl+Z`;
- the drag assertion counts kernel calls, so a regression to per-frame matching **fails** rather than
  merely being slow.

**Tier 3 — unchanged invariants.** `tools/match_parity.sh` must stay byte-identical (this work is pure
presentation; it must not move a route), and `tools/basemap_isolation_gate.sh` must stay PASS.

---

## 8. Out of scope

GPX import/export, elevation, the sync server, draft-save of undo history, goal length, and any change to
the matcher. Each is its own track. **If this work moves a matched route, it has a bug.**

## 9. Definition of done

`DESIGN.md` §1's primitive set works on the standalone app: **place · drag · insert (tap + sweep) · remove
(dblclick / select+Delete) · multi-select bulk-delete · undo/redo** — every one flowing through the three
chokepoints, the matched line read-only, the rough line drawn from the snapped origin, routes byte-identical
to before, and each of the five §2 probes running inside a gate.
