// routing — client-side geometry helpers (DESIGN.md §2: "JS does pixels", incl. the INSTANT
// rough length). The length is the WGS84 geodesic (Vincenty inverse) — the SAME algorithm as
// routing_kernel's geodesic_ll, so the instant JS number and the loft (matched) number agree.
// Still cheap enough to recompute every frame during a drag (a few iterations per segment).

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const A = 6378137.0;               // WGS84 semi-major axis (m)
  const F = 0.0033528106647474805;   // flattening, 1/298.257223563
  const B = 6356752.314245179;       // semi-minor axis, a·(1−f)
  const DEG = Math.PI / 180;

  // WGS84 geodesic distance between two {lat, lon} points, in metres (Vincenty inverse —
  // mirrors routing_kernel.geodesic_ll line for line).
  function geodesicMeters(p, q) {
    if (p.lat === q.lat && p.lon === q.lon) return 0;
    const ll = (q.lon - p.lon) * DEG;
    const u1 = Math.atan((1 - F) * Math.tan(p.lat * DEG));
    const u2 = Math.atan((1 - F) * Math.tan(q.lat * DEG));
    const su1 = Math.sin(u1), cu1 = Math.cos(u1);
    const su2 = Math.sin(u2), cu2 = Math.cos(u2);
    let lam = ll;
    let sins = 0, coss = 1, sigma = 0, cos2a = 0, cos2sm = 0;
    for (let it = 0; it < 20; it++) {
      const sl = Math.sin(lam), cl = Math.cos(lam);
      sins = Math.sqrt((cu2 * sl) * (cu2 * sl) + (cu1 * su2 - su1 * cu2 * cl) * (cu1 * su2 - su1 * cu2 * cl));
      if (sins === 0) return 0;   // coincident on the auxiliary sphere
      coss = su1 * su2 + cu1 * cu2 * cl;
      sigma = Math.atan2(sins, coss);
      const sina = cu1 * cu2 * sl / sins;
      cos2a = 1 - sina * sina;
      cos2sm = cos2a !== 0 ? coss - 2 * su1 * su2 / cos2a : 0;   // 0 along the equator
      const cc = F / 16 * cos2a * (4 + F * (4 - 3 * cos2a));
      const prev = lam;
      lam = ll + (1 - cc) * F * sina
              * (sigma + cc * sins * (cos2sm + cc * coss * (-1 + 2 * cos2sm * cos2sm)));
      if (Math.abs(lam - prev) < 1e-12) break;
    }
    const usq = cos2a * (A * A - B * B) / (B * B);
    const aa = 1 + usq / 16384 * (4096 + usq * (-768 + usq * (320 - 175 * usq)));
    const bb = usq / 1024 * (256 + usq * (-128 + usq * (74 - 47 * usq)));
    const dsig = bb * sins * (cos2sm + bb / 4 * (coss * (-1 + 2 * cos2sm * cos2sm)
               - bb / 6 * cos2sm * (-3 + 4 * sins * sins) * (-3 + 4 * cos2sm * cos2sm)));
    return B * aa * (sigma - dsig);
  }

  // Summed geodesic over consecutive rough points — the roughLengthMeters of DESIGN.md §9.
  // 0 for fewer than two points.
  function roughLength(points) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) {
      sum += geodesicMeters(points[i - 1], points[i]);
    }
    return sum;
  }

  // Compact human readout: whole metres under 1 km, else kilometres to 2 decimals.
  function formatDistance(m) {
    if (!(m > 0)) return "0 m";
    if (m < 1000) return Math.round(m) + " m";
    return (m / 1000).toFixed(2) + " km";
  }

  NS.geo = { geodesicMeters, roughLength, formatDistance };
})();
