// routing — browser WebSocket client (PLAN steps 4 / 7 / 10 / 11). The thin-JS half of the
// server-first architecture (DESIGN.md §3/§4): send the rough points to the loft server, draw the
// matched route, export/import GPX. Plain browser WebSocket — no loft in the browser, no bridge.
//
// Wire (text frames "<id>:<payload>"):
//   4:<profile>|<points>  → 5:<length_m>|<matched points>   (match; drawn under the sketch)
//   6:<profile>|<points>  → 7:<gpx>                          (export the matched route)
//   8:<points>            → 9:<cleaned points>               (import: clean a raw GPX track — step 11)
// Re-match is debounced on edit-release — Overpass + matching is heavy (DESIGN.md §5).

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const WS_URL = `${proto}://${location.host || "localhost:18080"}/ws`;
  const MATCH_DEBOUNCE_MS = 700;

  let ws = null;
  let latest = null;   // most recent points; sent once connected / after debounce
  let debounce = null;

  const profileOf = () => (NS.getProfile ? NS.getProfile() : "walking_paved");
  const encode = (points) => points.map((p) => p.lat + "," + p.lon).join(";");
  const decode = (spec) =>
    spec
      ? spec.split(";").map((pair) => {
          const c = pair.split(",");
          return { lat: parseFloat(c[0]), lon: parseFloat(c[1]) };
        }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      : [];

  // "5:<length_m>|<matched points>" → the detailed layer.
  function applyMatched(raw) {
    const bar = raw.indexOf("|");
    const lengthM = parseFloat(raw.slice(raw.indexOf(":") + 1, bar)) || 0;
    if (NS.detailed) NS.detailed.set(decode(raw.slice(bar + 1)), lengthM);
  }

  function downloadGpx(gpx) {
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = "route.gpx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function flush() {
    if (!ws || ws.readyState !== WebSocket.OPEN || latest === null) return;
    if (latest.length < 2) { if (NS.detailed) NS.detailed.set([], 0); return; }
    ws.send("4:" + profileOf() + "|" + encode(latest));
  }

  function connect() {
    try { ws = new WebSocket(WS_URL); } catch (e) { return; }
    ws.addEventListener("open", flush);
    ws.addEventListener("message", (e) => {
      const raw = String(e.data);
      const id = raw.slice(0, raw.indexOf(":"));
      if (id === "5") applyMatched(raw);
      else if (id === "7") downloadGpx(raw.slice(2));
      else if (id === "9" && NS.rough && NS.rough.setPoints) NS.rough.setPoints(decode(raw.slice(2)));
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

  function requestExport(points) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !points || points.length < 2) return;
    ws.send("6:" + profileOf() + "|" + encode(points));
  }

  // Step 11: hand a raw GPX track to the server for cleaning → it replies "9:<cleaned points>".
  function requestImport(points) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !points || points.length < 2) return;
    ws.send("8:" + encode(points));
  }

  NS.ws = {
    sendPoints, requestExport, requestImport, connect,
    get connected() { return !!ws && ws.readyState === WebSocket.OPEN; },
  };
  connect();
})();
