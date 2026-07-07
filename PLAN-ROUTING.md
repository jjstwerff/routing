# PLAN-ROUTING — get-me-there (point-to-point), a reserved fork

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

1. **Data:** populate `h`; add `speed` (class-default table, then `maxspeed`); encode `oneway`.
2. **Regional A\*:** time-metric least-cost over the mode-filtered network; bike cost model using cycle
   infra + surface + gradient; attach the climb profile to the result (reuse the elevation dock).
3. **Cross-region speed:** the highway-layer top-index, then full CH per stable metric if needed.
4. **Transit:** availability-aware routing over scheduled lines (own design).

Related: **PLAN-MATCH** (the sketch-faithful family and the mode×intent fork, §9); **PLAN-TILES** (tile
format — where `h`, `speed`, `oneway`, and the hierarchy/top-index layer live); **DESIGN §7** (elevation).
