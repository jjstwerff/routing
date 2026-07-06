// routing — device location (OPT-IN) + the follow-me lock, in the current non-rotating form.
// The "◎" button cycles OFF → SHOW → FOLLOW → OFF:
//   • SHOW:   dot + accuracy circle; the map pans only when the DEVICE moves out of the view.
//   • FOLLOW: the map stays centred on the device; any manual drag drops back to SHOW (never
//     fight the user — §1). With a matched route present, a PROGRESS-ANCHORED projection drives
//     the done/left readout: each fix projects into a window around the expected progress, so
//     the WALKED part outranks the planned line (a loop crossing can't flicker you backward),
//     and a fix >40 m off the route freezes progress ("off route") instead of guessing.
// The browser permission prompt fires only on the user's first click, never at load: a
// remembered opt-in resumes as SHOW (never auto-follow) and only when already granted.

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const KEY = "routing.gps";
  const MOVE_MIN_M = 25;      // "the device moved" — GPS jitter must not count
  const OFF_ROUTE_M = 40;     // beyond this, progress freezes rather than guesses
  const BACK_SLACK_M = 100;   // a short backtrack stays anchored
  const AHEAD_SLACK_M = 200;  // look a little further than the distance actually moved
  const DEG = Math.PI / 180;

  const toggle = document.getElementById("gps-toggle");
  const readout = document.getElementById("follow-readout");
  let mode = 0;               // 0 off · 1 show · 2 follow
  let watchId = null;
  let marker = null;
  let circle = null;
  let lastFix = null;

  // --- progress-anchored projection onto the matched route --------------------------------

  let routeRef = null;        // identity of NS.matchedPoints the cache was built for
  let cum = null;             // cumulative metres at each route vertex
  let progress = -1;          // committed metres along the route (-1 = not acquired)

  function ensureRoute() {
    const pts = NS.matchedPoints || [];
    if (pts.length < 2) { routeRef = null; return null; }
    if (routeRef !== pts) {
      routeRef = pts;
      cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + NS.geo.geodesicMeters(pts[i - 1], pts[i]));
      progress = -1;          // a new route → re-acquire from scratch
    }
    return pts;
  }

  // Nearest point on segment a-b to p, in a local planar frame; {off metres, t along a-b}.
  function segProject(p, a, b) {
    const kx = 111320 * Math.cos(p.lat * DEG);
    const ky = 111320;
    const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
    const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? -(ax * dx + ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { off: Math.hypot(ax + t * dx, ay + t * dy), t };
  }

  // The fix's progress along the route — searched only inside the walked-anchored window.
  function updateProgress(fix, movedM) {
    const pts = ensureRoute();
    if (!pts) return null;
    const total = cum[cum.length - 1];
    const lo = progress < 0 ? 0 : Math.max(0, progress - BACK_SLACK_M);
    const hi = progress < 0 ? total : Math.min(total, progress + movedM + AHEAD_SLACK_M);
    let best = null;
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] < lo) continue;
      if (cum[i - 1] > hi) break;
      const pr = segProject(fix, pts[i - 1], pts[i]);
      if (!best || pr.off < best.off) best = { off: pr.off, d: cum[i - 1] + (cum[i] - cum[i - 1]) * pr.t };
    }
    if (!best) return null;
    if (best.off > OFF_ROUTE_M) return { off: true };
    progress = best.d;
    return { doneM: best.d, leftM: Math.max(0, total - best.d) };
  }

  function renderFollow(p) {
    if (!readout) return;
    if (mode !== 2) { readout.classList.add("hidden"); return; }
    readout.classList.remove("hidden");
    if (!p) { readout.textContent = "▶ no matched route"; return; }
    if (p.off) { readout.textContent = "▶ off route"; return; }
    readout.textContent = "▶ " + NS.geo.formatDistance(p.doneM) + " done · "
                        + NS.geo.formatDistance(p.leftM) + " left";
  }

  // --- the dot ------------------------------------------------------------------------------

  function draw(lat, lon, acc) {
    if (!marker) {
      marker = L.marker([lat, lon], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "gps-wrap",
          html: '<span class="gps-dot"></span>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      }).addTo(NS.map);
      circle = L.circle([lat, lon], {
        radius: acc || 0,
        interactive: false,
        weight: 1,
        color: "#1a73e8",
        opacity: 0.4,
        fillColor: "#1a73e8",
        fillOpacity: 0.08,
      }).addTo(NS.map);
    } else {
      marker.setLatLng([lat, lon]);
      circle.setLatLng([lat, lon]);
      circle.setRadius(acc || 0);
    }
  }

  function onFix(pos) {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const fix = { lat, lon };
    draw(lat, lon, pos.coords.accuracy);
    const movedM = lastFix ? NS.geo.geodesicMeters(lastFix, fix) : Infinity;
    const moved = movedM > MOVE_MIN_M;
    if (mode === 2) {
      if (moved) {
        NS.map.panTo([lat, lon]);
        renderFollow(updateProgress(fix, Number.isFinite(movedM) ? movedM : 0));
      }
    } else if (moved && !NS.map.getBounds().contains([lat, lon])) {
      NS.map.panTo([lat, lon]);   // SHOW mode: only when the device leaves the view
    }
    if (moved) lastFix = fix;
  }

  function onError(err) {
    if (err && err.code === 1) setMode(0);   // denied — off; timeouts just retry
  }

  // --- modes ---------------------------------------------------------------------------------

  function setMode(m) {
    mode = m;
    if (m === 0) {
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      if (marker) { NS.map.removeLayer(marker); NS.map.removeLayer(circle); marker = null; circle = null; }
      lastFix = null;
      progress = -1;
      try { localStorage.setItem(KEY, ""); } catch (_) {}
    } else {
      if (watchId === null && navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(onFix, onError, {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 20000,
        });
      }
      try { localStorage.setItem(KEY, "1"); } catch (_) {}
    }
    if (toggle) {
      toggle.classList.toggle("is-active", m === 1);
      toggle.classList.toggle("is-follow", m === 2);
    }
    if (m === 2 && lastFix) {
      NS.map.panTo([lastFix.lat, lastFix.lon]);
      renderFollow(updateProgress(lastFix, 0));
    } else {
      renderFollow(null);
    }
  }

  if (toggle) toggle.addEventListener("click", () => setMode((mode + 1) % 3));

  // A manual drag while following = the user wants the map — drop the lock, keep the dot (§1).
  if (NS.map) NS.map.on("dragstart", () => { if (mode === 2) setMode(1); });

  // Resume a remembered opt-in ONLY when permission is already granted — and always as SHOW,
  // never auto-follow: a map that recentres itself at load would be a surprise.
  try {
    if (localStorage.getItem(KEY) === "1" && navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: "geolocation" }).then((st) => {
        if (st.state === "granted") setMode(1);
      });
    }
  } catch (_) {}

  NS.gps = { setMode, get mode() { return mode; } };
})();
