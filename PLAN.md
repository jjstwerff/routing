# Route Planner — Implementation Plan

Concrete, small, independently-checkable steps toward the design in **[DESIGN.md](DESIGN.md)**.
This is the *how* and *in what order*; DESIGN.md stays the *what* and *why*. Section references
like (§5) point back into DESIGN.md.

**How to use this file.** Work top-to-bottom. Each step has a **Goal**, a **Build** list, and a
**Check** — an observable pass/fail you can run before moving on. A step is "done" only when its
Check passes. Steps 1–7 deliberately form a **thin end-to-end skeleton** (draw → match → length);
everything after layers on without rearchitecting. Keep the surface tiny (DESIGN.md §, binding 1):
resist adding a primitive a step doesn't need.

**Two open questions block steps 5–6** — resolve before starting Phase 2:
- **Q1 — Offline matching (§10.1):** cached corridor data on the phone, or online-only Overpass
  acceptable for v1? Affects the corridor store in step 5.
- **Q2 — Matcher depth (§10.2):** full HMM (Newson & Krumm) or v1 corridor-routing-with-deviation?
  This plan assumes the **v1 corridor-routing** answer for step 6; revisit if we choose HMM.

**Legend:** ☐ not started · ◐ in progress · ☑ done — update the box as you go.

---

## Phase 1 — Thin end-to-end skeleton (draw → match → length)

The goal of Phase 1 is one honest vertical slice: draw a line, get a real map-matched route with an
accurate length. Ship nothing fancy; prove the pipeline.

### ☐ 1. Static shell + map
- **Goal:** the app loads as pure static files and shows a pannable map.
- **Build:** `index.html` + a little JS/CSS, no build step (§11). Leaflet (~40 KB gz) + OSM raster
  base `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` (§7). No framework.
- **Check:** open `index.html` locally; the map loads, pans, and zooms on **both** a desktop browser
  and a phone browser. No console errors.

### ☐ 2. Rough layer — the tiny primitive set (§1)
- **Goal:** draw and edit the rough shape.
- **Build (JS owns pixels, §2):** tap/click to drop points joined by **straight lines**; **drag** a
  point to move; **tap a segment** to insert a point; **tap-select + delete** to remove one
  (double-click on mouse). First/last points are a **distinct start/finish type**. Rough line is
  **always open** (no close-loop action).
- **Check:** place ~8 points, drag one, insert one mid-segment, delete one. The polyline updates
  correctly each time; start and finish are visually distinct from intermediates.

### ☐ 3. Instant rough length (§1, §2)
- **Goal:** live length as you draw — never wait.
- **Build:** haversine sum over `rough[]` in JS, recomputed every frame on place/drag.
- **Check:** draw a straight ~1 km segment between two known points; the readout is within ~1% of the
  known distance and updates live while dragging (no perceptible lag).

### ☐ 4. loft WASM kernel + Web Worker channel
- **Goal:** the sanctioned loft-in-browser plumbing works, proven with the simplest kernel function.
- **Build:** AOT-build loft to wasm (`loft --html`/cdylib, `wasm32-unknown-unknown`), `wasm-opt`
  shrink, **commit the artifact** (§3, §11). Run it as a **service in a Web Worker** over the
  push/poll byte channel (`../loft/doc/claude/BROWSER_INTEROP.md`). First exported op: **geodesic
  length** (WGS84, f64) over a posted point list.
- **Check:** JS posts the step-3 points to the worker; the returned geodesic length is within a few
  metres of the JS haversine value, and the map never freezes during the call.

### ☐ 5. Corridor download (loft owns data) (§5)  ⟵ *needs Q1*
- **Goal:** loft fetches a tight corridor of real ways around the rough line.
- **Build:** loft builds a **narrow buffer (~tens of m)** around the rough polyline, queries
  **Overpass**, filters to activity-relevant `highway` ways and pulls `surface`/`tracktype` tags. The
  network syscall is a thin JS host-import; loft decides what to fetch. (Q1 decides whether the result
  is cached for offline.)
- **Check:** for a hand-drawn line over a known street, loft returns a bounded set of ways that
  includes the expected roads/paths and excludes ways well outside the buffer.

### ☐ 6. v1 map-matcher (§5)  ⟵ *needs Q2*
- **Goal:** clean the rough line onto real paths — faithful, deterministic, local.
- **Build:** graph from corridor ways (nodes = OSM nodes, edges = way segments); least-cost path where
  **cost = deviation-from-line (dominant) + bounded activity penalty**. Densify the trace; corridor
  physically caps deviation. **Adaptive widening** fallback on a gap. **Same input → same match.**
- **Check:** a line drawn ~15 m off a known path matches **onto** that path; running the match twice
  on identical input yields an identical polyline; nudging one point changes only the **local**
  stretch, not the whole route.

### ☐ 7. Detailed layer + accurate length (§1, §2)
- **Goal:** show the matched route with its own accurate length.
- **Build:** JS draws the detailed polyline **under** the rough layer as separate, **read-only**
  geometry; show its geodesic length (from loft) alongside the rough length.
- **Check:** after drawing, a distinct detailed line appears beneath the rough points with a length
  close to the rough length; the detailed line cannot be dragged.

> **Phase 1 exit:** draw a sketch → see a real, deterministic, activity-agnostic matched route with an
> accurate length, entirely from committed static files + wasm. This is the demo the rest builds on.

---

## Phase 2 — Make the match good and complete the core loop

### ☐ 8. Activity × sub-mode profiles (§6)
- **Goal:** a good *first* match from the activity choice — the "lock in fast" win (a primary product
  investment, §6).
- **Build:** per-`(activity, sub-mode)` tag weightings owned by loft (BRouter-style), feeding the
  activity-penalty term in step 6. Wire the UI selector (running Fast/Trail, cycling Road/Gravel/MTB,
  walking Paved/Trail, driving Fastest/Avoid-motorways). Switch the Waymarkedtrails overlay per the §6
  table.
- **Check:** on a spot with a footpath beside a road, **Running·Trail** picks the path and
  **Cycling·Road** picks the road, with no point edits — just the sub-mode change.

### ☐ 9. Round-trip inference (§1, §5)
- **Goal:** loops close themselves, no button.
- **Build:** when start & finish sit near each other **relative to total length** (tunable ratio),
  close the **detailed** circuit through the corridor; leave the **rough** open. Purely geometric.
- **Check:** draw a near-loop → detailed route closes; drag the finish away → it un-loops; bring it
  back → it closes again. An out-and-back whose finish lands on the start reads as a closed circuit.

### ☐ 10. GPX export (§8)
- **Goal:** get an accurate route out.
- **Build:** loft emits a `<trk>` of the detailed route (optional `simplify`-thin); JS triggers the
  download. Show the geodesic length alongside.
- **Check:** export a route; the `.gpx` opens in another tool (or a viewer) showing the same track and
  a length matching the in-app readout.

### ☐ 11. GPX import + cleaning pipeline (§8)
- **Goal:** turn a dirty external track into a clean, editable **rough** route (the edit-existing
  workflow).
- **Build:** (1) Douglas–Peucker reduce to rough points; (2) auto-collapse **degenerate** artifacts
  (near-coincident points, sub-metre doubles-back) — data cleaning only; (3) **preserve but flag**
  substantial retraces (offer one-tap clean / multi-select-delete); (4) re-match.
- **Check:** import an over-sampled, jittery GPX → a sparse editable rough route; a real out-and-back
  survives (flagged, not mangled); a sub-metre spike is silently dropped.

> **Phase 2 exit:** the core product works standalone — draw or import, get a good activity-aware
> match, close loops, export GPX.

---

## Phase 3 — Feedback, persistence, edit safety (Mode A)

### ☐ 12. Multi-select + bulk delete (§1)
- **Goal:** the key lever for reworking an existing route.
- **Build:** select a **contiguous range** by tapping first + last point (touch), or **box/lasso** on
  desktop; delete the lot. Surviving end points become the new start/finish.
- **Check:** select a mid-route stretch and delete it; the ends rejoin and re-match; the route stays
  valid.

### ☐ 13. Undo — platform-adaptive, one per-session history (§1)
- **Goal:** take back your own recent edits, frictionlessly, per device.
- **Build:** one **per-session** edit-history (move/insert/delete/bulk-delete). Desktop:
  **`Ctrl+Z` / `Ctrl+Shift+Z`** multi-level. Phone: **"Deleted N · Undo" snackbar** after bulk delete
  (single moves/inserts are self-correcting → no chrome). Local & ephemeral.
- **Check:** desktop — several edits then `Ctrl+Z`×N walk back, `Ctrl+Shift+Z` redoes. Phone — bulk
  delete shows the snackbar; one tap restores exactly the deleted range.

### ☐ 14. Goal length — feedback only (§1)
- **Goal:** measure against a target without ever auto-reshaping.
- **Build:** optional `goalMeters`; readout shows live **±delta**. The app **never** moves points to
  hit it — you remain the only actuator.
- **Check:** set a 10 km goal; the ±delta tracks live as you edit; nothing about the route changes
  when the goal is set or changed.

### ☐ 15. Elevation chart — lag-tolerant tier (§1, §7)
- **Goal:** ascent/descent + profile without blocking anything.
- **Build:** loft pulls public terrain tiles (e.g. AWS terrarium PNG), decodes via its imaging lib,
  samples the detailed route → profile + total ↑/↓. Dismissable bottom dock, **closed by default**.
  Computed async; allowed to trail the drawing by seconds.
- **Check:** on a known hilly route the ascent/descent are plausibly correct; while it computes, the
  instant length and interaction stay responsive (never blocked).

### ☐ 16. Mode A — local named library (§4, §9)
- **Goal:** save, reopen, and re-edit routes with no server.
- **Build:** persist the **rough route** (authoritative) to `localStorage`/IndexedDB as a named entry;
  detailed match + elevation are derived/cached. List / open / delete.
- **Check:** save a route, reload the page, reopen it — the rough points, activity, and sub-mode
  return and it re-matches; a second saved route is independently listed.

### ☐ 17. Auto-proposed names (§9)
- **Goal:** never force naming; offer a good default.
- **Build:** on first save, loft composes **area + length + type** (e.g. *"Vondelpark · 8 km · Trail
  run"*) — length/type it has; area via light reverse-geocode (Nominatim) or a named feature from the
  corridor data. Lag-tolerant; accept or override.
- **Check:** save an unnamed route → a sensible name is proposed within a moment; editing the name
  sticks.

> **Phase 3 exit:** a complete standalone app (Mode A) — the strict subset a stranger just opens.

---

## Phase 4 — Server mode (Mode B)

### ☐ 18. loft server serves the client (§4, §11)
- **Goal:** the same client, loaded from a live loft server, detects Mode B at runtime.
- **Build:** `loft --lib ../loft/lib <server>.loft` (audience-demo shape) on `lib/server` +
  `lib/world` + `lib/engine_host`; serve the static client over HTTP. Client picks mode by whether it
  was loaded from a loft server.
- **Check:** load the app from the server URL → it reports Mode B; load the static files directly →
  Mode A. Same client build both times.

### ☐ 19. Shared route store + WebSocket sync (§4)
- **Goal:** multiple people load and change the same named routes, live.
- **Build:** shared named route store in a loft `world`; **single-port HTTP+WS**, client derives WS
  URL from `location.host`. Broadcast accepted edits to open clients; replay current state to new
  ones (audience-demo collaborative pattern).
- **Check:** two browsers open the same route; an edit in one appears in the other; a third client
  opening later sees the current state.

### ☐ 20. Write-through persistence — close-the-browser-safe (§4, the headline)
- **Goal:** the browser is disposable; nothing is ever lost.
- **Build:** each accepted edit streams out-of-band and is **write-through persisted to disk** on the
  server (direct backup, mirroring `world.bin`). Detailed match stays derived/cached.
- **Check:** edit a route, **close the tab / kill the connection**, reopen on another device → the
  working route is exactly where you left it, with no "unsaved changes" prompt.

> **Phase 4 exit:** Mode B adds naming + multi-user sync + close-the-browser-safe backup on top of the
> Mode A subset — no rearchitecting.

---

## Deferred (post-v1) — from DESIGN.md §10
- **"Not-done" / draft save:** a save type bundling work-in-progress state **including the undo
  history**, so an unfinished route resumes with undo intact. In Mode B the working state is already
  continuously persisted (step 20); there the remaining piece is persisting the **undo history**
  itself.

---

## Cross-cutting checks (apply to every step)
- **The hinder test (§):** does this step slow the novice (complexity) or limit the expert
  (hand-holding)? If so, it's a design bug — fix the step, not the symptom.
- **Instant vs lag-tolerant (§1):** distance stays instant (every frame); anything heavier
  (elevation, names, reverse-geocode) is allowed to trail and must never block interaction.
- **Determinism (§5):** any step touching the match must keep it stable, local, and reproducible.
