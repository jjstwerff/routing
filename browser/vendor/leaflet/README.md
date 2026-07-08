<!-- SPDX-License-Identifier: BSD-2-Clause -->
# Vendored: Leaflet 1.9.4

Interactive map library used for the app's base map (OSM raster tiles) and for drawing the road
network, sketch, and matched route as vector overlays.

- **Version:** 1.9.4
- **Source:** https://unpkg.com/leaflet@1.9.4/dist/ (`leaflet.js`, `leaflet.css`)
- **Upstream:** https://leafletjs.com/ · https://github.com/Leaflet/Leaflet
- **License:** BSD-2-Clause — © 2010–2023 Volodymyr Agafonkin, © 2010–2011 CloudMade
  (the copyright header is preserved at the top of `leaflet.js`).

Vendored (rather than loaded from a CDN) so the app is served from a single origin, works offline via
the service-worker cache, and can be inlined into the single-file `standalone.html`
(`browser/build-standalone.mjs`). The default marker/layers-control images are **not** vendored — the app
uses vector `circleMarker`s and no image-based controls, so those CSS image references are unused.

To update: re-download both files from the unpkg URL above at the new version and update this note.
