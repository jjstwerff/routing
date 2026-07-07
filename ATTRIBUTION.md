# Attribution & data sources

This project builds on open data and open tooling. Credit is required for the
data sources below wherever the app or its data is used or displayed.

## OpenStreetMap — map, routing data, trails

The base map, the routing network (the tile blocks the matcher runs on), and
curated foot/cycle route membership all derive from **OpenStreetMap**.

> © OpenStreetMap contributors — data licensed under the Open Database License
> (ODbL) v1.0 · https://openstreetmap.org/copyright · https://opendatacommons.org/licenses/odbl/1-0/

The generated tile blocks (`*.tiles`) are a **derivative database** under ODbL —
see [`LICENSE.data`](LICENSE.data). This credit is shown **in the app** (the map
attribution control) and must remain visible in any deployment.

## Elevation / terrain

Baked heights (`h`) are sampled from **Terrarium** terrain tiles (Tilezen /
Mapzen lineage), themselves a composite of open sources including **SRTM**, the
USGS **NED/3DEP**, and other national/open elevation data.

> Terrain: Tilezen/Terrarium and its sources (SRTM, USGS, et al.)

## Base-map raster tiles

- **OpenStreetMap** standard tiles — © OpenStreetMap contributors.
- **CyclOSM** (MTB sub-mode) — © CyclOSM, © OpenStreetMap contributors.
- **Waymarkedtrails** overlay — © Waymarkedtrails (data © OpenStreetMap contributors).

## Software

- **[loft](https://github.com/loft-lang/loft)** — the language/toolchain
  (LGPL-3.0-or-later); the vendored `lib/{web,server,imaging}` libraries are from
  loft-libs (LGPL-3.0-or-later) and keep their own headers.
- **[Leaflet](https://leafletjs.com/)** — map rendering (BSD-2-Clause), vendored
  under `vendor/`.

## This project

- Code: **LGPL-3.0-or-later** ([`LICENSE`](LICENSE)).
- Data: **ODbL-1.0** ([`LICENSE.data`](LICENSE.data)).
