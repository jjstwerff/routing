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

**Design north-star — low floor, high ceiling.** *Easy to pick up:* open it, tap a few points, read
the length, get a good matched route with **zero setup**; imprecise taps are forgiving by design and
the activity defaults carry a beginner. *A precision knife for an expert:* the **same tiny primitive
set** — place/drag/insert/remove points, **zoom-as-precision**, sub-mode, **live length** — gives a
practised user *exact* control, *fast*. Precision comes from a **small, sharp, predictable** primitive
set, **not** from piling on features. Two bindings this puts on the rest of the design:
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

| | **JS (vanilla + Leaflet)** | **loft (compact AOT wasm service)** |
|---|---|---|
| Owns | interactive rough points (place/drag/insert/remove), Leaflet map (OSM base + Waymarkedtrails overlay + **overlay/chart toggles**), **instant rough length** (haversine), **drawing** the detailed polyline + **elevation chart**, UI | **import/export of routes (GPX)**, **downloading road-pattern data**, **map-matching / routing**, **accurate geodesic length**, **elevation sampling (ascent/descent + profile)**, simplification |

JS = points + pixels. loft = routes + data + math.

---

## 3. The loft kernel — compact, AOT, phone-first

- **No loft parser in the browser.** loft is **AOT-compiled** to wasm (`loft --html` / cdylib,
  `wasm32-unknown-unknown`) — only the *compiled* kernel ships, **not** the interpreter (~2.5 MB).
  The AOT kernel is ~**200–400 KB raw wasm (~70–130 KB gzipped)**, `wasm-opt`-shrunk.
- **Small startup, always precompiled.** Startup = load-and-instantiate a small module; no
  in-browser compile, nothing to parse.
- **Runs as a service in a Web Worker.** It owns its own loop and can block on downloads without
  freezing the map. JS posts requests (`match these points, this profile`) and gets back the
  detailed polyline + length (push/poll byte channel — the sanctioned loft browser model, see
  `../loft/doc/claude/BROWSER_INTEROP.md`). The actual network syscall is a thin JS host-import,
  but loft decides what to fetch and computes the route.
- **Phone-first / PWA.** Pure static client + small wasm + Leaflet (~40 KB gzipped) → drops into a
  phone browser, installs as a **PWA**, and wraps cleanly in a native WebView (Capacitor/Cordova)
  later with no rearchitecting.

Kernel compute surface (all f64 — loft `float` is double, confirmed in `../loft/src/data.rs`):
geodesic length (WGS84 ellipsoidal), per-segment lengths, Douglas–Peucker simplify,
nearest-segment projection, and the **map-matcher** (§5).

---

## 4. Hybrid deployment — one client, two modes

Same client, mode chosen at runtime by whether it was loaded from a live loft server.

- **Mode A — Standalone (fully independent, "for people to use").** Pure static files + the wasm
  kernel. No server. Routes are saved as a **local named-route library in the browser**
  (`localStorage`/IndexedDB) — store a few routes, reopen and re-edit them — and travel between people
  as GPX. Road data fetched from the public source directly. This is what a stranger just opens.
- **Mode B — Server-backed (your own server + direct backup).** A **loft server** (built on
  `../loft/lib/server` + `lib/world` + `lib/engine_host`) serves the client over HTTP and holds a
  **shared, named route store that multiple people can load and change**. It **persists the rough
  route** — the editable points, the *source of truth*, so anyone can reopen and quickly re-edit —
  straight to disk on every accepted edit (the "direct backup", mirroring audience-demo's `world.bin`),
  and **syncs edits over WebSocket**: broadcasting changes to other open clients and replaying current
  state to new ones (the audience-demo collaborative pattern; single-port HTTP+WS, client derives its
  WS URL from `location.host`). The detailed match is derived/cached, not the stored truth. May also
  proxy/cache road-data fetches. Mode B only *adds* naming + multi-user sync + backup; Standalone is a
  strict subset (local named library + GPX).

---

## 5. Matching — clean the line onto real paths (faithful, not scenic)

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
- **Import:** loft parses a GPX back into an editable route.

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

---

## 10. Still open
1. **Offline on the phone** — should matching work with no network (cached corridor data), or is
   online-only (Overpass) acceptable for v1?
2. **Map-matcher depth** — full HMM vs v1 corridor-routing-with-deviation.

*Resolved:* **Project home** — standalone repo `jjstwerff/routing` (private), a sibling consumer of
the loft language at `../loft`. **Goal length** — optional, feedback-only; never auto-reshapes the
route (§1). **Target-distance auto-fit** — explicit non-goal.

---

## 11. Build & run (target)
- **App (both modes):** static `index.html` + JS/CSS, no build step.
- **loft kernel:** AOT-built from loft source (`loft --html`/cdylib), `wasm-opt`-shrunk; artifact
  committed so running the app needs no toolchain.
- **Mode B server:** `loft --lib ../loft/lib <server>.loft` (audience-demo shape).
