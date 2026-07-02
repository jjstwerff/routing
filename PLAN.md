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

**ARCHITECTURE PIVOT — server-first (2026-07-01; see DESIGN.md §3/§4/§11).** After scoping the loft
toolchain we moved loft **out of the browser and onto a native server** (the audience-demo pattern):
- **loft runs native, on a server** (`server` + `web` + pure-loft `lib/routing_kernel`); the browser is
  **thin JS + Leaflet on a WebSocket**. This dissolves the browser-wasm blockers — server-side loft has
  full HTTP (Overpass via `web.http_get`), files, and persistence; nothing heavy ships to the phone.
- **Why:** `loft --html` has no shipped JS→loft data-in (verified — `file()`/`arguments()` are in-wasm
  stubs; `web` bridges only WebSocket, not HTTP), and the wasip2 alternative is ~4× heavier. Rather than
  wait on an upstream loft primitive, WebSocket-to-a-server is shipped, proven, and small.
- **Consequence:** this **re-sequences the plan** — the server + WS transport (old Phase 4, steps
  18–20) becomes the **Phase 1 spine**. **Offline standalone (Mode A — loft in the browser) is
  deferred**; it's the only thing that needs the upstream `--html` primitive
  ([docs/loft-feedback.md](docs/loft-feedback.md)). `lib/routing_kernel` is already built + parity-tested
  and is consumed by the server now.

**Legend:** ☐ not started · ◐ in progress · ☑ done — update the box as you go.

---

## Phase 1 — Thin end-to-end skeleton (draw → match → length)

The goal of Phase 1 is one honest vertical slice: draw a line, get a real map-matched route with an
accurate length. Ship nothing fancy; prove the pipeline.

### ☑ 1. Static shell + map
- **Goal:** the app loads as pure static files and shows a pannable map.
- **Build:** `index.html` + a little JS/CSS, no build step (§11). Leaflet (~40 KB gz) + OSM raster
  base `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` (§7). No framework.
- **Check:** open `index.html` locally; the map loads, pans, and zooms on **both** a desktop browser
  and a phone browser. No console errors.

### ☑ 2. Rough layer — the tiny primitive set (§1)
- **Goal:** draw and edit the rough shape.
- **Build (JS owns pixels, §2):** tap/click to drop points joined by **straight lines**; **drag** a
  point to move; **tap a segment** to insert a point; **tap-select + delete** to remove one
  (double-click on mouse). First/last points are a **distinct start/finish type**. Rough line is
  **always open** (no close-loop action).
- **Check:** place ~8 points, drag one, insert one mid-segment, delete one. The polyline updates
  correctly each time; start and finish are visually distinct from intermediates.

### ☑ 3. Instant rough length (§1, §2)
- **Goal:** live length as you draw — never wait.
- **Build:** haversine sum over `rough[]` in JS, recomputed every frame on place/drag.
- **Check:** draw a straight ~1 km segment between two known points; the readout is within ~1% of the
  known distance and updates live while dragging (no perceptible lag).

### ☑ 4. loft server + WebSocket round-trip (the transport spine)
- **Goal:** stand up the native loft server and prove the end-to-end **JS↔server** channel — the
  browser sends rough points over a WebSocket, the server computes the length with `routing_kernel` and
  replies, no UI freeze. This is the transport everything downstream rides on (was the old Phase-4 work,
  promoted by the server-first pivot).
- **Build (audience-demo `single_port_server.loft` shape):**
  1. `server/server.loft` using `server` + `web` + `routing_kernel`; run `loft --native --lib lib`.
     Deps via `loft install` or path-dep to `../loft-libs-net/{server,web}`.
  2. **One port** serves the static client (HTTP `/`) **and** the WebSocket (`/ws`); the client derives
     the URL from `location.host`.
  3. On a `points:<json>` frame → parse → `routing_kernel::path_length_m` → reply `length:<m>` (the
     matcher slots in at step 6; for now the length is the round-trip payload).
  4. Browser: a small `ws.js` — `new WebSocket(...)`, send points on edit (debounced), apply the reply.
- **Check:** the browser posts the step-3 points over WS; the server returns the length within a few
  metres of the JS haversine; a second client can connect; closing/reopening a tab reconnects.
  *(Headless: drive the WS client in headless Chromium and assert the returned length.)*
- **DONE (2026-07-01):** `server/server.loft` (`server` + `web` + `routing_kernel`, single-port
  HTTP+WS) builds and runs native; the browser `ws.js` sends `1:<points>` and shows the server's
  `2:<length>` in the `#server-length` readout. `tools/server_test.sh` proves it end-to-end (HTTP
  serves index.html; Node WS round-trip returns `1000.7557221018342` = the kernel value; clean
  shutdown). `lib/routing_kernel` parity-tested (`tools/kernel_headless_test.sh`) feeds it.
  - **Ecosystem workaround:** the shipped `server`/`web` 0.2.x **don't compile under loft 2026.6.0**
    (`try_recv`/`next` return `text` with `return null` → must be `text?`). Vendored both into
    `lib/{server,web}` with that one-line fix, resolved via `--lib lib`. Proper fix is upstream
    (loft-libs-net) — see [docs/loft-feedback.md](docs/loft-feedback.md) Part 2 #6.
  - **Op note:** `loft --native` detaches the compiled server binary; kill it by **port**
    (`fuser -k 18080/tcp`), not the wrapper — the harness does this.
- **Deferred (not this step):** running the kernel **in the browser** (`--html`) for the offline mode —
  blocked on an upstream loft data-in primitive ([docs/loft-feedback.md](docs/loft-feedback.md)); the
  wasip2 alternative is ~4× heavier (rejected). `--native-wasm` is kept only as the CI parity harness.
  *(Minor: a benign "arguments() vector<text> not freed" warning at exit — stdlib-side, exit 0.)*

### ☑ 5. Corridor download — the server fetches Overpass (§5)  ⟵ *needs Q1*
- **Goal:** loft fetches a tight corridor of real ways around the rough line.
- **Build:** the **server** builds a bbox+margin around the rough polyline and queries **Overpass** via
  `web.http_post` — a **native** loft call (HTTP is bridged natively; only `--html` lacked it, and
  loft isn't in the browser now). (Q1 offline caching still open; may proxy/cache on the server.)
- **Check:** for a hand-drawn line over a known street, loft returns a bounded set of ways.
- **DONE (2026-07-01):** pure-loft corridor helpers in `routing_kernel` — `bounds()` (bbox+metre
  margin), `overpass_query()` (QL, `out geom`), `parse_ways()` (JSON → `Way{highway,surface,tracktype,
  coords}`, missing tags → ""). Deterministic test `lib/routing_kernel/tests/corridor.loft` +
  fixture passes **interpret == native**. Server `reply_corridor` (WS msg 2) live-proven: a Jordaan
  bbox returned **47 ways** via native `web.http_post`.
  - *Note:* the Overpass fetch blocks the event loop for its duration (fine single-user; thread later)
    and public Overpass rate-limits (needs a User-Agent; flaky) — so the **live** fetch is proven but
    NOT a committed CI gate; the committed gate is the deterministic parse test.
  - *Deferred:* true narrow **corridor** buffer (vs the bbox) + activity tag-filtering fold into the
    matcher (step 6); browser doesn't auto-fetch (it'll consume the matched route at step 7).

### ☑ 6. v1 map-matcher (§5)  ⟵ *Q2 answered: v1 corridor-routing-with-deviation*
- **Goal:** clean the rough line onto real paths — faithful, deterministic, local.
- **Build:** graph from corridor ways (nodes deduped by coordinate; edges = way segments); least-cost
  path where **cost = length · (1 + DEV_K · deviation-from-trace)** — deviation-dominant, so it hugs
  the drawn line; corridor caps deviation. Activity penalty stubbed (step 8). Same input → same match.
- **Check:** a line ~15 m off a path matches onto it; twice → identical; nudge → local change.
- **DONE (2026-07-01):** in `routing_kernel` — `build_graph`, `match_route` (Dijkstra, deviation-
  weighted edge cost, equirectangular point-to-segment geometry). Tests `tests/matcher.loft` pass
  **interpret == native**: node-dedup merges shared coords (5 nodes/4 edges from 2 crossing ways); a
  15 m-off trace snaps onto the street (all output points on it); deterministic. Real Overpass sample
  built to **105 nodes / 112 edges** — *exactly* the Python instrument's prediction.
  - **Rigor note:** the load-bearing assumption (dedup-by-coord → connected graph) was probed on real
    data FIRST (1 connected component, 100%) before any matcher code.
  - **loft perf bug hit + filed:** the natural `adj: vector<vector<int>>` mutated via a `&` ref was
    **O(n²)** (100 nodes hung > 20 s) — a loft-interpreter pathology (nested-vector element mutation
    through a `&` ref when the struct has a `hash` field). Restructured to a **flat edge list** scanned
    in Dijkstra (O(V·E), instant). Filed **loft-lang/loft#475** with a minimal repro.
  - **Not yet tested:** locality (nudge → local-only) — follows from the deviation-cost being a local
    function of trace proximity, but no explicit test yet. Adaptive-widening gap fallback deferred.
- **§10.2 MATCHER-DEPTH UPGRADE (2026-07-01):** v1's src→dst Dijkstra **shortcut loops/out-and-backs**
  (it ignored the middle of the trace — a start==finish trace returned nothing). Upgraded `match_route`
  to route **PIECEWISE through consecutive trace points** (extracted `dijkstra_path`; each segment is
  its own deviation-to-that-segment + activity path, concatenated with join-dedup). This **covers the
  whole trace** — loops and out-and-backs included — while a **2-point trace stays a single piece**, so
  activity still decides between parallel start→finish ways (step 8 preserved). `tests/loop.loft` (a
  square loop is traced + closes) added; all kernel tests green **interpret == native**; live match
  unchanged for straight traces. **Remaining (full HMM):** an intermediate point drawn *exactly*
  between two parallel ways snaps to one (candidate-set Viterbi would let activity decide there too);
  plus the tight-corridor download (vs bbox) and an adaptive-widening gap fallback.

### ☑ 7. Detailed layer + accurate length (§1, §2)
- **Goal:** show the matched route with its own accurate length.
- **Build:** JS draws the detailed polyline **under** the rough layer as separate, **read-only**
  geometry; show its geodesic length (from loft) alongside the rough length.
- **Check:** after drawing, a distinct detailed line appears beneath the rough points with a length
  close to the rough length; the detailed line cannot be dragged.
- **DONE (2026-07-01):** server `reply_match` (WS msg 4 → `5:<length>|<lat,lon;…>`): fetch corridor →
  `build_graph` → `match_route` → geodesic length. Browser: `ws.js` sends a match request debounced on
  edit-release (700 ms — Overpass is heavy), draws the matched polyline in a dedicated low-z `detailed`
  pane (orange, `interactive:false` = read-only, under the rough dashed line + markers), shows
  "matched <len>". Live-proven: a Jordaan trace returned an **11-point matched route, 633 m**.
  - *Note:* the full match hits Overpass (flaky/rate-limited) so the round-trip is proven live but not
    a CI gate; the matcher itself is gated deterministically (step 6). Matched length is haversine —
    the WGS84-ellipsoidal upgrade is deferred. Browser render is manual-visual (async-WS timing makes
    a headless gate flaky).

> **Phase 1 exit:** draw a sketch → see a real, deterministic, activity-agnostic matched route with an
> accurate length, entirely from committed static files + wasm. This is the demo the rest builds on.

---

## Phase 2 — Make the match good and complete the core loop

### ☑ 8. Activity × sub-mode profiles (§6)
- **Goal:** a good *first* match from the activity choice — the "lock in fast" win (a primary product
  investment, §6).
- **Build:** per-`(activity, sub-mode)` tag weightings owned by loft, feeding the activity-penalty term
  in step 6. Wire the UI selector; switch the Waymarkedtrails overlay per the §6 table.
- **Check:** footpath beside a road → **Running·Trail** picks the path, **Cycling·Road** picks the
  road, just by the sub-mode change.
- **DONE (2026-07-01):** `routing_kernel.way_penalty(profile, hw, surface, tracktype)` — all 9 §6
  profiles as a **bounded** per-metre penalty `[-0.7, +2]` (prefers < 0 < penalizes), fed into
  `edge_cost` so it's a *tie-breaker*, decisive among equal-deviation candidates but unable to leave
  the corridor. `match_route` takes the profile; server parses `"4:<profile>|<points>"`. Client
  `controls.js`: activity + sub-mode selectors → profile (re-matches on change) + WMT overlay
  (hiking/cycling/mtb/none, MTB→mtb). Tests `tests/profiles.loft` pass **interpret == native**: the
  footpath-vs-road choice flips purely by profile (Trail→footpath, Road→road); penalty signs + clamp.
  Live match with a profile round-trips. *(Weights are §6 starting points — tune against real data.)*

### ☑ 9. Round-trip inference (§1, §5)
- **Goal:** loops close themselves, no button.
- **Build:** when start & finish sit near each other **relative to total length** (tunable ratio),
  close the **detailed** circuit; leave the **rough** open. Purely geometric.
- **Check:** draw a near-loop → detailed route closes; drag the finish away → it un-loops; bring it
  back → it closes again. An out-and-back whose finish lands on the start reads as a closed circuit.
- **DONE (2026-07-01):** `is_round_trip(start, finish, total_m, ratio)` (pure geometry) +
  `match_route_closed(g, trace, profile, ratio)` (closes the polyline back to the matched start when
  it reads as a round trip, unless it already returns there). Server uses ratio **0.25**. The client
  draws a closed polyline (first == last) as a loop — no client change.
- **UNBLOCKED by the matcher-depth upgrade (see step 6):** now that the matcher routes PIECEWISE
  through the trace, a drawn loop is actually traced and closes. `tests/roundtrip.loft` (the ratio
  decides; open below threshold, closed above) **and** `tests/loop.loft` (a square loop is traced —
  all 4 corners — and closes) pass **interpret == native**.

### ☑ 10. GPX export (§8)
- **Goal:** get an accurate route out.
- **Build:** loft emits a `<trk>` of the detailed route; JS triggers the download.
- **Check:** export a route; the `.gpx` opens in another tool showing the same track.
- **DONE (2026-07-01):** `routing_kernel.gpx_export(points, name)` → GPX 1.1 `<trk>` (tested
  interpret == native). Server `reply_export` (WS msg 6 → `7:<gpx>`) matches then emits GPX; client
  `gpx.js` "Export GPX" button → `ws.requestExport` → `Blob` download. Live-proven: a 767-byte GPX,
  11 `<trkpt>`.

### ☑ 11. GPX import + cleaning pipeline (§8)
- **Goal:** turn a dirty external track into a clean, editable **rough** route.
- **Build:** Douglas–Peucker reduce + auto-collapse near-coincident points; re-match.
- **Check:** over-sampled jittery GPX → sparse rough route; out-and-back survives; sub-metre spike
  dropped.
- **DONE (2026-07-01):** `routing_kernel.douglas_peucker` + `clean_track` (collapse < min_sep, then
  DP; tested interpret == native): a 21-point jittery line → a few; an out-and-back keeps its
  turnaround; a near-coincident point is dropped. JS parses the GPX (`DOMParser` — browsers do XML),
  server `reply_import` (WS msg 8 → `9:<cleaned>`) cleans, client sets the rough layer via new
  `RoughLayer.setPoints` (→ re-match). Live-proven: 21 raw → 2 cleaned.
  - *Deferred (§8 step 3):* flagging **substantial** retraces (vs collapsing degenerate ones) — needs
    UI; the auto-safe cleaning (DP + near-coincident collapse) is in.

> **Phase 2 exit:** the core product works — draw or import, get a good activity-aware match, export
> GPX. *(Steps 8, 10, 11 ☑; step 9's round-trip inference ☑ but its visual loop awaits the §10.2
> matcher-depth upgrade.)*

---

## Phase 3 — Feedback, persistence, edit safety
> *Server-first note: this phase's persistence (steps 16/17) targets the server route store, not a
> browser-local Mode-A library — Mode A (loft in the browser) is deferred (§3). The interaction steps
> (12–15) are pure client and apply either way.*

### ☑ 12. Multi-select + bulk delete (§1)
- **Goal:** the key lever for reworking an existing route.
- **Build:** select a **contiguous range** by tapping first + last point; delete the lot. Surviving end
  points become the new start/finish.
- **Check:** select a mid-route stretch and delete it; the ends rejoin and re-match; the route stays
  valid.
- **DONE (2026-07-02):** `RoughLayer` selection is now a contiguous **range** between two anchors
  (tap first + last; a single tap = one point). `deleteSelected` removes the whole range; survivors'
  roles recompute; the delete button reads "Delete N points". Headless-Chromium test (13/13): range
  [2..5] of 8 → 4 left (the ends), one start/one finish after, single-select + re-tap-deselect still
  work. Delete emits → re-match. *(Box/lasso deferred — tap-first-last works on desktop via click A +
  click B; a drag-box is a later nicety.)*

### ☑ 13. Undo — platform-adaptive, one per-session history (§1)
- **Goal:** take back your own recent edits, frictionlessly, per device.
- **Build:** one **per-session** edit-history. Desktop: **`Ctrl+Z` / `Ctrl+Shift+Z`** multi-level.
  Phone: **"Deleted N · Undo" snackbar** after bulk delete. Local & ephemeral.
- **Check:** desktop — several edits then `Ctrl+Z`×N walk back, `Ctrl+Shift+Z` redoes. Phone — bulk
  delete shows the snackbar; one tap restores exactly the deleted range.
- **DONE (2026-07-02):** `undo.js` — snapshot history seeded with the empty state. `rough._emit` now
  carries a `committed` flag (drag frames = live/uncommitted, discrete edits + drag-release =
  committed); app.js records only committed edits, so a drag is one undo step, not per-frame. Desktop
  `Ctrl/Cmd+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`; phone snackbar auto-shown when a record drops ≥2 points
  (a bulk delete). Applying an undo doesn't re-record (guard flag). Headless-Chromium test (14/14):
  undo walks back to empty + no-op past start, redo walks forward; bulk delete → "Deleted 4 · Undo"
  → tap restores 8. Restored state re-matches (via onChange).

### ☑ 14. Goal length — feedback only (§1)
- **Goal:** measure against a target without ever auto-reshaping.
- **Build:** optional `goalMeters`; readout shows live **±delta**. The app **never** moves points to
  hit it — you remain the only actuator.
- **Check:** set a 10 km goal; the ±delta tracks live as you edit; nothing about the route changes
  when the goal is set or changed.
- **DONE (2026-07-02):** a `goal … km` input; `renderLength` appends `(±delta)` to the instant
  readout when `routing.goalMeters > 0`, recomputed every frame (feedback-only — the goal input
  handler re-renders but never touches the points). Headless-Chromium test (5/5): goal 10 km →
  "1.00 km (−9.00 km)", goal 0.5 km → "(+501 m)", clearing removes it, and setting a goal leaves the
  points byte-identical. *(Delta is on the instant rough length — the live tier; the matched length
  shows separately.)*

### ☑ 15. Elevation chart — lag-tolerant tier (§1, §7)
- **Goal:** ascent/descent + profile without blocking anything.
- **Build:** loft pulls public terrain tiles (e.g. AWS terrarium PNG), decodes via its imaging lib,
  samples the detailed route → profile + total ↑/↓. Dismissable bottom dock, **closed by default**.
  Computed async; allowed to trail the drawing by seconds.
- **Check:** on a known hilly route the ascent/descent are plausibly correct; while it computes, the
  instant length and interaction stay responsive (never blocked).
- **DONE (2026-07-02):** WS `10:<detailed pts>` → `11:<up>|<down>|<d,e;…>`. The server pulls AWS
  terrarium tiles (z ≤ 13, a 12-tile bbox cap steps the zoom down) through a new binary-safe
  `web::http_get_file` into a disk cache (`scratch/tiles/`, which doubles as the offline test
  fixture), decodes them with the vendored `imaging` lib; the PURE kernel does the tile math +
  ≥25 m-step sampling + dead-band (3 m) ↑/↓ totals (`tests/elevation.loft`, 6 fns,
  interpret == native). Client: `elevation.js` bottom dock, closed by default, re-requests on
  open/re-match (lag-tolerant; never touches the instant length path). Offline e2e:
  `tools/elevation_test.sh` (synthetic step tile → up=100/down=0, 84 samples) +
  `tools/client_elev_test.sh` (headless-Chromium CDP: closed by default, opens, draws, ↑100/↓0).
  Live ad-hoc: Grenoble→Chamrousse straight line → first 218 m, last 1604 m, ↑1855/↓469
  (up−down == last−first exactly). Found + reported a loft `--native` codegen bug on the way
  (constructed-text arg zeroes a `float?` return — see docs/loft-feedback.md; kernel tiles are
  integer-keyed as the clean workaround).

### ☑ 16. Server route store — named saves + close-the-browser-safe working route (§4, §9)
- **Re-scoped by the server-first pivot** (was: "Mode A — local named library" via localStorage.
  With loft server-side, a no-server library can't re-match anyway; the local variant folds into
  the deferred offline Mode A). This step pulls the named store + write-through persistence
  forward from steps 19/20 — the README already numbered it this way.
- **Goal:** save, reopen, and re-edit routes; the browser is disposable.
- **Build:** named route store on the server where the **disk is the store** (one file per route:
  display name / profile / points; list = dir scan) — every save is write-through **by
  construction** and a server restart loses nothing. WS `12:` save / `14:` list / `16:` open /
  `18:` delete → replies `13:` (updated list) / `17:` (route). The **working sketch** autosaves
  under the reserved name `_working` on every match request (before the corridor fetch, so a
  failed match still persists) and is restored **silently** onto an empty page at first connect.
- **Check:** save a route, reload, reopen it — points, activity, and sub-mode return and it
  re-matches; a second route lists independently; close the tab mid-sketch, reopen → the sketch
  is back.
- **DONE (2026-07-02):** server: `route_slug` (filename-safe, display name kept inside the file),
  `save_route`/`routes_list`/open/delete handlers + the `_working` autosave in `reply_match`.
  Client: `routes.js` panel (closed by default; save row + open/✕ list), `controls.setProfile`
  (restores activity × sub-mode without a double re-match), silent `_working` restore on first
  connect (guarded: never clobbers a started sketch). Offline gates: `tools/routes_test.sh`
  (node WS: save ×2 incl. UTF-8 name, list, exact open round-trip, unknown → empty, delete,
  autosave-before-match; preserves the developer's `_working`) and `tools/client_routes_test.sh`
  (headless-Chromium CDP: panel closed by default, save→listed, **page reload restores the
  sketch + autosaved profile**, open applies the saved route's distinct profile, delete). What
  remains for Phase 4: multi-client broadcast/replay (19) and per-edit streaming beyond the
  debounced match-commit granularity (20).

### ☑ 17. Auto-proposed names (§9)
- **Goal:** never force naming; offer a good default.
- **Build:** on first save, loft composes **area + length + type** (e.g. *"Vondelpark · 8 km · Trail
  run"*) — length/type it has; area via light reverse-geocode (Nominatim) or a named feature from the
  corridor data. Lag-tolerant; accept or override.
- **Check:** save an unnamed route → a sensible name is proposed within a moment; editing the name
  sticks.
- **DONE (2026-07-02):** WS `20:<profile>|<points>` → `21:<proposed>`. Server composes
  `area · length · type`: length from `path_length_m` (`nice_length`: "850 m" / "7.5 km" /
  "12 km"), type from the profile (`profile_label`: "Trail run", "Gravel ride", …), area from a
  Nominatim reverse-geocode of the route midpoint (zoom 16; prefers the feature name unless it's
  just a road, then falls back neighbourhood → suburb → village → town → city; proper User-Agent).
  A failed lookup degrades to "length · type" — which keeps the committed gates offline. Client:
  opening the panel prefills the name input (only while empty or still holding the previous
  proposal — typed text always wins; dedup per sketch). Gates: `tools/routes_test.sh` (reply ends
  "2.1 km · Trail run" for the 2053.76 m test sketch; degenerate → empty) +
  `tools/client_routes_test.sh` (prefill lands, override sticks through save). Live (unsandboxed
  CDP run): **"Benschop · 2.1 km · Trail run"** — the correct village for the test coordinates.
  Two more loft bugs found + written up (parser ICE on precision-0 float format; native E0308 on a
  text tail-call with a heap-param callee — see docs/loft-feedback.md).

> **Phase 3 exit:** a complete standalone app (Mode A) — the strict subset a stranger just opens.

---

## Phase 4 — Server mode (Mode B)

> **Promoted by the server-first pivot (2026-07-01).** In the pivot, loft *only* runs on a server, so
> these steps are no longer a final add-on — they start at **step 4** (basic serve + WS round-trip).
> What remains distinctly "Phase 4" is the richer server behaviour below: multi-client sync,
> write-through persistence, and close-the-browser-safe backup. Steps 18–20 layer onto the step-4 base.

### ☐ 18. loft server serves the client (§4, §11)
- **Goal:** the same client, loaded from a live loft server, detects Mode B at runtime.
- **Build:** `loft --lib ../loft/lib <server>.loft` (audience-demo shape) on `lib/server` +
  `lib/world` + `lib/engine_host`; serve the static client over HTTP. Client picks mode by whether it
  was loaded from a loft server.
- **Check:** load the app from the server URL → it reports Mode B; load the static files directly →
  Mode A. Same client build both times.

### ☐ 19. Shared route store + WebSocket sync (§4)
- **Goal:** multiple people load and change the same named routes, live.
- **Build:** on the step-16 named store, add the live layer: broadcast accepted edits to open
  clients; replay current state to new ones (audience-demo collaborative pattern). Single-port
  HTTP+WS and `location.host`-derived WS URL are already in.
- **Check:** two browsers open the same route; an edit in one appears in the other; a third client
  opening later sees the current state.

### ☐ 20. Write-through persistence — close-the-browser-safe (§4, the headline)
- **Goal:** the browser is disposable; nothing is ever lost.
- **Status:** the core landed in step 16 — named saves and the `_working` sketch are write-through
  persisted (disk-is-the-store), and reopening on ANY device restores the working route. What
  remains here: persist **every accepted edit** (today the granularity is the debounced
  match-commit, ~0.7 s after edit-release — a tab killed inside that window loses the last
  gesture), plus the multi-client consistency story with 19.
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
