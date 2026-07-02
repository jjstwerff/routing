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
  // Shift+drag has select semantics here (box select — see rough.js), not zoom.
  boxZoom: false,
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

// Step 7: the detailed (matched) layer — the server's map-matched route, drawn UNDER the rough
// sketch and READ-ONLY (DESIGN.md §1: correct a wrong match by moving the rough points, never the
// line). A dedicated low-z pane keeps it beneath the rough dashed line and markers.
map.createPane("detailed");
map.getPane("detailed").style.zIndex = 350; // < overlayPane (~400, rough line) and markerPane (~600)
const detailedLine = L.polyline([], {
  pane: "detailed",
  interactive: false, // read-only — not draggable, doesn't eat taps
  color: "#e0562d",
  weight: 5,
  opacity: 0.85,
  lineCap: "round",
  lineJoin: "round",
}).addTo(map);
routing.detailed = {
  // points: [{lat,lon}], lengthM: matched geodesic length. Draws the line + shows the length.
  set(points, lengthM) {
    detailedLine.setLatLngs(points.map((p) => [p.lat, p.lon]));
    const el = document.getElementById("server-length");
    if (el) el.textContent = points.length > 0 ? "matched " + routing.geo.formatDistance(lengthM) : "matched —";
  },
  clear() { detailedLine.setLatLngs([]); },
};

// Step 3: instant rough length (DESIGN.md §1) — a WGS84-geodesic sum, recomputed on every edit and
// every drag frame and shown in the top readout. Never waits; loft's accurate geodesic length of
// the *matched* route arrives later (step 7). Goal ±delta slots into this same readout in step 14.
// Step 14: optional goal length — feedback ONLY. When set, the readout shows the live ±delta; the
// app never reshapes the route to hit it (DESIGN.md §1 — you remain the only actuator).
const lengthReadout = document.getElementById("length-readout");
function renderLength(points) {
  if (!lengthReadout) return;
  const m = routing.geo.roughLength(points);
  let text = routing.geo.formatDistance(m);
  const goal = routing.goalMeters;
  if (goal && goal > 0) {
    const delta = m - goal;
    const sign = delta >= 0 ? "+" : "−";
    text += ` (${sign}${routing.geo.formatDistance(Math.abs(delta))})`;
  }
  lengthReadout.textContent = text;
}
const goalInput = document.getElementById("goal-km");
if (goalInput) {
  goalInput.addEventListener("input", () => {
    const km = parseFloat(goalInput.value);
    routing.goalMeters = Number.isFinite(km) && km > 0 ? km * 1000 : 0;
    renderLength(routing.roughPoints || []); // re-render feedback only; the route is untouched
  });
}

// Step 2: the rough sketch layer (DESIGN.md §1). onChange fires on every edit and during a drag.
routing.rough = new routing.RoughLayer(map, {
  onChange: (points, committed) => {
    routing.roughPoints = points;
    renderLength(points);
    if (committed && routing.undo) routing.undo.record(points); // step 13: undo history — BEFORE the
                                                                // persist, so the draft save carries it
    if (routing.ws) routing.ws.sendPoints(points, committed); // step 4 round-trip; step 20 persists committed edits instantly
  },
});
renderLength([]); // initial "0 m"

// A small shared toast (auto-hiding, same chrome as the undo snackbar) — e.g. the GPX-import
// retrace notice. One at a time; a new message replaces the current one.
let toastEl = null;
let toastTimer = null;
routing.toast = (msg) => {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "snackbar hidden";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 6000);
};
