// routing — browser WebSocket client (PLAN step 4). The thin-JS half of the server-first
// architecture (DESIGN.md §3/§4): send the rough points to the loft server, show the length it
// computes. Plain browser WebSocket — no loft in the browser, no bridge.
//
// Wire: send "1:lat,lon;lat,lon;..." ; receive "2:<length_m>". (Step 6 makes the reply the
// matched-route length; step 7 also returns the detailed polyline.)

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const URL = `${proto}://${location.host || "localhost:18080"}/ws`;
  const DEBOUNCE_MS = 150; // don't flood the socket mid-drag

  let ws = null;
  let latest = null;       // most recent points (sent once connected / after debounce)
  let sentAny = false;
  let debounce = null;

  const el = () => document.getElementById("server-length");
  function show(text) { const e = el(); if (e) e.textContent = text; }

  function flush() {
    if (!ws || ws.readyState !== WebSocket.OPEN || latest === null) return;
    const spec = latest.map((p) => p.lat + "," + p.lon).join(";");
    ws.send("1:" + spec);
    sentAny = true;
  }

  function connect() {
    try { ws = new WebSocket(URL); } catch (e) { show("server —"); return; }
    ws.addEventListener("open", () => { show("server ✓"); flush(); });
    ws.addEventListener("message", (e) => {
      const raw = String(e.data);
      const i = raw.indexOf(":");
      if (raw.slice(0, i) === "2") {
        const m = parseFloat(raw.slice(i + 1));
        show("server " + (NS.geo ? NS.geo.formatDistance(m) : m + " m"));
      }
    });
    ws.addEventListener("close", () => { show("server …"); setTimeout(connect, 1000); });
    ws.addEventListener("error", () => { try { ws.close(); } catch (_) {} });
  }

  // Called from app.js on every rough-layer change (debounced).
  function sendPoints(points) {
    latest = points;
    clearTimeout(debounce);
    debounce = setTimeout(flush, DEBOUNCE_MS);
  }

  NS.ws = { sendPoints, connect, get connected() { return !!ws && ws.readyState === WebSocket.OPEN; }, get sentAny() { return sentAny; } };
  connect();
})();
