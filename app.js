// routing — phone-first route planner.
//
// Step 1 (PLAN.md): the static shell. JS owns the pixels (DESIGN.md §2), and here that is just
// the Leaflet map on an OSM raster base. Rough points, length, and matching arrive in later steps.
//
// No framework, no build step: this file runs as-is in any browser (DESIGN.md §11).

"use strict";

// Default view. Vondelpark, Amsterdam — the running example throughout DESIGN.md — is a friendly
// place to land before geolocation exists. Later steps can center on the user or a loaded route.
const DEFAULT_CENTER = [52.3579, 4.8686];
const DEFAULT_ZOOM = 14;

const map = L.map("map", {
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  zoomControl: true,
  // Phone-first: keep momentum panning, but tap-tolerance a touch higher so a fingertip that
  // drifts a few pixels still reads as a tap (matters once we place points in step 2).
  tapTolerance: 20,
  worldCopyJump: true,
});

// OSM raster base (DESIGN.md §7). {s} spreads tile requests across the subdomains OSM allows.
// maxZoom 19 is the deepest OSM serves. detectRetina gives phones crisp tiles on hi-dpi screens.
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  detectRetina: true,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// Keep a handle around for the console and for later steps to build on.
window.routing = { map };
