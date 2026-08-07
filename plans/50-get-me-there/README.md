<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# 50 — Get-me-there: point-to-point routing over our own data

**Kind:** plan · **Status:** current · **Last verified:** 2026-08-03 · **Owns:** issue #50 — point-to-point routing over our own data

**Issue:** [`jjstwerff/routing#50`](https://github.com/jjstwerff/routing/issues/50) ·
**Value:** `G` · **Effort:** `H`

*Promoted from the root-level `PLAN-ROUTING.md` on 2026-08-03. The design below is unchanged — it was a
reservation, and it is still the design of record. What is new is the Status / Goal / Data cost /
Invariant gate / Phases the plan convention requires, and the reason this stopped being hypothetical.*

## Status

**Nothing is built, and that was correct until today.** This was written as a stub so the tile format
and architecture would *reserve room* for the fork — explicitly "not a roadmap commitment". Its own
phase 1 is *"populate `h`; add `speed`; encode `oneway`"*, and **two of those three shipped on
2026-08-03**: heights (PLAN-RESTORE R2) and direction (PLAN-SCALE §9 item 7). What remains of that phase
is a `tp`→default-speed table, which the analysis below costs at "~free".

So the reservation has become a plan: the data the differentiators need is in the block, and the thing
standing between here and a bike router that respects gradient is code, not a regeneration.

⚠ **The published blocks carry `h` and `oneway` only from the 2026-08-03 regeneration onward.** Phase A
must not assume a block has them — `oneway_tags` on a zeroed field reads "no restriction", and `h == 0`
is indistinguishable from sea level. A block predating that dataset routes as it always did, which is
right, but a gradient cost computed over it is silently flat. See the negative control below.

## Goal

You set two points and get the network's own best path for your activity — with gradient and cycle
infrastructure costed, and the climb profile shown beside it — rather than a shape you traced.

## Anchors

| what | where |
|---|---|
| the fork itself, and why the deciding numbers flip | `PLAN-MATCH.md` §9 |
| the sketch-faithful family this is NOT | `PLAN-MATCH.md`, `DESIGN.md` §1/§5 |
| the profiles and cost model it reuses | `DESIGN.md` §6, `lib/routing_kernel` `way_penalty` |
| what `h` cost and how it got there | `PLAN-RESTORE.md` R2, `tools/bake-heights.sh` |
| where `speed` / a hierarchy layer would live | `PLAN-TILES.md` |

Source it touches: `lib/routing_kernel` (`way_penalty`, `dijkstra_win`, a new entry point beside
`match_route`), `lib/map_kernel` (a command), `browser/store-app.mjs` (two points, not a sketch).

## Data cost

**Phase A has none.** A `tp`→default-speed table is code, not a field; `h` and `oneway` are already in
the block as of `v2026-08-03`. That is the whole reason this plan is worth opening now rather than after
another regeneration.

Later phases do: **`maxspeed`** wants a field (the class-default table is the cheap approximation, and
the doc says so), and **turn restrictions** are OSM *relations* — a per-junction table nothing in the
pipeline captures today. Both are additive to `TRoad`/`TTile` and therefore **schema changes**
(loft#700: older blocks would read garbage, not empty), so each costs a regeneration of every block plus
a copier audit. Neither is in phase A deliberately.

## Invariant gate

| phase | expected result | invariant | negative control |
|---|---|---|---|
| **A** | a two-point query returns the network's least-time path | it is a *different family*, not a reshaped sketch | **`tools/match_parity.sh` byte-identical**: adding an entry point beside `match_route` must not move one sketch route |
| **B** | the same query over a climbed corridor picks the flatter legal path | gradient is a *cost*, not a filter | a **flat** corridor must return the byte-identical route with the gradient term on and off — otherwise the term is charging for something else |
| **B** | — | — | ⚠ a block with `h == 0` everywhere (pre-`v2026-08-03`) must produce the *ungraded* route and **say so**, not a confidently flat one |
| **C** | the climb profile drawn beside the route matches `elev_profile` over the same points | the profile reads the block, never the network | a route whose block has no heights draws **no** profile rather than a flat line |

## Phases

| Phase | Effort | Verify | Status |
|---|---|---|---|
| **A** — regional A\* with a time metric. `tp`→speed table; a `route_to` entry point beside `match_route`; two-point UI. | MH | `match_parity.sh` unchanged; a corpus of point pairs with hand-checked answers | Open |
| **B** — the differentiators: gradient in the bike cost model, cycle infra + surface already there. | M | A/B over the 26-sketch corpus, per profile, `0 worse` — the `network_gate.sh` shape | Blocked on A |
| **C** — the climb profile, drawn. Reuses `elev_profile`; the app has no elevation dock since the rewrite (`PLAN-RESTORE` §1 lists it as lost). | M | a CDP check that the profile matches the kernel's own numbers | Blocked on B |
| **D** — cross-region speed, only if measured to be needed. | H | a NL→Alps query inside a stated budget | Blocked on A |
| **E** — transit, own design. | VH | — | Not scheduled |

## Open questions

1. **Does regional A\* actually need a hierarchy?** The analysis below says no for a country block and
   yes for NL→Alps. *Decided by A's measurement*, not before — build plain A\* first.
2. **Where does the speed table live — kernel constant or block field?** Constant first (free, and
   revisable without a regeneration); `maxspeed` later if the corpus shows the defaults are wrong.
   *Decided by A.*

---

*What follows is the original reservation, unchanged. It is the design this plan implements.*

## The reservation (design of record)

The **sketch-faithful** matcher (PLAN-MATCH) is the core product. This is the *other* family from
PLAN-MATCH §9: **"just get me there"** — the user sets endpoints and wants the network's own best path,
not a traced shape. Least-cost routing over the whole mode-filtered network; **time/distance is the
objective** (the number PLAN-MATCH bars). Lower priority than the sketch families, and a **separate
algorithm** — this doc is a stub so the tile format and architecture *reserve room* for it, not a
roadmap commitment.

## Priority & where we differ (recap of PLAN-MATCH §9)

Plain fastest-car is a commodity (Google Maps does it well); we don't invest there. Our **rich tile
data** differentiates the rest:

- **Bike get-me-there** — Google Maps' is notoriously poor. A router that respects cycle
  infrastructure, surface, and **gradient** over our own network is a real edge.
- **Elevation-aware car routing + climb profile** — an Alp crossing shown *with its height profile*
  (data we already compute for the elevation dock, DESIGN §7), and gradient as a route-*choice* input,
  not just a display.
- **Transit** — a rough "does-it-fit-in-a-day" estimate over scheduled lines with availability
  (which run today, not exact times; PLAN-TILES day-plan), never a minute-accurate itinerary.

## Data this family needs beyond today's tiles

Today's `TRoad` carries `tp` (road class) / `flags` / `steps`. Point-to-point routing additionally
needs:

| need | for | status | cost to add |
|---|---|---|---|
| **edge speed / travel time** | any time metric | missing | ~free: a `tp`→default-speed table; better with OSM `maxspeed` |
| **elevation `h` populated** | bike gradient, car climb profile (**the differentiators**) | field exists on `TStep`, currently **0** | fill from the terrarium DEM already fetched for the dock |
| **oneway** | car correctness | in the `Way` model, not encoded in tiles | one `flags` bit |
| **turn restrictions** | car legality | not captured (OSM relations) | small per-junction table — later |

The biggest gap for the *differentiated* cases is **populating `h`**: bike-gradient and Alp-climb both
depend on it, and everything else those cases need (cycle infra, surface) is already in the tiles.

## Encoding "fast known routes" for speed — a route hierarchy

Envisioned: encode fast long-distance routes so the algorithm doesn't re-derive them. This is the
standard fast-routing technique — **Contraction Hierarchies / shortcut edges / transit-node routing** —
and the instinct is architecturally sound.

- **How it works:** precompute **shortcut edges** spanning long fast corridors (motorway/arterial),
  tagged with a hierarchy level. A query expands only the *sparse* high level for the long middle and
  the dense local net near the endpoints — turning a whole-network Dijkstra into near-constant work for
  long routes.
- **Caveats:**
  - **Metric-specific.** A car-fastest hierarchy ≠ bike ≠ scenic. Precompute one per *stable* metric
    (car-fastest, maybe bike-fastest); personalized/scenic costs can't ride a fixed CH (they'd need
    customizable-CH / arc-flags — more complex, defer).
  - **Crosses tile boundaries.** A shortcut spans many cells, so it can't live in a single local tile.
    It wants its own layer — which maps naturally onto PLAN-TILES' deferred **top-index**: a coarse
    "highway layer" above the detailed local tiles (local tile → nearest highway-layer access node →
    sparse highway layer → local tile at the destination; transit-node-routing-flavored).
  - **Storage/preprocessing.** CH roughly doubles edge count and needs a contraction pass at tile
    generation.

## Do we need it? Reserve, don't build

- **Regional routing: no.** For a country-split block (≤0.5 GB), plain **A\* with a time metric over the
  full network is fast enough** — the graph is bounded, comparable to the sub-second corridor searches
  the sketch matcher already runs.
- **Long cross-region routing: yes** — the Netherlands→Alps case. Whole-network Dijkstra expansion
  explodes over thousands of km; that's where the hierarchy earns its keep.
- **Decision:** build **plain A\* per region first** when this family is picked up; **reserve** a
  hierarchy/shortcut layer + `speed` + `h` + `oneway` in the tile format now (PLAN-TILES) so it can be
  added without reformatting. A lighter first step than full CH: encode just the **motorway/trunk
  network as a coarse top-level graph** in the top-index (the highway-layer above) — most of the
  long-haul win, far less preprocessing.

## Phasing (when this fork is picked up)

1. **Data:** ~~populate `h`~~ ✅ 2026-08-03 (R2) · add `speed` (class-default table, then `maxspeed`) ·
   ~~encode `oneway`~~ ✅ 2026-08-03 (bits 8–11). **Two of three done** — see Status above; only the
   speed table is left, and it is code rather than a field.
2. **Regional A\*:** time-metric least-cost over the mode-filtered network; bike cost model using cycle
   infra + surface + gradient; attach the climb profile to the result (reuse the elevation dock).
3. **Cross-region speed:** the highway-layer top-index, then full CH per stable metric if needed.
4. **Transit:** availability-aware routing over scheduled lines (own design).

Related: **PLAN-MATCH** (the sketch-faithful family and the mode×intent fork, §9); **PLAN-TILES** (tile
format — where `h`, `speed`, `oneway`, and the hierarchy/top-index layer live); **DESIGN §7** (elevation).
