# PLAN-MATCH — matching performance & accuracy (the escalation ladder)

Refines **DESIGN §5** (Matching) for the tile-data era. §5 assumed a *tight corridor fetched from
Overpass* that "physically caps deviation." With a **local tile block** (PLAN-TILES) the corridor is
free to read but the graph we build from it dominates cost, and — crucially — a corridor tight enough
to be cheap will silently drop the routes we most care about. This plan replaces "one corridor, one
match" with a **cheap-first escalation ladder** whose accuracy floor is never lowered.

**Scope:** this is the *sketch-faithful* routing family — foot, cycle, and a *scenic* drive, where the
line you drew is the point. Motorised "just get me there" and transit are a different algorithm with
different deciding numbers (time/distance, not deviation); see **§9**.

The touch points in code: `match_for` / the widen loop in `server/server.loft`, `tiles_corridor_ways`
/ `build_graph` / `match_incremental` in `lib/routing_kernel`, and the tile record in PLAN-TILES.

---

> **Reframed 2026-07-17 — read `PLAN-PERF.md` §6b alongside this.** This plan asks "how do we make ONE
> big search cheaper?" and answers with an escalation ladder. The app-level measurement changed the
> question. Two facts this document predates:
>
> 1. **The route is already per-stretch, and it now STREAMS — from the KERNEL.** `subs` is one sub-path
>    per stretch, each independent, and they are emitted as they are matched, in travel order.
>    ⚠ **But nothing renders them** (2026-07-22): the browser receives the whole response at `#EOR` and
>    draws only the final `ROUTE`, so "time to the first stretch" is not yet a user-facing number — the
>    user-facing cost is still time to the whole route. See `PLAN-PERF` §6b(2).
>    A cheaper ladder tier improves the total; it does not create the responsiveness, and the ladder is
>    the only lever here that can return a WORSE route.
> 2. **The numbers below came from a 3-point sketch** (2 huge stretches, widest corridor) — the
>    pathological end. A real drawn route is ~40 points: measured, that is 39 stretches of ~24 ms each
>    (native) over a *tighter* corridor (9376 vs 13077 ways), because `corridor_margin` scales with tap
>    spacing. **Drawing more points makes each chunk cheaper and the corridor smaller.** The §1 table's
>    "886 ms" is a worst case, not a typical one.
>
> The ladder is still wanted — it is what makes the rare COLD match cheap (PLAN-PERF steps 20–22), and
> §3's quality gate is still the right acceptance. Just do not read it as the answer to "why does it
> feel slow"; that was a frozen main thread, and streaming fixed it.

## 1. Problem — the cold/miss match is fat, and tightening it fails *silently*

Warm edits are already fast: an in-coverage move/add/remove re-matches only the edited window
(`covered()` + `match_incremental`) in **~40–68 ms**. That path is fine and unchanged here.

The cost is the **cold match / coverage-miss** — when a fresh area's corridor must be built. Measured
on a 40-point, ~6 km route over the southern-Overijssel block:

| corridor | ways | build+match | matched route |
|---|---|---|---|
| **bbox cell-window (current)** | 20,472 | 367 + 519 = **886 ms** | 171 pts, **6955 m**, 0 bridges |
| cell-tube, ~2 km (buf 0) | 6,945 | 114 + 178 = **292 ms** | 179 pts, **7491 m**, 0 bridges |
| cell-tube, ~4 km (buf 1) | 18,331 | 316 + 461 = 777 ms | 171 pts, 6955 m, 0 bridges |

Two hard facts fall out of this table:

1. **Cost is graph size, not corridor read.** Selecting the bbox cells is ~47 ms; `build_graph` +
   per-segment search over 20k ways is the ~880 ms. Fewer ways ⇒ proportionally faster.
2. **Uniform tightening is NOT accuracy-neutral.** The 3× faster option returned a **different route,
   with zero bridges.** It came out 536 m longer — but **length is not the point, and longer is not
   worse.** It was a *different, less activity-suitable* route: by clipping ways out of the corridor,
   the matcher's best remaining option was a straighter, bigger-street path instead of the
   profile-preferred one. *No bridge fired,* and the length difference is a symptom, not the criterion.
   So **"0 bridges" is not a sufficient "good enough" test**, and neither is any length rule — a global
   tightening can quietly swap the *wanted* route for a technically-connected worse one.

And a mechanism note: filtering a corridor to a true perpendicular tube with per-way
distance-to-polyline is **too slow to do per match** (a full-route `point_polyline_m` sweep over the
candidate ways blew past a 2-minute budget). Corridor narrowing has to be **cell/index-level**, never
per-vertex-distance at match time.

### The case that matters most — curving waymarked trails

The routes we most want to nail are **hand-curated foot/cycle trails (Waymarkedtrails overlay)**, and
a real trail can **curve far from the straight sketch line** between two dragged points. A corridor
tight enough to be cheap excludes the bulge of the curve, so the matcher takes a straighter road that
*looks* fine (0 bridges, plausible length) but is the wrong path. This is the silent-failure above, in
its most important form. It is the reason the design cannot be "just narrow the corridor."

---

## 2. Principle — escalate from cheap to guaranteed, never lower the floor

Same shape as the existing **adaptive-widening** fallback (DESIGN §5): start with the cheapest thing
that could work, check whether the result is *good enough*, and escalate only when it isn't. The **fat
bbox corridor remains the final tier**, so the worst case is exactly today's accuracy — we only ever
*add* faster paths in front of it. Determinism (§5) is preserved: same input → same tier → same match.

Per rough segment (a pair of consecutive sketch points), the match tries tiers in order and stops at
the first *good-enough* result.

---

## 3. Positive heuristic — a "good enough" gate on *the wanted route*, not on length

The early-exit test that lets a cheap tier win. "Good enough" means **this is the route the full data
would have picked** — the minimiser of the matcher's own objective (deviation-from-sketch, dominant, +
bounded activity-suitability penalty; DESIGN §5/§6). It is emphatically **not** "short enough": a route
that curves onto a cycleway or trail is longer *and* wanted. So the gate is three conditions, and the
third is about **route quality by the active profile**, not distance:

- **Connected** — 0 bridges across the segment (a path exists), *and*
- **Faithful** — the matched sub-path stays within a deviation envelope of the sketch (`max`/high-
  percentile perpendicular distance ≤ `DEV_TOL`). Faithfulness is measured against the *drawn line*,
  which curving-but-wanted trails still satisfy — they hug where you drew — so this does not penalise a
  legitimate curve, *and*
- **Not forced onto worse ways** — the match is *not* dominated by activity-suitability **penalties**.
  The tell that a cheap corridor clipped the wanted route is that the matcher had to route onto
  profile-*penalised* ways (a walker pushed onto a primary/secondary road, a cyclist off the cycle
  network) where the sketch suggests something better should exist. Quantify as: the suitability-penalty
  share of the matched cost, or the highest road class traversed vs. what the profile prefers, stays
  under `PEN_TOL`.

Only a match passing **all three** is accepted from a cheap tier; anything else escalates to a wider
tier that *can* see the better ways. `DEV_TOL` / `PEN_TOL` are per-profile constants (a trail run
tolerates more curve and lower road classes than a road ride) — the same profile weights that are the
main first-match lever (DESIGN §6). Start generous, tighten against real routes.

### Tuned against a corpus (2026-07-17, `tools/corpus_tube.loft`, cycling_road)

25 deterministic sketches, cell-tube (PLAN-PERF step 20) vs bbox, scored on the §7 numbers. 8 diverged;
3 of those were genuinely **worse** (the tube bridged where bbox did not, or deviated materially further).
Sweeping the gate over the tube's OWN numbers — all it can see at runtime:

| `DEV_TOL` | accepted | escalated | **worse accepted** |
|---|---|---|---|
| 700 | 10/25 | 15 | 0 |
| **900** | **13/25** | 12 | **0** |
| 1000 | 14/25 | 11 | 0 |
| 1100 | 18/25 | 7 | **1** ← lets i=7 through |

**Findings:**

1. **"Connected" does most of the work.** `bridges == 0` alone catches 2 of the 3 worse cases (i=2, i=14 —
   the tube bridged where bbox did not). Only i=7 (connected, but dev_max 1003 vs bbox's 484) needs a
   deviation threshold at all.
2. **`DEV_TOL = 900`, not 1000.** 1000 maximises acceptance and still rejects everything worse — but the
   boundary is *highest acceptable 971 vs lowest worse 1003*, a **32 m window** on 25 sketches. That is
   fitted to the corpus, not learned from it. 900 costs **one** case of acceptance (14 → 13) and buys a
   103 m margin. §3's own safety argument decides it: the gate can only make us escalate, so erring low
   costs speed and never a route.
3. **`PEN_TOL` does not discriminate here — do not set it from this corpus.** Accepted sketches span
   pen_share −1.200…−0.038; the worse ones span −0.938…−0.385 — *fully overlapping*. On `cycling_road`
   every share is negative (the cycle-infra bonus dominates the penalty), so the number carries no signal.
   It is expected to matter on **walking/trail** profiles, where penalties dominate rather than bonuses —
   which is exactly where §3 predicts the "forced onto worse ways" tell lives. **Re-tune per profile;
   these are `cycling_road` numbers only.**

**Caveat, stated so it is not forgotten:** 25 synthetic sketches over one block. The corpus already
overturned a 3-sketch conclusion once (PLAN-PERF §7b), so treat 900 as the current best estimate, not a
constant — and re-run the sweep when the corpus grows or the profile changes.

> ⛔ **SUPERSEDED 2026-07-22 — do not wire `DEV_TOL` as an absolute threshold.** The tuning above is
> correct on its own terms (0 worse accepted) and still makes the app **1.7× slower**: `dev_max` measures
> distance from the DRAWN SKETCH, so it is large whenever the user drew far from any road — under *both*
> tiers. The gate then reads "far from the network" as "the cheap corridor clipped something", escalates,
> and pays twice for an identical route. **8 of the 12 corpus escalations have `t_devmax == b_devmax`.**
> Measured, reverted, and written up in PLAN-PERF §7h, with two candidate redesigns — gate on
> `bridged_m == 0` alone, or make the deviation test relative to `corridor_margin` (which tests the
> CORRIDOR rather than the sketch, and needs no fitted constant).
>
> ✅ **The second SHIPPED (§7h(2)):** the live gate is `bridged_m == 0 && dev_max <= corridor_margin * 6`,
> swept on a 26-sketch corpus (0 worse accepted; K=8 is cost-optimal, 6 chosen for headroom because the
> gate can only make us escalate). Cold match **6370 → 3253 ms**, route byte-identical on all 5
> `match_parity` cases. **`DEV_TOL` above is retained only as the record of why an absolute threshold is
> the wrong shape.**

> The gate can only make us *escalate* (spend more), never accept something a wider tier would improve
> on. So mistuning it costs speed, never the wanted route — the fat corridor (§5, tier 3) is always the
> floor.

---

## 4. Negative heuristic — trail-lock (follow the trail, not a corridor guess)

The direct fix for the curving-trail case, and a speed win in its own right:

**If both endpoints of a segment lie on the *same* known waymarked trail, match by walking that
trail's own geometry between them — regardless of how far it curves from the sketch line.**

- **Accuracy:** we follow the *actual* trail, so a curve that a corridor would clip is followed
  exactly. The thing we most want to be faithful to is matched faithfully by construction.
- **Speed:** a walk along one trail's edges is a tiny targeted traversal, not a Dijkstra over a
  thousands-of-ways corridor.
- **Determinism:** trail membership is a static property of the data, so the lock is reproducible.

Guards: only lock when the sketch segment actually *tracks* the trail (endpoints on the same trail id
**and** the sketch stays within a loose band of the trail between them — otherwise the user is cutting
across, not following it). If the lock's own result fails the §3 gate, fall through to the corridor
tiers. A segment may be partly on-trail; lock the on-trail span and corridor-match the rest.

**Data dependency:** this needs **trail membership in the tile record** — see §6. Until that ships,
tier 2 (trail-lock) is skipped and the ladder is tiers 1 → 3.

---

## 5. The ladder

Per segment, in order; stop at the first result passing the §3 gate:

| tier | what | cost | when it wins |
|---|---|---|---|
| **0. Warm** | `covered()` + `match_incremental` on the cached graph | ~tens of ms | edit inside an already-built area (unchanged today) |
| **1. Cheap corridor** | cell-tube (buf 0, ~2 km) → build → match, then §3 gate | ~300 ms | segment hugs an obvious way; gate passes |
| **2. Trail-lock** | both endpoints share a trail id → walk the trail | small | curving waymarked trail (§4); needs §6 data |
| **3. Fat corridor** | today's bbox cell-window → build → match | ~900 ms | ambiguous / gap stretches — the accuracy floor |

Widen-on-bridges (DESIGN §5) still operates *within* a tier as the local reconnect. Tier ordering can
be reordered by evidence: when §6 lands, trying **trail-lock before the cheap corridor** for on-trail
segments is both faster and more faithful.

Cross-tier accounting is per-segment, so a 40-point route can trail-lock some segments, cheap-match
most, and only pay the fat tier on the one ambiguous stretch — instead of paying the fat tier for the
whole route as today.

---

## 6. Tile-format addition — trail membership

Trail-lock (§4) needs each way to know which curated trail(s) it belongs to. Source: **OSM route
relations / Waymarkedtrails** (foot/bike/hiking network relations), the overlay PLAN-TILES already
prioritises.

Sketch (to detail in PLAN-TILES, keeping the compact fixed-point layout):

- A per-tile **trail table** (trail id → name/network/colour), and a **trail-id reference on `TRoad`**
  (0 = none). One byte or a small varint covers a tile's distinct trails; ways off every trail cost
  nothing.
- A way may sit on more than one trail — carry the primary, or a short list, per the byte budget.
- The generator (`gen6` lineage) reads the relation membership during OSM ingest and stamps the id.

This is additive to the existing `tp` / `flags` / `steps` record; readers that ignore it still work, so
it can land before the matcher uses it. It also feeds the **map overlay** (show trails, unavailable-day
indicators, §PLAN-TILES) — the same data serves display and matching.

---

## 7. Evaluation — the numbers that decide (and the ones that don't)

Speed numbers say what to optimise; they never say whether a match is *right*. The gate (§3) and the
phase acceptance (§8) are judged on **quality numbers** — and the matcher must **emit** them. Today it
returns only geometry + a bridge count, so we are blind on the axis that matters most.

**Report, but do NOT decide correctness:**
- wall-clock (warm vs cold/miss), corridor way count, build/match split, RSS.
- **matched length** — explicitly *not* a correctness signal (§1): a trail/cycleway curve is longer and
  wanted. Length is barred from the gate.

**Decide — faithfulness (to the drawn line):**
- deviation of the matched route from the sketch: **max / p95 / mean** perpendicular distance. Measured
  bbox = 116 / – / 33 m vs cheap corridor = 259 / – / 44 m — the cheap route wanders further, a real
  signal length missed. Caveat: a legitimately-curving trail also raises deviation, so high deviation
  **escalates** (never silently rejects), and trail-lock (§4) is the explicit handler for it.
- bridges: **count and total bridged length** (one long bridge ≫ several short ones).

**Decide — the wanted route (activity suitability): the matcher does not emit this yet.**
This is the real criterion ("fewer bigger streets"), and it appears in *no* length- or geometry-level
number — only in which ways were taken:
- matched-cost **decomposition**: deviation term vs activity-suitability-**penalty** term. A high penalty
  share is the tell that the matcher was forced onto worse ways (the §3 `PEN_TOL` gate).
- **road-class mix**: metres on each `tp` (motorway…service / cycleway / path / footway). A walker pushed
  onto a primary road, a cyclist off the cycle network shows up here and nowhere else.
- fraction on profile-**preferred** ways (cycle infra, trail, unpaved-for-trail) vs profile-**penalised** ways.
- (Phase 2) trail fidelity: fraction of a followed trail's length actually taken.

**Prerequisite — step 0 of Phase 1:** instrument `match_state_result` / `MatchResult` to return this
decomposition (deviation total, penalty total, per-`tp` length, bridged length). You cannot gate at
runtime (§3) or validate a tier offline on numbers the matcher never produces.

**Comparison protocol (cheap vs fat = the wanted-route ground truth):** run both tiers over a route
corpus; a cheap match is correct iff its **quality numbers** track the fat tier's (same preferred/
penalised mix, deviation within noise) — *not* iff its length or geometry is identical. Divergence on
the suitability numbers *is* the definition of "the gate must escalate here."

---

## 8. Phasing

**Phase 1 — algorithm only, no data change (do first).**
Cheap-first corridor + the §3 deviation gate + fat-corridor fallback, in `match_for` /
`tiles_corridor_ways`. Cell-tube selection is a cheap change to the corridor cell set (cells near the
polyline + buffer, not the full bbox rectangle). No tile-format change; accuracy floor unchanged.
*Acceptance:* the 40-pt cold/miss drops toward ~300 ms on segments that pass the gate, **and wherever
the gate accepts, the cheap-tier match tracks the fat-tier result on the §7 quality numbers**
(preferred/penalised road-class mix + deviation within noise — *not* identical length or geometry),
validated over a route corpus; any divergence on those numbers must escalate, not slip through.

**Phase 2 — trail-lock + tile trail membership.**
§6 format + generator, then tier 2 in the matcher. *Acceptance:* on a set of routes drawn loosely
along waymarked trails, trail-lock reproduces the trail geometry (curves included) where today's
corridor match straightens or detours it; measurably fewer "wrong straighter road" cases.

---

## 9. Mode × intent — where this ladder stops and routing begins

Everything above is the **sketch-faithful** family: the user draws the shape and the match hugs it
(deviation dominates, length is barred; §1/§7). Right for foot, cycle, and a **scenic drive** — cases
where *the line you drew is the point*.

It is the wrong family for **"just get me there."** For a car commute or a bus/train hop the user
won't trace the road — they set endpoints and want the network's own best path: **point-to-point
routing (Google-Maps style) — least-cost over the whole mode-filtered network, cost = travel
time/distance**, corridor-unconstrained. Different algorithm (A\*/contraction-hierarchies over the full
graph, not a corridor Dijkstra hugging a sketch), and the sharp part: **the deciding numbers flip** —
here time and distance *are* the objective, exactly what §1/§7 bars for the sketch family.

**Priority stack:**

1. **Foot & cycle, sketch-faithful** — the core differentiator and primary investment; the whole
   ladder, gate, and trail-lock serve this first.
2. **Scenic driving** — also a differentiator (sketch-faithful, for cars), but ranks *below* foot/cycle:
   worth doing, not first.
3. **Get-me-there** (point-to-point car / bike / transit) — lower priority than the sketch families, but
   **not a pure commodity**. Plain fastest-car is what a general router (Google Maps) already does well;
   everything our **rich tile data** touches, it does *not*:
   - **Bike routing** — Google Maps' bike get-me-there is notoriously poor. A router that actually
     respects cycle infrastructure, surface, and gradient over our own network is a real differentiator.
   - **Elevation-aware routing + height profile** — a car route through the Alps shown *with its climb
     profile* (the same data we already compute for the elevation dock, DESIGN §7) genuinely aids
     planning; likewise gradient-seeking or gradient-avoiding route *choice*, not just display.

   So the algorithm stays the point-to-point family (least-cost over the full network), but the **cost
   model and the presented result draw on the same rich data** that powers the sketch families — which
   is where the edge comes from. Transit stays a rough "does-it-fit" estimate, not a minute-accurate
   planner.

Investment order: foot/cycle sketch-faithful first, scenic driving next, then a **data-differentiated
get-me-there** (bike + elevation-aware) — with only plain fastest-car being genuine commodity. The
get-me-there family (its data needs — speed / `h` / oneway — and the "fast known routes" route
hierarchy) is speced separately in **PLAN-ROUTING**; this doc only reserves the fork.

So the family is chosen by **intent, not mode** — and a car spans both:

| mode | intent | family | decides on |
|---|---|---|---|
| foot / cycle | draw the shape | sketch-faithful (this plan) | deviation + suitability; **length barred** |
| car | scenic drive | sketch-faithful (this plan) | deviation + suitability |
| bike | get there | point-to-point, **data-differentiated** | time + **cycle infra / surface / gradient** |
| car | get there | point-to-point (+ **elevation profile**) | time / distance, **climb shown & weighed** |
| bus / train | get there | transit (availability-aware) | rough time + which lines run; day-plan |

Consequences for the architecture:

- **Intent is a first-class input, not derived from mode** — a car is either. Surface it (a fast/scenic
  toggle for motorised; foot/cycle default to sketch-faithful). Even "fast" car may yield to scenic —
  the driver's goal, not the clock, picks the family.
- **Fast routing needs no corridor** and skips this whole ladder — it wants the full mode-filtered
  network the tile block already holds; a good A\*/CH is its own performance track.
- **Transit is a third family:** routing over *scheduled lines with availability* (which run today, not
  exact times — PLAN-TILES' day-plan premise), for rough "does it fit in a day" estimates, not a
  minute-accurate itinerary.
- **The right numbers are per-family (§7):** sketch-faithful bars length and decides on
  deviation+suitability; fast routing decides on time/distance; scenic-car stays sketch-faithful even
  though it's a car.

The ladder, gate, and trail-lock are scoped to the sketch-faithful family. Fast point-to-point routing
and transit routing are separate algorithms that deserve their own plans — noted here so the matcher
architecture **reserves the fork** instead of assuming one algorithm for every mode.

---

## 10. Open questions

- **`DEV_TOL` / `PEN_TOL`** — per-profile (a trail run tolerates more curve and lower road classes than
  a road ride), and how to express `PEN_TOL`: penalty share of matched cost vs. a hard road-class ceiling
  vs. both. Length is deliberately *not* a gate term — confirm nothing sneaks it back in as a proxy.
- **Cell-tube buffer** — 1 cell (~2 km) is safe but barely helped the compact S-route; a
  half-cell/finer grid, or a per-segment cell march, may be needed for real savings on convex routes.
- **Trail-lock band** — how loosely may the sketch stray from the trail and still count as "following
  it" before we treat it as a deliberate shortcut?
- **Multi-trail ways & overlaps** — encoding budget vs. losing membership on braided networks.
- **Graph reuse** — Phase 1 still rebuilds `build_graph` per miss; a per-area graph cache is a later,
  orthogonal win (accuracy-neutral by construction).
- **Intent & the routing families (§9)** — how the user picks fast vs scenic (explicit toggle vs
  inferred from how carefully they drew); what algorithm fast car routing uses (A\* vs contraction
  hierarchies) and whether it needs its own precompute over the tile block; how transit availability is
  modelled and matched. Each is a separate plan; this one only reserves the fork.

---

*Measurements in §1 are from the native `--native-release` build against the regenerated
southern-Overijssel block (1215 tiles, 229,117 ways) on 2026-07-07.*
