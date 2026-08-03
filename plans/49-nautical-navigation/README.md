<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# 49 — Nautical navigation: paddling on the mapped waterway network

**Issue:** [`jjstwerff/routing#49`](https://github.com/jjstwerff/routing/issues/49) ·
**Value:** `G` · **Effort:** `H`

## Status

Nothing is built. `DESIGN.md` §12 evaluated maritime routes on 2026-07-03 and held them deliberately —
the verdict was *"paddling is an activity; sailing is a second product"*, and neither was to land while
the land matcher was still hardening. That condition has since been met: the matcher has a byte-identical
parity gate, a 26-sketch corpus, nine profiles and an offline country to route on.

**This plan opens the first of §12's three stages only** — kayak/canoe on mapped waterways. Stage 3
(open-water sailing: a grid least-cost engine, bathymetry, draft, tides) stays out of scope and earns
its own plan when this one is green; §12's reasoning for that split is not re-argued here. Stage 2 (a
nautical overlay) has become *more* expensive, not less — see the premise correction below.

## Goal

You can pick **paddling** as an activity, sketch a route along the Netherlands' rivers, canals and
navigable streams, and take it away as GPX — with locks, weirs and dams costed as portages rather than
silently passed through.

## Anchors

The design is written. **This plan implements it and does not re-derive it.**

| what | where |
|---|---|
| the evaluation, the two cases, the staged path, the safety caveat | `DESIGN.md` §12 |
| activity × sub-mode profiles (how a ninth becomes a tenth) | `DESIGN.md` §6, `PLAN-RESTORE.md` R1/R3 |
| how an activity was last added end to end, with its gate | `PLAN-RESTORE.md` R3 (curated networks) |
| the block, the cut, what a regeneration costs | `PLAN-SCALE.md` §6f, `plans/README.md` |
| which file does what | `docs/ARCHITECTURE.md` |

Source it touches: `tools/build-blocks.sh` (the osmium filter), `tools/gen-tiles.loft` (`class_of`,
`flags_of`), `lib/routing_kernel` (`tile_hw`, `way_penalty`, `TBarrier`), `browser/store-app.mjs` (the
activity selector), `browser/map.mjs` (drawing what you can route on).

### ⚠ Premises re-checked, 2026-08-03 — two have moved

§12 was correct when written. Three of its statements now read differently, and the plan is built on the
corrected ones (`CLAUDE.md`: *re-measure a doc's premise before building on it*).

1. **"Corridor query `["highway"]` → `["waterway"]`" is no longer where the change is.** The app routes
   over its own blocks offline; Overpass is only `server.loft`'s fallback. The roads pipeline drops
   waterways at its *first* step — `osmium tags-filter w/highway n/barrier` — so the data never reaches
   the generator. **The change is in the pipeline and the block, not in a query.**
2. **"An OpenSeaMap seamark overlay drops in the same way we swap CyclOSM (§7)" is false today.** There
   is no Leaflet in `browser/`; the app renders its own base map from its own blocks, and the CyclOSM
   swap is one of the features `PLAN-RESTORE` §1 records as *lost*. A nautical overlay now means either
   baking seamarks into the base store or re-introducing a raster tile layer the app deliberately does
   not have. Stage 2 is a design question again, not a drop-in — which is why it is phase E here and not
   phase A.
3. **In our favour:** §12 nominated the elevation subsystem as the bathymetry template. Since R2
   (2026-08-03) that pipeline no longer fetches rasters at request time — `fetch-terrain.sh` /
   `pack_terrain.py` / `gen_heights.loft` sample a scalar field **at generation** and bake it into the
   block for nothing, because the field was already in the schema. That is a better template than §12
   assumed, and it is what makes stage 3 credible later.

**The geometry is already half here, as a picture.** `nl-east.base.store` carries 924 rivers, 4 258
canals, 32 892 streams and 46 403 ditches — but as `basemap::Line`, which has a stroke style and no tags,
no graph and no route. `chooseBlocks` never offers it to the matcher. So the map can already *draw* the
water it cannot yet *route*.

## Data cost

**Not a schema change.** `TRoad.tp` is a `u8` with values 0–15 in use; waterways take new *values* in an
existing field, exactly as `oneway=` took free bits. So loft#700 does not apply, older blocks stay
readable, and every copier (`split_block`, `trim_base`, `build_overview`, `merge_base`) carries `tp`
wholesale already and needs **no change**. What it does need is a regeneration, which the pipeline now
performs in one command (`tools/refresh-region.sh <id> <src> --regions`).

Measured on the cached NL extract, so the size is a fact rather than an estimate:

| waterway | ways | in scope? |
|---|---|---|
| stream · canal · river · fairway · tidal_channel | **78 566** | **yes** — the navigable network |
| ditch · drain | 146 860 | **no** — 1 m field drainage; carrying them would add more ways than the network itself for water nobody paddles |
| weir · lock_gate · dam · sluice_gate | **6 661** | as **portage barriers**, not as ways |

So the block grows by ~78.6k ways against 2 785 476 — **+2.8%**, and the four region blocks are 255.5 MB
today. Access tags are real and worth reading rather than assuming: `canoe=yes` 6 753, `canoe=no` 187,
`boat=yes` 3 631, `boat=no` 1 625.

## Invariant gate

**A car must never be routed down a canal, and that is the strongest gate available.** Adding a way class
to a shared block is exactly the change that can silently alter every existing route, so the negative
control is the headline:

| phase | expected result | invariant it pins | negative control |
|---|---|---|---|
| **A** | block way count rises by exactly the waterway ways the export offers; the count of `highway` ways is **unchanged** | conservation — a new class *adds*, never displaces | `tools/match_parity.sh` and the 26-sketch corpus are **byte-identical** on all nine land profiles. A single changed land route fails phase A. |
| **B** | a `paddling` route down a canal with a lock in it costs the portage and still completes | a portage is a **cost**, not a wall (§12) | a lock with `boat=no` beyond it must **refuse**, not detour silently; and `driving_fastest` on the same corridor must still return zero waterway edges |
| **C** | selecting *paddling* changes the route; selecting *cycling* changes it back | the profile is the only input that moved | the control profile `driving_fastest` is unchanged by the selector's existence |
| **D** | water the router will use is drawn as water | you can only sketch onto what you can see | a ditch (out of scope) must **not** draw as navigable |

Phase E has no exact-invariant surface — it is a decision, and its output is a plan or a declined issue.

## Phases

One commit, one observable, gates green at each — the house style.

| Phase | Effort | Verify | Status |
|---|---|---|---|
| **A** — the block carries navigable waterways. Extend the osmium filter to `w/waterway`, give `class_of` its new classes and `tile_hw` the reverse mapping, drop ditch/drain by value. | M | `tools/waterway_gate.sh` (new): conservation in/out per waterway value, `highway` count unchanged, and `match_parity.sh` byte-identical | Open |
| **B** — a `paddling` profile, and portages. `way_penalty` gains the profile (prefer river/canal, avoid rapids per §12); lock/weir/dam become `TBarrier`s with a portage cost; read `canoe`/`boat` access into the free `flags` bits 12–15. | M | unit tests in `lib/routing_kernel/tests/` beside the nine existing profile tests; the barrier A/B in `tools/access_gate.sh` shape | Blocked on A |
| **C** — the activity selector gains paddling. Pure UI: the kernel already dispatches on the profile string. | S | `tools/app_headless_test.sh`; a CDP check that the route changes with the selector | Blocked on B |
| **D** — draw the navigable network as navigable. The base map already carries the geometry; this is a style decision, not new data. | S | `tools/map_render_gate.sh` — a canal draws at the zoom the router will use it | Blocked on A |
| **E** — decide stage 2/3. Cost a nautical overlay against premise 2, and open (or decline) the open-water plan. | S | a plan issue, or a `status:declined` with the reasoning | Blocked on C |

## Open questions

1. **Is `stream` navigable enough to carry?** 54 536 of the 78 566 are streams, and many are 2 m brooks.
   Phase A can carry them and let phase B's profile cost them down, or drop them by width/name. *Decided
   by A's conservation table* — carry first, because a dropped way cannot be costed later but a carried
   one can be penalised.
2. **Do waterways belong in the roads block, or a block of their own?** One block keeps the corridor
   read single and costs +2.8%; a separate one keeps land routing byte-identical by construction but
   doubles the read for a mixed sketch. *Decided by A*, and the negative control above is what makes the
   cheap answer safe to take.
3. **Should portage be a barrier or an edge cost?** §12 says "break the edge or add a cost node" and
   leaves it open. `TBarrier` exists and already lands on a graph node by coordinate. *Decided by B.*
4. **Does a paddling route need the tide?** Not on inland water, which is this plan's scope; §12 puts
   tides with stage 3. Named here so it is not rediscovered as a gap. *Out of scope.*

## Safety

`DESIGN.md` §12's caveat carries into anything this plan ships: **a crowd-sourced sketch is never a
substitute for official charts.** It binds phase E hardest — a nautical *overlay* is the feature most
likely to be mistaken for a chart, and must be labelled display-only.
