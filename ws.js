// routing — browser WebSocket client (PLAN steps 4 + 7). The thin-JS half of the server-first
// architecture (DESIGN.md §3/§4): send the rough points to the loft server on edit-release, and draw
// the matched route it computes. Plain browser WebSocket — no loft in the browser, no bridge.
//
// Wire: send "4:lat,lon;lat,lon;..." (a match request); receive "5:<length_m>|<lat,lon;lat,lon;...>"
// (the matched route + its geodesic length). Re-match is debounced on edit-release — Overpass +
// matching is heavy, so we don't fire mid-drag (DESIGN.md §5).

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const URL = `${proto}://${location.host || "localhost:18080"}/ws`;
  const MATCH_DEBOUNCE_MS = 700;

  let ws = null;
  let latest = null;   // most recent points; sent once connected / after debounce
  let debounce = null;

  // Parse "5:<length_m>|<lat,lon;lat,lon;...>" and hand it to the detailed layer.
  function applyMatched(raw) {
    const bar = raw.indexOf("|");
    const head = raw.slice(0, bar);
    const lengthM = parseFloat(head.slice(head.indexOf(":") + 1)) || 0;
    const spec = raw.slice(bar + 1);
    const points = spec
      ? spec.split(";").map((pair) => {
          const c = pair.split(",");
          return { lat: parseFloat(c[0]), lon: parseFloat(c[1]) };
        }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      : [];
    if (NS.detailed) NS.detailed.set(points, lengthM);
  }

  function flush() {
    if (!ws || ws.readyState !== WebSocket.OPEN || latest === null) return;
    if (latest.length < 2) { if (NS.detailed) NS.detailed.set([], 0); return; }
    const profile = NS.getProfile ? NS.getProfile() : "walking_paved";
    ws.send("4:" + profile + "|" + latest.map((p) => p.lat + "," + p.lon).join(";"));
  }

  function connect() {
    try { ws = new WebSocket(URL); } catch (e) { return; }
    ws.addEventListener("open", flush);
    ws.addEventListener("message", (e) => {
      const raw = String(e.data);
      if (raw.slice(0, raw.indexOf(":")) === "5") applyMatched(raw);
    });
    ws.addEventListener("close", () => setTimeout(connect, 1000));
    ws.addEventListener("error", () => { try { ws.close(); } catch (_) {} });
  }

  // Called from app.js on every rough-layer change (debounced — re-match on edit-release).
  function sendPoints(points) {
    latest = points;
    clearTimeout(debounce);
    debounce = setTimeout(flush, MATCH_DEBOUNCE_MS);
  }

  NS.ws = { sendPoints, connect, get connected() { return !!ws && ws.readyState === WebSocket.OPEN; } };
  connect();
})();
