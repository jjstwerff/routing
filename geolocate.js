// routing — device location (OPT-IN). The "◎" button starts watching the GPS: the fix is drawn
// as a dot + accuracy circle, and the map pans ONLY when the DEVICE moves out of the current
// view — never over a user who is just browsing elsewhere (a stationary fix outside the view is
// left alone). The browser's permission prompt fires only on the user's click, never at load:
// a remembered opt-in resumes on later visits ONLY when the Permissions API already says
// "granted". (Richer follow-me modes can build on this later.)

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const KEY = "routing.gps";
  const MOVE_MIN_M = 25;   // "the device moved" threshold — GPS jitter must not count

  const toggle = document.getElementById("gps-toggle");
  let watchId = null;
  let marker = null;
  let circle = null;
  let lastFix = null;

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
    draw(lat, lon, pos.coords.accuracy);
    const moved = !lastFix || NS.geo.geodesicMeters(lastFix, { lat, lon }) > MOVE_MIN_M;
    if (moved) {
      if (!NS.map.getBounds().contains([lat, lon])) NS.map.panTo([lat, lon]);
      lastFix = { lat, lon };
    }
  }

  function onError(err) {
    if (err && err.code === 1) stop();   // denied — flip the toggle back off; timeouts just retry
  }

  function start() {
    if (watchId !== null || !navigator.geolocation || !toggle) return;
    watchId = navigator.geolocation.watchPosition(onFix, onError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 20000,
    });
    toggle.classList.add("is-active");
    try { localStorage.setItem(KEY, "1"); } catch (_) {}
  }

  function stop() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (marker) {
      NS.map.removeLayer(marker);
      NS.map.removeLayer(circle);
      marker = null;
      circle = null;
    }
    lastFix = null;
    if (toggle) toggle.classList.remove("is-active");
    try { localStorage.setItem(KEY, ""); } catch (_) {}
  }

  if (toggle) toggle.addEventListener("click", () => (watchId === null ? start() : stop()));

  // Resume a remembered opt-in ONLY when the browser already granted permission — a fresh or
  // undecided browser gets no prompt until the user clicks.
  try {
    if (localStorage.getItem(KEY) === "1" && navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: "geolocation" }).then((st) => {
        if (st.state === "granted") start();
      });
    }
  } catch (_) {}

  NS.gps = { start, stop };
})();
