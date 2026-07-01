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
  // drifts a few pixels still reads as a tap when placing points (step 2).
  tapTolerance: 20,
  worldCopyJump: true,
  // Double-click has route semantics here (delete a point / a deduped empty-map add), not zoom.
  doubleClickZoom: false,
});

// OSM raster base (DESIGN.md §7). {s} spreads tile requests across the subdomains OSM allows.
// maxZoom 19 is the deepest OSM serves. detectRetina gives phones crisp tiles on hi-dpi screens.
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  detectRetina: true,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// Shared namespace (rough.js also contributes to it). Keep a map handle for the console.
const routing = (window.routing = window.routing || {});
routing.map = map;

// Step 3: instant rough length (DESIGN.md §1) — a haversine sum, recomputed on every edit and
// every drag frame and shown in the top readout. Never waits; loft's accurate geodesic length of
// the *matched* route arrives later (step 7). Goal ±delta slots into this same readout in step 14.
const lengthReadout = document.getElementById("length-readout");
function renderLength(points) {
  if (lengthReadout) {
    lengthReadout.textContent = routing.geo.formatDistance(routing.geo.roughLength(points));
  }
}

// Step 2: the rough sketch layer (DESIGN.md §1). onChange fires on every edit and during a drag.
routing.rough = new routing.RoughLayer(map, {
  onChange: (points) => {
    routing.roughPoints = points;
    renderLength(points);
  },
});
renderLength([]); // initial "0 m"
