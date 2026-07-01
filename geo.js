// routing — client-side geometry helpers (DESIGN.md §2: "JS does pixels", incl. the INSTANT
// rough length via haversine). loft owns the *accurate geodesic* (ellipsoidal) length of the
// matched detailed route later (step 7); this is the fast, every-frame rough number.

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const R = 6371008.8;        // mean Earth radius (m), IUGG — spherical haversine
  const DEG = Math.PI / 180;

  // Great-circle distance between two {lat, lon} points, in metres.
  function haversineMeters(a, b) {
    const dLat = (b.lat - a.lat) * DEG;
    const dLon = (b.lon - a.lon) * DEG;
    const s1 = Math.sin(dLat / 2);
    const s2 = Math.sin(dLon / 2);
    const h = s1 * s1 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Summed haversine over consecutive rough points — the roughLengthMeters of DESIGN.md §9.
  // 0 for fewer than two points. Cheap enough to recompute every frame during a drag.
  function roughLength(points) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) {
      sum += haversineMeters(points[i - 1], points[i]);
    }
    return sum;
  }

  // Compact human readout: whole metres under 1 km, else kilometres to 2 decimals.
  function formatDistance(m) {
    if (!(m > 0)) return "0 m";
    if (m < 1000) return Math.round(m) + " m";
    return (m / 1000).toFixed(2) + " km";
  }

  NS.geo = { haversineMeters, roughLength, formatDistance };
})();
