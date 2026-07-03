// routing — phone-first route planner.
//
// Step 1 (PLAN.md): the static shell. JS owns the pixels (DESIGN.md §2), and here that is just
// the Leaflet map on an OSM raster base. Rough points, length, and matching arrive in later steps.
//
// No framework, no build step: this file runs as-is in any browser (DESIGN.md §11).

"use strict";

// Default view. Vondelpark, Amsterdam — the running example throughout DESIGN.md — is a friendly
// place to land before anything better is known. Better, in order: the view you last left the
// map at (remembered in THIS browser below — zero UI), else the timezone-city locate (ws.js).
const DEFAULT_CENTER = [52.3579, 4.8686];
const DEFAULT_ZOOM = 14;

// The remembered view: saved on every moveend, applied at startup. Unobtrusive by construction —
// there is nothing to configure; the map simply opens where you last had it.
const VIEW_KEY = "routing.view";
let savedView = null;
try {
  const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
  if (v && Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isFinite(v.zoom)) savedView = v;
} catch (_) { /* private mode etc. — fall through to the default */ }

const map = L.map("map", {
  center: savedView ? [savedView.lat, savedView.lng] : DEFAULT_CENTER,
  zoom: savedView ? savedView.zoom : DEFAULT_ZOOM,
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

// Remember the view (see VIEW_KEY above). moveend also fires after programmatic moves — restore,
// locate, fitBounds — which is right: "where you last had it" includes where the app took you.
map.on("moveend", () => {
  const c = map.getCenter();
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
  } catch (_) {}
});

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
// Bridge overlay: the straight gap-crossings (where the corridor couldn't connect — usually a
// mis-placed point) drawn as a DOTTED line ON TOP of the solid route, so they read as "gap / fix your
// point" rather than a real road. Added after detailedLine so it paints above it.
const bridgeLine = L.polyline([], {
  pane: "detailed",
  interactive: false,
  color: "#e0562d",
  weight: 4,
  opacity: 0.95,
  dashArray: "1 8",   // round dots
  lineCap: "round",
  lineJoin: "round",
}).addTo(map);
routing.detailed = {
  // points: [{lat,lon}], lengthM: matched geodesic length, bridges: flat [a0,b0,a1,b1,…] gap-segment
  // endpoints. Draws the solid route, overlays the bridges dotted, and shows the length.
  set(points, lengthM, bridges) {
    detailedLine.setLatLngs(points.map((p) => [p.lat, p.lon]));
    const segs = [];
    if (bridges) {
      for (let i = 0; i + 1 < bridges.length; i += 2) {
        segs.push([[bridges[i].lat, bridges[i].lon], [bridges[i + 1].lat, bridges[i + 1].lon]]);
      }
    }
    bridgeLine.setLatLngs(segs);
    const el = document.getElementById("server-length");
    if (el) el.textContent = points.length > 0 ? "matched " + routing.geo.formatDistance(lengthM) : "matched —";
  },
  clear() { detailedLine.setLatLngs([]); bridgeLine.setLatLngs([]); },
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
// The goal is remembered PER ACTIVITY (browser-local, like the map view): a 10 km running goal
// and a 60 km cycling goal coexist, and switching activity recalls yours. controls.js calls
// applyGoalForActivity on every activity change (and at startup / profile restore).
const GOALS_KEY = "routing.goals";
let goals = {};
try { goals = JSON.parse(localStorage.getItem(GOALS_KEY) || "{}") || {}; } catch (_) {}
const activityOf = () => (routing.getProfile ? routing.getProfile().split("_")[0] : "walking");

const goalInput = document.getElementById("goal-km");
routing.applyGoalForActivity = () => {
  const km = goals[activityOf()];
  routing.goalMeters = Number.isFinite(km) && km > 0 ? km * 1000 : 0;
  if (goalInput) goalInput.value = routing.goalMeters ? String(km) : "";
  renderLength(routing.roughPoints || []);
};

if (goalInput) {
  goalInput.addEventListener("input", () => {
    const km = parseFloat(goalInput.value);
    routing.goalMeters = Number.isFinite(km) && km > 0 ? km * 1000 : 0;
    const act = activityOf();
    if (routing.goalMeters) goals[act] = km; else delete goals[act];
    try { localStorage.setItem(GOALS_KEY, JSON.stringify(goals)); } catch (_) {}
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

// The timezone-city locate applies only to a map with NO better information: no remembered view
// (that's the user's own preference), nothing sketched, and the view still on the untouched
// hardcoded default. ws.js consults needsLocate before even sending the request, so the geocode
// runs at most once per browser — the located view is then remembered like any other.
routing.needsLocate = () => {
  if (savedView) return false;
  if (routing.roughPoints && routing.roughPoints.length > 0) return false;
  if (map.getZoom() !== DEFAULT_ZOOM) return false;
  const c = map.getCenter();
  return Math.abs(c.lat - DEFAULT_CENTER[0]) < 1e-9 && Math.abs(c.lng - DEFAULT_CENTER[1]) < 1e-9;
};
routing.centerIfUntouched = (lat, lon) => {
  if (routing.needsLocate()) map.setView([lat, lon], 12);
};

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
