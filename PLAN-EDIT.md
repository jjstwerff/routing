<!-- Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-EDIT — restore the rough-layer editing primitives

> **Status (2026-07-12):** the app is now the **standalone store app** ([PLAN-BUILD](PLAN-BUILD.md), the plan
> of record) — `browser/index.html` is the store-app front end, not the retired tiles app this doc predates.
> These editing primitives are still to build (PLAN-BUILD B6); they ride the same `map.mjs` seam, on the store
> app's rough sketch (the `match` re-issue is already wired — click adds a point and re-matches).

**Goal.** Bring the single-file loft-native browser app (`browser/index.html`) back to the **original
interaction design** (DESIGN.md §1): the rough sketch is edited with a **small, sharp primitive set** —
*place · drag · insert · remove · multi-delete · undo* — and re-matches on every edit. The loft-native
rewrite (`da2a178` "retire jco") collapsed the old multi-file app into one file and, in doing so, dropped
every editing gesture except *place*. This plan restores the rest, faithfully, adapted to the current
architecture (in-browser wasm match; single self-contained file).

This is a **restoration, not a redesign.** Multi-select and undo are the *original* design's own primitives,
not additions. Nothing here touches the matched line — see the invariant.

> **Sequencing (2026-07-08):** deferred until after **[PLAN-MAP](PLAN-MAP.md)** lands. We are dropping
> Leaflet for our own canvas renderer; editing must be built **once**, on that renderer's seam
> (`project/unproject/camera/hitTest`), not on Leaflet. So E0's "point model + commit chokepoint" sits on
> PLAN-MAP, and the gesture math below (drag/insert/`nearestSegment`) uses the seam's `project`/`hitTest`
> instead of Leaflet's `latLngToLayerPoint`/`L.LineUtil`. The design is otherwise unchanged.

---

## 0. Provenance — the original design and code (read these, don't reinvent)

- **Design of record:** `DESIGN.md` §1 ("Core idea — sketch a shape, match it to real paths") and §2
  ("Division of labour — JS does pixels, loft does routes"). The binding: *"Precision comes from a small,
  sharp, predictable primitive set, not from piling on features."*
- **Original implementation** (git `6ac2f45`, the last commit before the loft-native rewrite):
  - `rough.js` — `RoughLayer`: draggable point markers with start/finish/mid **roles**; `dblclick`→remove;
    tap-select of a **contiguous range**; a fat transparent **hit-line** under the sketch that catches
    insert taps; the **press-drag sweep** (`_onLineDown`) that inserts a point on the nearest segment and
    positions it in *one* gesture; `_nearestSegment` (screen-space); `_emit(committed)` → one `onChange`.
  - `undo.js` — a per-session snapshot stack; `record` on committed edits only; `Ctrl+Z`/`Ctrl+Shift+Z`;
    a **"Deleted N · Undo" snackbar** on bulk delete (`dropped >= 2`); an `applying` guard so replaying a
    snapshot doesn't spawn a new history entry.
  - `app.js` — wiring: `new RoughLayer(map, { onChange: (points, committed) => { …update length; if
    (committed) undo.record(points); …send to matcher } })`; `doubleClickZoom:false`, `boxZoom:false`.
- **What the current app has / lacks** (`browser/index.html`):
  - Has: *place* — `map.on('click', … sketch.push(…); match())` (`:163`); `Clear`/`Demo`/profile
    (`:370–372`); `runMatch(sketch, profile)` in wasm (`:118`); the detailed route drawn read-only (`:357`).
  - Lacks: the sketch points are **non-interactive** `circleMarker`s (`:91`, drawn `:356`) over a flat
    `sketch = [[lat,lon]]` array (`:134`). No drag, insert, remove, multi-select, or undo.

---

## 1. The one principle — only the rough layer is editable

**The rough sketch is the single source of truth and the ONLY editable geometry.** The matched (detailed)
line is a **pure function of the sketch** and is **never edited directly** (DESIGN.md §1: *"Correcting a
wrong match = move the points, not the line. The detailed route is read-only."*). To fix a wrong match you
nudge/add/remove a **rough** point and re-match; *zoom is precision* (a fingertip covers fewer metres when
zoomed in), and the steering falls straight out of the matcher's deviation cost — **no extra mechanism.**

This is the user's "we do not edit all the points": the dense matched polyline is untouchable; you only ever
move a handful of rough points.

---

## 2. The invariant (Design Protocol 1) and its single chokepoint

**Invariant.** *Every* editing gesture mutates the one ordered rough-point list and then flows through a
**single commit path** that: rebuilds the sketch markers + line → runs the **same** pure
`runMatch(points, profile)` → redraws the read-only route → (if the edit is *committed*) records one undo
snapshot. A gesture never tested (insert-then-drag, delete-to-one-point, undo-after-bulk-delete) is correct
because it takes the *same* path as the tested ones.

**Re-assertion-site count — the prospective tell.** The bug this prevents: each new gesture handler
separately remembering to "also re-match, also redraw, also record undo." That is **N silent sites** (forget
one → a stale route or a lost undo step, no error). The original solved it with **one** `_emit(committed)` →
`onChange`; N collapses to **1**. So the **first** step (E0) builds that chokepoint and routes the *existing*
gestures through it — before adding any new gesture. Every later step is then "mutate the list + call
`commitEdit(committed)`", nothing else.

**Over-unification guard.** Do **not** fold the matched line into the editable-point model to "unify
geometry." It is a genuinely different family (read-only, derived). Keeping it separate is the design, not an
omission (DESIGN.md §1).

**Precondition already met.** Editing needs matching to be *local, stable, deterministic* (DESIGN.md §1
binding 2, §5) so nudging one point changes the route predictably. The existing deviation-dominated matcher
already provides this; we rebuild-per-edit (sub-second) and do **not** need incremental match (PLAN-BROWSER
Phase 4.2) for the restore.

---

## 3. Failure paths (enumerated before coding — where the invariant earns its keep)

1. **Stale route / lost undo** — a gesture mutates points but skips re-match or undo. → the single
   `commitEdit` chokepoint (E0) makes this structurally impossible.
2. **Editing the matched line** — a click on the blue route must do nothing. → route polyline stays
   `interactive:false`; only rough markers + the hit-line are interactive.
3. **`dblclick`-to-delete vs. Leaflet** — double-click zooms, and the map-click double-tap dedupe could
   swallow it. → `doubleClickZoom:false`; delete handler on the *marker*, not the map.
4. **Insert picks the wrong segment** — nearest segment must be judged in **screen pixels** (what the user
   saw), not lat/lon. → port `_nearestSegment` using `latLngToLayerPoint` + `L.LineUtil.closestPointOnSegment`.
5. **Sweep leaks a stray point** — the press-drag on the line must not also fire a map-click append. →
   `L.DomEvent.stop` + a `_suppressClick` guard (as in `_onLineDown`).
6. **Drag re-matches every frame** — acceptable as a *live preview* (`committed:false`, no undo record); the
   **commit** (undo step) happens once on `dragend`. Keep the wasm match sub-second (it is).
7. **Delete below 2 points** — match must degrade to the current "sketch N pt — add ≥2" state, not throw.
8. **Touch has no `dblclick`/right-click** — provide tap-select + a **Delete** button (mouse users get
   `dblclick` too). Bulk delete is button/`Delete`-key driven.
9. **Undo replay spawns history** — applying a snapshot via `setPoints` must be wrapped by the `applying`
   guard so it doesn't record itself.
10. **Standalone vs served** — every gesture must work from `file://` (no server) and when served; the demo
    route still seeds the sketch. Gates run both (E6).

---

## 4. Steps (ordered, falsifier-first — each has a Build and a Check)

> Each step is small and independently verifiable. E0 is the cheapest falsifier: it proves the chokepoint
> **before** any new gesture exists, by keeping today's behaviour byte-identical while restructuring.

### E0 — Point model + single commit chokepoint  *(the invariant probe)*
- **Build.** Replace `sketch = [[lat,lon]]` + non-interactive `circleMarker`s with an ordered list of point
  objects `{ id, marker }` (roles start/finish/mid, like `rough.js`), and one function
  `commitEdit(committed)` that: reads the marker LatLngs → sets the sketch line + a fat transparent
  **hit-line** → `runMatch(points, profile)` → redraw the read-only route → `if (committed) undoRecord()`.
  Route the *existing* gestures — map-click *append*, `Clear`, `Demo`, profile-change — through it. No new
  gesture yet.
- **Check.** The demo route and a follow-up click produce a match **byte-identical** to today's (reuse the
  standalone gate's native-equality assertion), and a grep shows **exactly one** edit→`runMatch` call site.

### E1 — Drag a point → move it
- **Build.** Markers `draggable:true`; `drag` → `commitEdit(false)` (live re-match preview); `dragend` →
  `commitEdit(true)` (one undo step). Line follows live.
- **Check.** Headless (CDP): drag a mid point ~40 px; the route re-matches, the summary changes, and exactly
  **one** committed edit is recorded.

### E2 — Remove one point
- **Build.** `marker.on('dblclick', …)` → remove + `commitEdit(true)` (mouse). Disable `doubleClickZoom`.
  Add a tap-select highlight + a **"Delete point"** button (hidden until a point is selected) for touch.
- **Check.** Double-click a mid point → it's gone, route re-matches; delete down to 1 point → status shows
  "add ≥2", no throw.

### E3 — Insert a point on a segment (tap + press-drag sweep)
- **Build.** Port `_onLineDown`: the interactive **hit-line** catches `pointerdown`; insert at
  `_nearestSegment` (screen-space) with `_insertNoEmit`, then `pointermove` positions it live
  (`commitEdit(false)`), `pointerup` commits once (`commitEdit(true)`). A plain tap (no drag) inserts at the
  press. Guard the trailing map click (`L.DomEvent.stop` + `_suppressClick`).
- **Check.** Press on a segment and drag → **one** point inserted between the correct neighbours and
  positioned where released; a plain tap on the line inserts exactly one; each is a single undo step.

### E4 — Multi-select + bulk delete  *(the edit-existing-route lever, DESIGN.md §1)*
- **Build.** Tap-select a **contiguous range** (tap first + last point); the Delete button / `Delete` key
  removes the range; end survivors become the new start/finish (`deleteSelected` + roles recompute).
  Desktop `Shift`-drag **box-select** (port `_boxBegin/_boxMove/_boxEnd`) optional within this step;
  `boxZoom:false`.
- **Check.** Select a 3-point range, delete → those 3 gone, route re-matches, ends re-roled, **one** undo
  step (a bulk delete).

### E5 — Undo / redo
- **Build.** Port `undo.js`: snapshot stack, `record` on `commitEdit(true)`, `Ctrl+Z`/`Ctrl+Shift+Z`
  (+`Ctrl+Y`); apply via `setPoints` under the `applying` guard; **"Deleted N · Undo" snackbar** on
  `dropped >= 2`. Seed with the initial state.
- **Check.** move → insert → delete, then `Ctrl+Z` ×3 returns to the start state (route re-matches each
  time); a bulk delete shows the snackbar and one tap restores.

### E6 — Gates + standalone rebuild + isolation
- **Build.** Extend `browser/cdp_verify*.mjs` / the app gates (`tools/browser_app_test.sh`,
  `tools/standalone_app_test.sh`) with new `window.__edit` hooks exercising drag/insert/remove/undo; rebuild
  `standalone.html`; re-run the S0 isolation gate.
- **Check.** Gates green in **both** served and standalone (`file://`, network off); the route stays
  byte-identical to native for the demo; `tools/basemap_isolation_gate.sh` still PASS (editing is pure
  presentation — routing untouched).

---

## 5. Port vs. adapt (single-file loft-native ≠ the old multi-file app)

| Original (`6ac2f45`) | Now (`browser/index.html`) |
|---|---|
| `onChange → routing.ws.sendPoints` (server match over WS) | `commitEdit → runMatch(points, profile)` in wasm |
| Multi-file `app.js`/`rough.js`/`undo.js` | one `<script type="module">` (inline the classes) |
| `.rough-pt` / `#rough-delete` / `.snackbar` CSS | port the CSS into the `<style>` block |
| rough length via `geo.formatDistance` | keep the existing status summary (matched len + ms + source) |
| live-sync, GPX, elevation (other tracks) | **out of scope** — restore editing only |

**Explicitly out of scope** (do not build here — avoid re-inflating the surface): the optional sync server
(PLAN-BROWSER Phase 6), GPX import/export (Phase 5.2), elevation (Phase 5.1), incremental match (Phase 4.2),
draft-save of undo history (DESIGN.md §10). Each is its own track.

---

## 6. Definition of done

The app matches DESIGN.md §1's primitive set on both the served and standalone builds: place · drag · insert
(tap + sweep) · remove (dblclick / select+Delete) · multi-select bulk-delete · undo/redo — all flowing
through the single `commitEdit` chokepoint, with the matched line read-only, routing provably isolated, and
the demo route still byte-identical to native.
