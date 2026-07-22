# Route Planner — Basic Design

Working title: **routing** (lives at `/home/jurjen/workspace/routing`, a sibling consumer of
the loft language at `../loft`).

A **phone-first** map tool for **quickly sketching a route** (running / cycling / walking / driving),
seeing the length **instantly**, then having the rough sketch **matched onto real paths** suited to
the activity, and finally **exporting GPX** with an accurate length.

**Intent (and the non-goal):** the matched route stays **faithful to what you drew** — it cleans your
imprecise sketch onto the nearest sensible real ways. It does **not** re-route for scenery (no "skip
the boring road" 5 km detours, unlike komoot-style planners). The job is to *get up to speed and lock
a route in fast*, not to discover a prettier one.

**Design north-star — low friction, high precision: nobody is hindered.** Every interaction is
frictionless and every result is exact, so neither the novice nor the expert is ever held back.
*Easy to pick up:* open it, tap a few points, read
the length, get a good matched route with **zero setup**; imprecise taps are forgiving by design and
the activity defaults carry a beginner. *A precision knife for an expert:* the **same tiny primitive
set** — place/drag/insert/remove points, **zoom-as-precision**, sub-mode, **live length** — gives a
practised user *exact* control, *fast*. Precision comes from a **small, sharp, predictable** primitive
set, **not** from piling on features.

**The test for every decision: does this hinder anyone?** It must not slow the novice with complexity
*nor* limit the expert with hand-holding. The design keeps answering it the same way — instant length
(never wait), lag-tolerant elevation (heavy work never blocks), inferred round trips (no mode),
proposed names (no forced naming), optional chart/overlay (quiet defaults), forgiving taps (no
precision demanded up front), multi-select delete (experts aren't slowed reworking a route). Anything
that would hinder *either* end is a design bug.

Two bindings this puts on the rest of the design:
1. **Keep the surface tiny.** Defaults carry the novice; every "advanced" capability is just a
   primitive used with intent, never a separate cluttering mode.
2. **Matching must be stable, local, and deterministic.** Nudging one point changes the route
   *locally and predictably* — otherwise an expert can't be precise (see §5).

---

## 1. Core idea — sketch a shape, match it to real paths

Two independent geometry layers:

1. **Rough layer (you draw it).** Tap the map to drop points; consecutive points join with
   **straight lines**. A live length updates as you tap and drag. This is just a *shape sketch*.

2. **Detailed layer (loft derives it).** The rough points are **shape hints, not anchors** — a
   fingertip on a phone lands 10–30 m off the real way, so points are never snapped individually.
   loft takes the **whole rough polyline as a trace** and finds the real-path route that **best
   follows that shape** for the chosen activity (map-matching). It's drawn *under* the rough layer
   as separate geometry, with its own accurate length.

Editing the rough layer just reshapes the trace and re-matches:
- **Drag** a point → moves it. **Tap a segment** → inserts a point. (Single add/move are deliberately
  quick — that's the common case and needs no ceremony.)
- **Remove one** → tap-select + delete (touch) / double-click (mouse).
- **Remove many — the key tool for reworking an *existing* route** → **multi-select, then bulk delete.**
  Select a **contiguous range** by tapping the first and last point of the stretch (touch-first), or
  **box/lasso** on desktop, then delete the lot. Deleting a range is the biggest lever when editing a
  route someone else already made; whatever points survive at the ends just become the new start/finish.
  This is the one editing primitive added specifically for the edit-existing-routes workflow.
- **Undo — platform-adaptive, one history with two surfaces.** A single **per-session edit-history**
  (move / insert / delete / bulk-delete) backs both surfaces, each exposed via whatever is frictionless
  on the device — the "nobody hindered" rule applied to undo itself:
  - **Desktop (full browser):** real **`Ctrl+Z` / `Ctrl+Shift+Z`** multi-level undo / redo.
  - **Phone:** no keyboard, and swipe-undo would fight map pan/zoom, so the risky op — **bulk delete** —
    gets a brief **"Deleted N · Undo" snackbar** (one tap restores). Single moves/inserts are
    **self-correcting** there (just move or delete again), so they need no chrome.
  Because the history is **per-session (ephemeral)** and *local*, undo only ever takes back **your own**
  recent actions — sidestepping collaborative-undo footguns in multi-user mode. A future *draft /
  "not-done" save* could bundle the undo data so an unfinished route resumes with its history (§10).

Because the rough points are only hints, the detailed route stays independent of them — exactly why
the two layers are kept separate.

**Correcting a wrong match = move the points, not the line.** The detailed route is **read-only** —
you never drag the matched path itself. If the match goes the wrong way, you nudge / add / remove a
rough point near that spot to indicate what you meant, and re-match. **Zoom in for precision:** at a
higher zoom a fingertip covers fewer metres, so a point placed close to the intended way pulls the
(tight-corridor, deviation-dominated) match firmly onto it. Sketch fast when zoomed out; zoom in only
where the match needs steering. This steering falls straight out of the cost model — a precisely
placed point is a strong local deviation pull — so no extra mechanism is needed.

**Start & finish, and round trips — inferred, not a mode.** The first and last points are a **distinct
point type** (start / finish) from the intermediate points. The rough line is **always treated as
open** — there is no "close the loop" action. But when **start and finish sit near each other
*relative to the total length*** (a small ratio, tunable), the app **infers a round trip** and closes
the **detailed** route into a continuous circuit — the **rough sketch stays open**. It's purely
geometric, so it needs no button and no override: drag the finish away and the ratio grows and it
un-loops; bring it back near the start and it closes again (the same "steering falls out of the model"
idea). This also subsumes **out-and-backs**: draw out and back so the finish lands on the start, and it
is simply a closed round trip whose detailed path faithfully retraces your line.

**Length & goal — feedback, never auto-control.** The live length is the central instrument. You may
optionally set a **goal length** (e.g. a 10 km run); when set, the readout shows the live **±delta**
to it. But the app **never reshapes the route to hit a goal** — auto-fitting a target would violate
the precision/faithfulness principle (an optimizer deciding the route, not you). Instead **you choose
where to deviate** from the plan, and every change or choice — move a point, insert one, switch
sub-mode — **reports its effect**. Feedback comes in **two tiers**: **distance is instant** (every
frame), while **ascent/descent and the elevation chart are lag-tolerant** and may trail the drawing by
several seconds while loft fetches terrain and recomputes (§7). The goal is just the reference the
feedback is measured against; you remain the only actuator. (Instant distance is the other reason the
match must be local/stable, §5.)

---

## 2. Division of labour — JS does pixels, loft does routes

| | **JS (vanilla + Leaflet)** | **loft (native server, reached over WebSocket)** |
|---|---|---|
| Owns | interactive rough points (place/drag/insert/remove), Leaflet map (OSM base + Waymarkedtrails overlay + **overlay/chart toggles**), **instant rough length** (haversine), **drawing** the detailed polyline + **elevation chart**, UI | **import/export of routes (GPX)**, **downloading road-pattern data**, **map-matching / routing**, **accurate geodesic length**, **elevation sampling (ascent/descent + profile)**, simplification, **proposed names** (reverse-geocode area + length + type) |

JS = points + pixels. loft = routes + data + math — running **native on a server** (§3/§4), reached
over a WebSocket. (Running loft *in the browser* is deferred to an offline mode, §3/§4.)

---

## 3. The loft engine — a native server (browser kernel deferred)

loft runs **native, on a server** — not in the browser. The browser stays thin (**vanilla JS +
Leaflet**) and talks to the server over a **WebSocket** (§4). This is the audience-demo shape, and it
dissolves the browser-wasm constraints: server-side, loft has full **HTTP** (Overpass via
`web.http_get`), files, and persistence, with no bundle-size budget and no host-import gymnastics.
(This replaced an earlier browser-wasm-kernel plan; see the "browser kernel — deferred" note below for
why.)

- **The server is three loft libraries + our code.** `server` (registry — single-port HTTP+WS
  multi-client event loop, built on `web`) + `web` (native **HTTP client** for Overpass/Nominatim +
  native **WebSocket**) + **`routing_kernel`** (our pure-loft compute). `../loft/lib/engine_host`
  optionally adds hot-reload. There is no stock `lib/server`/`lib/world` — the route store is our own
  struct (§4).
- **`routing_kernel` — the pure-loft compute (shipped, tested).** A platform-agnostic library
  (`lib/routing_kernel`, all f64 — loft `float` is double): geodesic length (WGS84 ellipsoidal — the
  spherical haversine is in place, the ellipsoidal upgrade is step 7), per-segment lengths,
  Douglas–Peucker simplify, nearest-segment projection, and the **map-matcher** (§5). Proven identical
  across `--interpret` / `--native` / `--native-wasm` (`tools/kernel_headless_test.sh`), so it runs the
  same on the server today and in a browser kernel later, with no code change.
- **JS owns pixels + the WebSocket; loft owns routes + data + math.** JS sends the rough points over
  WS; loft fetches the corridor, matches, computes the accurate length + elevation, and returns the
  **detailed polyline + length**; JS renders it on Leaflet. The **instant rough length stays JS-side**
  (haversine, every frame) so drawing never waits on the round-trip (§1).
- **Phone-first / PWA.** The shipped client is still pure static files + Leaflet (~40 KB gz) — a tiny
  PWA that installs on a phone and wraps cleanly in a native WebView (Capacitor/Cordova). The *weight*
  (loft) lives on the server, so the phone downloads almost nothing.

**Browser kernel — deferred (offline Mode A only).** Running loft *in the browser* (`loft --html`,
`wasm32-unknown-unknown`, ~330 KB gz — measured; AOT, no parser/compiler shipped) is only needed for a
**pure-static, offline, no-server** build. It is **blocked** today: `--html` has loft→JS output
(`loft_io.loft_host_print`) but **no generic data-in** (verified — `file()`/`arguments()` are in-wasm
stubs; `web` bridges only WebSocket, not HTTP), so JS can't feed it points without an **upstream loft
change** (a generic `loft_io` input primitive — written up in [docs/loft-feedback.md](docs/loft-feedback.md)).
Deferred until that lands; the server path needs none of it, and the same `routing_kernel` will compile
to the browser unchanged. *(`--native-wasm`/wasip2 is ~4× heavier — 5.4 MB / 1.5 MB gz — and can't run
in a browser without jco; kept only as the headless CI parity harness.)*

---

## 4. Deployment — server-first (offline standalone deferred)

**v1 is server-backed.** A loft server serves the static client over HTTP and does all the routing
work; the browser is thin JS + Leaflet on a WebSocket. Chosen over a browser-wasm kernel because it is
the shipped, proven audience-demo pattern and it sidesteps every `--html` limitation (§3) — HTTP
(Overpass), files, persistence, and heavy compute all just work, natively.

- **The server.** `loft --native` on `server` + `web` + `routing_kernel` (the audience-demo
  `single_port_server.loft` shape): **one port** serves the client (HTTP) *and* the sync channel (WS at
  `/ws`; the client derives the URL from `location.host`). It holds a **shared, named route store** that
  multiple people load and change — an **app-defined struct** persisted **write-through to disk** on
  every accepted edit (the "direct backup", the audience-demo `world.bin` shape). The **rough route** is
  the persisted source of truth; the detailed match is derived/cached. loft fetches Overpass itself
  (`web.http_get`, native).
- **The data transfer is WebSocket, both ways.** JS sends `points:<json>`; the server matches and
  replies `matched:<polyline + length>`; edits **broadcast** to other open clients and **replay** to
  newly-connected ones (the audience-demo collaborative pattern). Simple `id:payload` text frames. The
  browser side is a plain `new WebSocket(...)` — no loft, no bridge.

**Close-the-browser-safe — the headline value.** Edits stream to the server **out-of-band** and are
write-through persisted, so the **browser is disposable**: close a tab, drop the connection, switch
phone→laptop, and **nothing is lost** — reopen and the working route is exactly where you left it, on
any device. No "unsaved changes" prompt, ever. This also gives the *"not-done" draft* (§10) for free —
the in-progress route is always a live, server-persisted draft, named or not.

**Mode A — offline standalone (deferred).** A pure-static, no-server build where loft runs *in the
browser* (§3), routes saved to `localStorage`/IndexedDB, travelling as GPX — what a stranger opens with
no server at all. **Deferred:** it needs the `--html` data-in primitive (§3,
[docs/loft-feedback.md](docs/loft-feedback.md)). When that lands, the same `routing_kernel` compiles to
the browser unchanged and Mode A becomes a strict subset of the server build (drop naming + multi-user
sync + backup).

---

## 5. Matching — clean the line onto real paths (faithful, not scenic)

**The route is a LINE THAT GROWS, not a result that appears.** The matcher decomposes a sketch into one
sub-path per stretch (a pair of consecutive drawn points) and each is independent, so the route is
emitted stretch by stretch **as it is matched** rather than after the whole search finishes. This is a
design property, not an optimisation:

> ✅ **STATUS 2026-07-22 — delivered.** Both halves ship. The kernel emits each stretch in travel order as
> it is matched with a `frame_yield()` between — which turned a 40-point route's worst frozen gap from
> 11095 ms into 384 ms — and the browser now *renders* them: `runKernel` takes an opt-in line sink drained
> per yield in a microtask (before paint), and `map` accumulates stretches by slot and re-strokes the
> route so far. For an interval this was the INTENT only, because the emit shipped without a consumer;
> `PLAN-PERF` §6b(2) records that gap and the gate that now prevents it recurring.
>
> One honest caveat: `remove_spurs` prunes ~60% of the raw stitch, so the growing line carries out-and-back
> excursions that vanish when the match completes — it tightens at the end rather than simply stopping.


- **It retraces the user's own gesture** — the line grows in the order they drew it.
- **It is a progress indicator with no indicator** — no spinner, no percentage, no invented estimate,
  because the thing being shown IS the work being done. A slow stretch is one the user watches take its
  time: information, not a stall.
- **It mimics the journey** — stretches arrive in TRAVEL order, so the line unfolds the way the user will
  actually walk or ride it. For an app that plans a trip you are about to take, that is the closest a
  plan gets to rehearsing it.

**Therefore arrival order is load-bearing.** Emitting stretches out of order gives the same pixels and
none of the meaning — a jigsaw filling in rather than a journey. Any future parallelism must preserve the
reveal order (loft's `par` does: it computes concurrently but iterates results in order).

**And parallelism must preserve DETERMINISM, which `par` does not give for free.** Same input → same
match is a §5 requirement, and the sharpest threat is not a race but ORDER: a `par` loop over a hash walks
its buckets unsorted, so parallelising the corridor read would change the way order, hence `build_graph`'s
node indices, hence Dijkstra's tie-breaks — a route that wobbles run to run from identical input, silently
and plausibly. The acceptance for any parallel work is therefore an N-run identity check, not a single
comparison.

The fix is upstream of the parallelism: **order the source, then let `par` sequence the results.** `par`
iterates in the order of its source, so a range is already safe and a hash must be materialised sorted
first; results that arrive early are held until their turn, and each is revealed the moment its index
comes up rather than when all workers finish. Parallel work behind a sequencer: the compute order is the
scheduler's, the reveal order is the journey, and the route matches a sequential run. See `PLAN-PERF.md`
§6b B.

**Faithfulness to the sketch dominates.** The match snaps your imprecise line onto the nearest
sensible real ways; activity-suitability is only a *local tie-breaker*. It must never take a detour
to find a nicer surface — the route roughly follows the points you already drew.

loft downloads a **tight corridor (narrow buffer, ~tens of metres) around the rough line** from
**Overpass** (OSM), filtered to activity-relevant ways and pulling `highway` + **`surface`/`tracktype`**
tags. The narrow corridor both bounds the download (small, phone-friendly) **and physically caps
deviation** — the match cannot leave it.

It builds a graph from the corridor ways (nodes = OSM nodes, edges = way segments) and finds the
connected path that best follows the trace:

- **cost = deviation-from-your-line (dominant) + an activity-suitability penalty that is *decisive
  within the envelope but bounded against detours*.** Strong enough to confidently pick the
  activity-right way among the candidates already next to your line (the footpath vs the road beside
  it), yet capped so it can never justify leaving the corridor or adding meaningful distance. Matched
  length stays close to the rough length.
- **A well-tuned profile is the main lever for first-match quality.** The better the activity
  defaults, the more often the *initial* match is already right and the less the user has to nudge —
  which is exactly the "lock in fast" win, and a big differentiator. So the profiles are a primary
  investment, not an afterthought (see §6).
- **Adaptive widening fallback:** if no connected path exists within the tight corridor (a gap where
  you drew), widen locally just enough to reconnect, still minimising deviation — so matching
  degrades gracefully instead of failing.
- **Stable & local & deterministic (the precision-knife requirement).** Moving one point produces a
  small, *local* change — re-match only the affected stretch, don't re-derive the whole route, and
  never let a tiny edit make the path jump globally. Same input → same match. This determinism is what
  lets an expert nudge precisely and trust the result.
- **Round-trip closure.** When start and finish are near each other *relative to total length*, close
  the detailed circuit (join matched-start to matched-finish through the corridor); otherwise leave it
  open point-to-point. The rough points are never closed — only the detailed route (§1).

Algorithm family: HMM map-matching (Newson & Krumm) is the principled target; a v1 can densify the
trace and do corridor-constrained least-cost routing with a strong deviation term. Re-match is
**debounced on edit-release** (avoid hammering Overpass mid-drag); an explicit "match" action is also
available.

---

## 6. Activity × sub-mode preference profiles

Each `(activity, sub-mode)` is a small weighting over OSM tags (BRouter-style profile, owned by
loft). Prefers/penalizes are starting points, to tune against real data. **Tuning these well is a
primary product investment** — a strong default match is what minimises manual correction and
delivers the fast lock-in, so a good initial match "for free" from the activity choice is a major
bonus, not a nicety.

| Activity | Sub-mode | Prefers | Penalizes | WMT overlay |
|---|---|---|---|---|
| Running | **Fast** | footway/cycleway/path with `surface=asphalt\|paved\|concrete`; residential/living_street/pedestrian | sand/ground/dirt/grass; primary/secondary/trunk; steps | hiking |
| Running | **Trail** | path/track/bridleway, `surface=sand\|ground\|dirt\|gravel\|grass`; `tracktype` grade2–4 | asphalt/paved; primary/secondary/trunk | hiking |
| Cycling | **Road** | cycleway; paved residential/tertiary/secondary; `surface=asphalt\|paved`; `bicycle=designated` | unpaved/sand/ground; steps; foot-only | cycling |
| Cycling | **Gravel** | track/path/cycleway, `surface=gravel\|fine_gravel\|compacted\|unpaved`; `tracktype` grade1–3 | sand/mud (too soft); motorway/trunk | cycling |
| Cycling | **MTB** | path/track/bridleway/singletrack; `mtb:scale` present; `surface=ground\|dirt\|rock\|gravel` | paved main roads; busy roads | **mtb** |
| Walking | **Paved** | footway/sidewalk/pedestrian/path, `surface=paved\|asphalt\|concrete\|paving_stones` | sand/mud; trunk/primary | hiking |
| Walking | **Trail** | path/track/footway/bridleway, `surface=ground\|dirt\|sand\|gravel\|grass`; `sac_scale=hiking` | motorway/trunk/primary; big paved roads | hiking |
| Driving | **Fastest** | motorway/trunk/primary/secondary; `motor_vehicle=yes` | unpaved; service/track; foot/cycle-only | (none) |
| Driving | **Avoid-motorways** | secondary/tertiary/residential/unclassified | motorway/trunk; unpaved | (none) |

---

## 7. Map layers & optional views
- **Base:** OSM raster — `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`.
- **Activity overlay (Waymarkedtrails, transparent raster):**
  `hiking` / `cycling` / `mtb` per the table above (driving: none).
- **Overlay toggle.** The Waymarkedtrails "known paths" lines can be **hidden**, leaving just the
  route on the plain base map — a cleaner read on **scale** and the route's own shape.
- **Optional elevation chart (bottom dock).** A dismissable chart along the bottom showing the
  **elevation profile** of the detailed route, with **total ascent ↑ and descent ↓ beside it**. It is
  **lag-tolerant**: computed async and allowed to trail the drawing by several seconds, so it never
  blocks the instant length or the interaction. loft pulls **public terrain tiles** (e.g. AWS
  terrarium PNG), decodes them via its imaging lib, and samples the matched route → profile + totals.
  Closed by default (low floor); open it for detail (high ceiling).

---

## 8. GPX (loft owns import + export)
- **Export:** loft emits a `<trk>` of the detailed route (optionally `simplify`-thinned), JS triggers
  the download. Accurate **geodesic length** shown alongside.
- **Import (easy to parse, but one careful step).** Parsing GPX is trivial, but a track is *detailed
  and often dirty* — bad editors emit thousands of jittery points and **back-and-forth on the same
  road**. And because our matcher is **faithful**, dirty rough input → dirty detailed output, so the
  cleaning **must** happen at import. Import is therefore *not* "display the track" — it's **derive a
  clean, sparse rough route from it** (the editable form our model wants, and the very "edit an existing
  route" workflow that justified multi-select delete):
  1. **Reduce to rough points** with the kernel's Douglas–Peucker simplify — launders over-sampling and
     GPS jitter in one pass.
  2. **Auto-collapse only *degenerate* artifacts** — duplicate/near-coincident points and tight
     immediate doubles-back on the same segment (a near-zero-area out-and-return). That's **data
     cleaning, not route-changing** — nobody intends a sub-metre spike.
  3. **Preserve, but *flag*, substantial retraces** — a deliberate out-and-back is legitimate (the
     round-trip rule already handles it), so never silently mangle it: highlight suspicious
     back-and-forth and offer a one-tap clean, or let the user multi-select-delete it.
  4. **Re-match** the cleaned rough route → a faithful detailed route on real ways.

  The discriminator that keeps us honest: **degenerate spikes are noise (auto-safe to drop); long
  retraces are shape (keep, or let the user decide)** — we clean data, we never auto-"improve" a route
  the user meant.

---

## 9. Data model (sketch)
```
Route {
  name?:    route name (named & shared in server mode; named in the local browser library too)
  activity: running | walking | cycling | driving
  subMode:  e.g. running→{fast,trail}, cycling→{road,gravel,mtb}, ...
  rough:    [ {lat,lon}, ... ]                 // shape hints; first = start, last = finish (distinct types)
  detailed: { coords: [ {lat,lon}, ... ], lengthMeters, ascentM, descentM, roundTrip }
            // map-matched; roundTrip inferred from start≈finish relative to total length
  roughLengthMeters                            // haversine over rough[]
  goalMeters?                                  // optional target; drives ±delta readout (feedback only)
}
```
Persistence: the **rough route is the authoritative, named, persisted artifact** (the detailed match is
derived/cached, the elevation totals too). Mode A → a **local named library** in `localStorage`/
IndexedDB + GPX. Mode B → a **shared multi-user** loft `world` store, written through to disk on the
server (direct backup), synced over WS — multiple people load and change the same routes.

**Auto-proposed names.** When a route is first saved, the app proposes a default name from the
**general area + rough length + type** — e.g. *"Vondelpark · 8 km · Trail run"* — which you accept or
override (low floor: never forced to invent a name; high ceiling: rename freely). loft composes it: it
already has the length and type; the **area** comes from a light **reverse-geocode** of a
representative point (e.g. Nominatim) or a named feature lifted from the corridor data it already
downloaded. It's **lag-tolerant** (slower tier) — the name can fill in a moment after you open save.

---

## 10. Still open
1. **Offline on the phone** — should matching work with no network (cached corridor data), or is
   online-only (Overpass) acceptable for v1?
2. **Map-matcher depth** — full HMM vs v1 corridor-routing-with-deviation.

*Resolved:* **Project home** — standalone repo `jjstwerff/routing` (private), a sibling consumer of
the loft language at `../loft`. **Goal length** — optional, feedback-only; never auto-reshapes the
route (§1). **Target-distance auto-fit** — explicit non-goal. **Undo** — platform-adaptive over one
per-session history: desktop **`Ctrl+Z` / `Ctrl+Shift+Z`** multi-level; phone **"Undo" snackbar** after
bulk delete. Local & per-session; no global collaborative history (§1). **loft toolchain** — scoped &
verified (2026-07-01, loft 2026.6.0): `loft --html` AOT-compiles the kernel to `wasm32-unknown-unknown`
and runs in-browser (tested); road-data fetch + WS sync are loft-side via the `web`/`server` registry
libraries; the store is an app-defined struct persisted write-through (no stock
`lib/server`/`lib/world`). **Architecture (2026-07-01): server-first** — loft runs native on a server,
the browser is thin JS + Leaflet over a WebSocket (audience-demo pattern); loft-in-browser is deferred
to an offline mode that needs an upstream `--html` data-in primitive ([docs/loft-feedback.md](docs/loft-feedback.md)).
See §3/§4.

*Later (deferred):* a **"not-done" / draft save** — a special save type bundling the work-in-progress
state *including the undo data*, so an unfinished route can be put down and resumed with its undo
history intact. Normal saves persist just the finished rough route; per-session undo is otherwise
ephemeral. (In **server mode** the route's working state is already continuously persisted out-of-band
— §4 — so there the deferred piece is mainly persisting the *undo history* itself.)

---

## 11. Build & run (target)
- **Client:** static `index.html` + JS/CSS, no build step — served by the loft server over HTTP.
- **Shared compute:** pure-loft `lib/routing_kernel` (§3), consumed by the server (and later the
  browser kernel, unchanged).
- **The server (v1):** `loft --native server/server.loft --lib lib` (audience-demo shape). Registry
  deps (`server`, `web`) resolve via `loft install`, or path-dep to the local
  `../loft-libs-net/{server,web}` checkouts. Serves the static client + the WS on one port.
- **Deferred — offline browser kernel (Mode A):** `loft --html client/kernel.loft --lib lib` → cdylib
  on `wasm32-unknown-unknown`, `wasm-opt`-shrunk (~330 KB gz), committed so running needs no toolchain.
  Blocked on the `--html` data-in primitive (§3).

---

## 12. Maritime routes — evaluated, NOT planned (2026-07-03)

Sailing (with keel draft) and paddling (kayak/canoe) were evaluated as future activities. The verdict:
**feasible, but held off deliberately.** We will not touch this until the existing tool is thoroughly
tested — it would rewrite a core component (the matcher), and that is exactly what should not move
until what sits on top of it is proven. This section records the evaluation so the decision does not
have to be re-derived.

**The one distinction that governs everything:** the *map* (the picture on screen) is the cheap part;
the *routing data + the routing engine behind it* is the real cost. A nautical basemap is one Leaflet
tile layer — we already swap CyclOSM in for the MTB sub-mode (§7), so an OpenSeaMap seamark overlay
drops in the same way. But a nautical **picture** is not nautical **routing**: the chart tiles are
pixels; the depth field, the hazards, and the tides behind them are what actually route a boat.

Everything the matcher does today hangs off one assumption (§5): **a route is a match onto the OSM
`["highway"]` way network.** The corridor query, `parse_ways`, `build_graph`, and the `way_penalty`
profiles are all keyed to that network. The two maritime cases sit on opposite sides of whether that
assumption holds.

### Case A — kayak / canoe: fits the existing model
Inland paddling is *also a network of ways.* OSM maps rivers and canals as `waterway=river|canal|stream`
— the same shape the matcher already consumes. This is additive, not a rewrite:
- Corridor query `["highway"]` → `["waterway"]` (plus `natural=water` for open bodies).
- `parse_ways` reads `waterway`/`boat`/`canoe` tags instead of `surface`; a new `paddling` profile in
  `way_penalty` (prefer river/canal, avoid `rapids`).
- **Portage:** dams, weirs, locks, and waterfalls are *barriers* — break the edge or add a cost node.
- Geodesic, GPX, elevation, route store, and sync are reused unchanged.

Depth barely matters on a mapped canoe route — the topology is the thing. This is the low-risk half and
the closest to "add another activity."

### Case B — sailing with keel draft: a second routing engine, not a profile
Open water breaks the core assumption: there are **no ways to match onto.** A keelboat takes any line
across a bay that has enough water under it. That flips routing from *graph-match* to *continuous-field
least-cost*:
- **Rasterize navigable water into a grid**, cost each cell by depth, run a grid A*/Dijkstra. A new
  kernel path (`match_water`) *beside* `match_route`, not inside it. The "faithful, not scenic"
  matcher philosophy (§5) does not even apply — there is no drawn way to hug.
- **Draft is a hard passability constraint** with a per-boat parameter (the keel depth). That is a new
  numeric input the UI must carry, and it is in real tension with the north-star's tiny primitive set —
  it is one more knob. A kayak's draft is ~0, so the same engine covers both at different thresholds.

It also needs **three data sources the pipeline does not have:**
- **Bathymetry (depth).** OSM/Overpass has *no* soundings. Depth comes from GEBCO (coarse global),
  EMODnet (Europe), or NOAA ENC (US charts). The elevation subsystem is a ready-made template — it
  already fetches raster tiles, PNG-decodes them, and samples a scalar field (`terrarium_h`,
  `elev_profile`; see ARCHITECTURE.md). Bathymetry is "negative elevation": the *mechanism* exists;
  only the tile source and the hard-constraint *use* are new.
- **Hazards & seamarks** — rocks, wrecks, restricted zones, buoys. OpenSeaMap carries some as
  `seamark:*` OSM tags (Overpass-queryable), but coverage is patchy and **not authoritative.**
- **Tides & currents (a time axis).** Passability is time-varying — a channel that floats you at high
  tide is dry at low. The whole tool is time-invariant today. Sailing also cannot go straight upwind
  (tacking), a routing cost no land mode has. This is the genuinely new dimension, and it is what
  separates a fun sketch tool from something to trust off the dock.

### Reused vs new
| Reused as-is | New for sailing |
|---|---|
| UI primitives (tap points, zoom-as-precision, live geodesic length) | Grid least-cost engine (`match_water`) |
| GPX export, route store, live sync | Bathymetry raster source + a draft input |
| Base/overlay tile swapping (§7) | Hazard/seamark layer; tide/current/wind (time axis) |
| Elevation raster pipeline → bathymetry template | — |

### Why not now, and the staged path if taken
The clean read: **paddling is an activity; sailing is a second product** that shares the UI shell,
geodesic, GPX, and raster-tile plumbing but needs its own matcher and its own data. Neither should
land while the land matcher and its dependants are still being hardened. If revisited, in order:
1. **Kayak/canoe on mapped waterways** — the graph-matcher we have, a new profile, a `["waterway"]`
   layer, portage barriers. Fits the architecture and the north-star.
2. **OpenSeaMap nautical overlay** — ship anytime, but labelled display-only, *not* routing.
3. **Open-water sailing with draft** — its own phase: grid engine + bathymetry raster + draft input +
   hazards, and not trustworthy without tides/currents.

**Safety caveat:** none of this is a substitute for official charts. A crowd-sourced sketch must never
be presented as safe to navigate a keelboat by.
