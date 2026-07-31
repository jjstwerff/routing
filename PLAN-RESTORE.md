<!-- Copyright (c) 2026 Jurjen Stellingwerff · SPDX-License-Identifier: LGPL-3.0-or-later -->

# PLAN-RESTORE — putting back what the serverless rewrite dropped, without a server

The server-based Leaflet client (`index.html`, `app.js`, `controls.js`, `ws.js`, `geo.js` at the repo
root, with `server/server.loft`) still exists and still runs under `make run`. The deployed app is the
serverless one in `browser/`, and it **silently lost working features** in the rewrite. This plan puts
them back — under a rule that makes several of them a different job from how they were built the
first time.

Two of the entries below were never built at all: they were **designed, written down, and left**. Those
are marked, because "restore" and "finally implement the plan" want different amounts of care, and
because in both cases the design is better than what a fresh attempt would produce.

> ## The rule this plan is built on
>
> **Everything the app needs lives in OUR FILES. It fetches nothing external, ever.**
>
> That is not only about working offline in a valley. It is a **routing correctness** requirement: data
> the router cannot read cannot influence a route. The old client showed curated walking and cycling
> networks as a **Waymarkedtrails raster overlay** — pixels a human could see and the matcher could not.
> A route over a signposted regional path and a route over the parallel farm track looked identical to
> the router, because the network existed only in someone else's tiles.
>
> So the overlay is **not** what gets restored. The data behind it does.
>
> ⚠ **And that was already the plan.** `PLAN-TILES.md` §*Future — multi-modal day-plans* (lines 292–300,
> commit `bcd28df`) says it in as many words: *"That overlay is raster (for looking at); routing needs the
> vector membership — which ways belong to those networks — read at ingest from the same OSM route
> relations Waymarkedtrails is built on … Captured as a per-way flag, the cost table turns it into a
> bounded leisure bonus matched to the active activity's network … it picks the nice way among candidates
> by your line but **never detours out of the corridor**."* `PLAN-BROWSER.md:271` names the same thing.
>
> So the curated networks were **designed and never built** — the overlay was the visible half shipping
> alone. Verified: zero network bits in `TRoad.flags`, zero network terms in `way_penalty`, and the old
> server's Overpass query is `way["highway"](around:…)` — **ways only, never relations**. This plan
> implements an existing design; it does not invent one.

---

## 1. What was lost — measured, not remembered

Grepped across both trees, 2026-07-31:

| feature | old client | new app | what it depended on |
|---|---|---|---|
| activity × sub-mode selector (9 profiles) | ✅ `controls.js` | ❌ `const PROFILE = 'cycling_road'` (`store-app.mjs:20`) | nothing — pure UI |
| curated walk/cycle/MTB networks | ⚠ *raster overlay only — the routing half was designed, never built* | ❌ | waymarkedtrails.org tiles |
| CyclOSM base map for MTB | ✅ | ❌ | external tiles |
| elevation profile | ✅ | ❌ | server → AWS terrarium PNGs |
| geocode / locate | ✅ | ❌ | server → Nominatim |
| route save / name / list / autosave + history | ✅ `ws.js` + server | ❌ | server store |
| live sync across clients | ✅ | ❌ | a server, by definition |
| rough-layer editing (insert/drag/multi-select/undo) | partial | ✅ | — (PLAN-EDIT E0–E7) |

**The routing half of the profiles never went anywhere.** `way_penalty(profile, hw, surface, tracktype)`
implements all nine — `walking_paved|trail`, `running_fast|trail`, `cycling_road|gravel|mtb`,
`driving_fastest|avoid` — as a bounded per-metre penalty, with **11 tests in
`lib/routing_kernel/tests/profiles.loft` running in `make test` today**. Only the selector is missing.

**The designs are written. Do not redesign them** — including the one for the *unbuilt* half: `DESIGN.md` §6 (the profile matrix) and §7 (overlay
toggle), `PLAN.md` step 8 (done 2026-07-01, with its acceptance check), `PLAN-MATCH.md` §9 (mode ×
intent), `PLAN-ROUTING.md`, and **`PLAN-TILES.md` §Future (292–300) for the network membership itself**.
Commits: `bf5220b`, `fdf59d6`, `c76a915`, `1744cba`, `bcd28df`.

---

## 2. The rule sorts the work into three kinds

| kind | features | cost |
|---|---|---|
| **A · already in our files** | profile selector, import/retrace, route save (local) | UI only |
| **B · must be BAKED IN at generation** | curated networks, elevation, geocode index | data assembly + one block regeneration |
| **C · needs a server by nature** | live sync between two people's phones | out of scope while the app is static |

Kind B is the real content of this plan, and the reason to read §4 before starting any of it: those
three want **one** schema change and **one** regeneration between them, not three.

---

## 3. Steps

House rules: one commit, one observable, gates green at each, and nothing ships that a gate cannot
re-check. Where a step regenerates a block, `tools/conservation_gate.sh` runs on the result — a category
that goes to zero is how every silent loss in this pipeline has looked.

### R1 · The activity × sub-mode selector — UI only

Two selectors building `"<activity>_<submode>"`, sent with each match. Copy the shape from
`controls.js` (`Running: Fast|Trail`, `Walking: Paved|Trail`, `Cycling: Road|Gravel|MTB`,
`Driving: Fastest|Avoid motorways`) into `browser/`, replacing the hardcoded `PROFILE`.

Changing either selector **re-matches immediately** — DESIGN §6's "lock in fast" win: a good first
match from the activity choice, with no point edits. The re-match must go through `KernelQueue` like
every other kernel call (PLAN-EDIT E0: one road in, one road out).

*Observable:* a footpath beside a road — `Walking·Trail` picks the path, `Cycling·Road` picks the road,
by the selector alone. That is `tests/profiles.loft`'s existing assertion, driven from the UI.
*Gate:* `map_render_gate.sh` — the selector re-matches, and the route differs between two profiles on
one fixture sketch.
*Cost:* hours. **Do this first** — it is the only one that needs no data.

### R2 · Bake ELEVATION into the blocks

`gen-tiles` writes `h: 0` for every step today (`tools/gen-tiles.loft:84`), and the old elevation
profile came from the server fetching AWS terrarium PNGs per request. Under the rule, height belongs in
the block: **one number per stored step**, sampled at generation.

This is also the prerequisite for the gradient/climb work `PLAN-ROUTING` describes — a bike profile that
avoids a 12% ramp cannot be written against `h = 0`.

*Observable:* a route's elevation profile drawn from the block alone, with the network off; and
`way_penalty` able to see a gradient.
*Gate:* conservation — `count steps.with_height` must be ~100% of steps in a region with terrain data,
and a fixture climb reports a known ascent.
*Note:* terrarium tiles are fetched **at generation, on the build machine**, never by the app.

### R3 · Ingest the curated networks — the big one

OSM models them as **relations over ways**: in one Enschede-sized block, **1583 route relations with
~93 213 way memberships** — `route=hiking` 1134 (rwn 925, lwn 188, nwn 18), `route=bicycle` 227
(rcn 209), `route=mtb` 16. That is the Dutch knooppuntennetwerk, and it is exactly what a walker means
by "the good paths".

Three things make it unlike anything the pipeline does today, and each is a decision:

1. **`osmium export` cannot emit them at all.** A route relation is not a geometry, it is a membership
   list. Verified: exporting `r/route` produces nothing. Collection is a **join** — resolve each
   relation to its member way ids, then mark those ways as the roads export is built.
2. **There is nowhere to put the answer.** `TRoad.flags` is a `u8` and is **full at 8/8** (`RF_*` in
   `routing_kernel`). A network membership needs its own bits — see §4.
3. **The router must then use it — and `PLAN-TILES` already says how.** A **bounded leisure bonus matched
   to the active activity's network**: `rwn`/`lwn` under `walking_*`, `rcn`/`lcn` under `cycling_*`, the
   mtb network under `cycling_mtb`. It is the **same prefer-when-near mechanism as the existing cycle-infra
   bonus** — `RF_CYCLEWAY` is already a flag `way_penalty` reads, so the shape is proven and this is one
   more of it, not a new idea.
   ⚠ It **picks the nice way among candidates by your line and never detours out of the corridor.** A
   curated path 3 km away is not the right route: *"Fastest point-to-point is explicitly not a goal —
   Google Maps' job; our edge is curated-nice routing"*, and neither is prettiest-at-any-cost.
   Use-case dependent per the design: strong for day-planning, off for get-there-quick.

*Observable:* two matches over the same sketch, one with the network term at zero and one live, differing
where a signposted route parallels an unsignposted one — and the curated one chosen.
*Gate:* `conservation_gate` gains `count network.rwn|rcn|lcn|mtb` (non-zero in this region), plus a
corpus run proving **0 worse** on the 26-sketch corpus, which is the standing bar for any
route-affecting change (`tools/corpus_anchor.loft`).

### R4 · A local geocoder — search our own labels

`locate` used Nominatim. The base store already holds what is needed: **place labels** (`N` lines,
rank-tiered) and **street labels** (`S` lines, one per named way). A prefix/substring search over those,
built at load, answers "where is Lonneker" and "find Vliegveldweg" without a request.

*Observable:* typing a place or street name centres the map, network off.
*Gate:* a fixture query set — every name resolves to within N metres of its label, and an unknown name
returns nothing rather than a wrong answer.
*Limit, stated honestly:* this finds what is IN our blocks. It will not find a shop by name, and it
should not pretend to — outside coverage it returns nothing.

### R5 · Route save / name / list, locally

`ws.js` + the server store did naming, listing, autosave and history. Without a server this is
IndexedDB, which the app already uses. The **naming** rule is worth keeping: the old proposal was
`"<area> · <length> · <type>"` with the area from a reverse geocode — R4 supplies the area from our own
labels instead.

*Observable:* save, reload with the network off, the route is still there with its name and history.
*Gate:* the browser tier — save, reload, list, open, delete round-trip.

### R6 · Import / retrace

Pure client, and the server test already describes the contract (`import reply carries a retrace flag`).
Port it.

### R7 · Live sync — explicitly NOT restored

Two phones sharing an edit needs a server; there is no offline version of it. `server/server.loft`
still implements it and still passes its gate (`subscribe, broadcast (echo-free), late-join replay`).
It stays available to whoever runs the server, and is out of scope for the static app. Recorded here so
nobody re-discovers it as a gap.

---

## 4. The schema change — do it ONCE

Three separate things now want a wider per-way field, and they must not become three regenerations of
every block:

| want | needs |
|---|---|
| `oneway=` — dropped by the store today (`PLAN-SCALE` §9, open) | 1–2 bits |
| curated network membership (rwn/lwn/nwn · rcn/lcn/ncn · mtb) | ~3 bits, or a small enum |
| room for the next one | — |

`TRoad` is `{ tp: u8, flags: u8, steps: u8 }`. Widening `flags` to `u16` costs one byte per way —
**~2.8 MB across the Netherlands' 2 784 366 ways**, against a 264 MB roads block. That is nothing, and
it buys all three at once.

⚠ **A store schema change makes every older block read GARBAGE, not empty** — loft#700, and this repo has
already been bitten: a count came back as `20981984713`. Every block must be regenerated in the same
change, and `tools/build_index.sh` and `access_gate.sh` must refuse a block whose `.dschema` lacks the
new field, exactly as they already do for `barriers@`.

**Sequence, deliberately:** R1 (no data) → §4's widening + R3 + R2 in ONE regeneration → R4/R5/R6 (no
data). Doing R2 and R3 separately means regenerating the Netherlands twice.

---

## 5. Decisions the maintainer owns

1. **How strongly should a curated network pull?** A preference weight is a routing-quality choice, and
   the corpus is the instrument (0 worse accepted). Starting point: the same magnitude as the existing
   surface preference, not more.
2. **Which networks count for which profile.** `rwn`+`lwn` for walking is obvious; whether `nwn`
   (national, often long-distance) should pull a 5 km errand is not.
3. **Elevation resolution.** Terrarium z12–13 is ~10–20 m ground sampling; finer costs generation time
   and block bytes for a gradient nobody feels.
4. **Whether the old client stays.** It is the only thing that still exercises `server/server.loft` and
   its sync/elevation/geocode gates. Deleting it would silently retire those tests.

---

## 6. What NOT to do

- **Do not restore the Waymarkedtrails overlay.** It is an external fetch, it breaks offline, and it puts
  the information where the router cannot reach it — which is the defect this plan exists to fix.
- **Do not redesign the profiles.** Nine of them exist, tested, in the kernel. R1 is plumbing.
- **Do not ingest route relations as geometry.** They are memberships; the ways are already in the block.
  Storing the geometry again would duplicate ~93k way references per region.
- **Do not add a second road to the kernel** for the profile change — `KernelQueue` is the one road
  (PLAN-EDIT E0), and the gate greps for exactly two call sites.
