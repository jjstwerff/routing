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
  let remoteApply = false;   // step 19: applying a peer's edit — don't echo it back

  const profileOf = () => (NS.getProfile ? NS.getProfile() : "walking_paved");
  const encode = (points) => points.map((p) => p.lat + "," + p.lon).join(";");
  const decode = (spec) =>
    spec
      ? spec.split(";").map((pair) => {
          const c = pair.split(",");
          return { lat: parseFloat(c[0]), lon: parseFloat(c[1]) };
        }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      : [];

  // "5:<length_m>|<matched points>|<bridge segments>" → the detailed layer (+ elevation, lag-tolerant).
  // bridge segments are endpoint pairs of straight gap-crossings, drawn dotted so they don't look like
  // a road (see detailed.set).
  function applyMatched(raw) {
    const parts = raw.slice(raw.indexOf(":") + 1).split("|");
    const lengthM = parseFloat(parts[0]) || 0;
    const pts = decode(parts[1] || "");
    const bridges = decode(parts[2] || "");
    if (NS.detailed) NS.detailed.set(pts, lengthM, bridges);
    if (NS.elevation) NS.elevation.onMatched(pts);
  }

  // Step 19 — "23:<name>|<profile>|<rough>|<len>|<matched>": a peer edited the shared route we're
  // on. Apply it directly — the broadcast carries the server's match, so nothing is re-requested
  // and nothing echoes (rough.setPoints fires onChange → sendPoints, gated by remoteApply).
  function applyRemoteSync(raw) {
    const p = raw.slice(raw.indexOf(":") + 1).split("|");
    if (p.length < 5) return;
    const profile = p[1];
    const rough = decode(p[2]);
    const lengthM = parseFloat(p[3]) || 0;
    const matched = decode(p[4]);
    const bridges = decode(p[5] || "");
    if (rough.length < 2) return;
    remoteApply = true;
    try {
      if (NS.setProfile) NS.setProfile(profile);
      if (NS.rough && NS.rough.setPoints) NS.rough.setPoints(rough);
    } finally {
      remoteApply = false;
    }
    if (NS.detailed) NS.detailed.set(matched, lengthM, bridges);
    if (NS.elevation) NS.elevation.onMatched(matched);
  }

  // "9:<retrace_m>|<cleaned points>" — the cleaned import becomes the rough route; a substantial
  // retrace (out-and-back over the same ground) gets a notice, never a silent edit (§8).
  function applyImported(raw) {
    const body = raw.slice(raw.indexOf(":") + 1);
    const bar = body.indexOf("|");
    const retraceM = bar >= 0 ? parseFloat(body.slice(0, bar)) || 0 : 0;
    NS.rough.setPoints(decode(bar >= 0 ? body.slice(bar + 1) : body));
    if (retraceM >= 200 && NS.toast) {
      NS.toast("Track retraces ~" + NS.geo.formatDistance(retraceM) + " of itself — kept as recorded");
    }
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
    if (latest.length < 2) {
      if (NS.detailed) NS.detailed.set([], 0);
      if (NS.elevation) NS.elevation.onMatched([]);
      return;
    }
    ws.send("4:" + profileOf() + "|" + encode(latest));
  }

  function connect() {
    try { ws = new WebSocket(WS_URL); } catch (e) { return; }
    ws.addEventListener("open", () => {
      flush();
      persistNow();                         // edits made while offline reach the store (msg 4 no longer writes _working)
      if (NS.routes) NS.routes.onConnect(); // step 16: restore _working + prefetch the list
    });
    ws.addEventListener("message", (e) => {
      const raw = String(e.data);
      const id = raw.slice(0, raw.indexOf(":"));
      if (id === "5") applyMatched(raw);
      else if (id === "7") downloadGpx(raw.slice(2));
      else if (id === "9" && NS.rough && NS.rough.setPoints) applyImported(raw);
      else if (id === "11" && NS.elevation) NS.elevation.apply(raw);
      else if (id === "13" && NS.routes) NS.routes.applyList(raw.slice(raw.indexOf(":") + 1));
      else if (id === "17" && NS.routes) NS.routes.applyRoute(raw.slice(raw.indexOf(":") + 1));
      else if (id === "21" && NS.routes) NS.routes.applyName(raw.slice(raw.indexOf(":") + 1));
      else if (id === "23") applyRemoteSync(raw);
    });
    ws.addEventListener("close", () => setTimeout(connect, 1000));
    ws.addEventListener("error", () => { try { ws.close(); } catch (_) {} });
  }

  // Step 20: the instant persist — `_working`'s SINGLE writer. Carries the recent undo stack
  // ("#"-separated snapshots) so an unfinished sketch resumes with undo intact (draft save).
  function persistNow() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !latest || latest.length < 2) return;
    const hist = NS.undo && NS.undo.exportHistory
      ? NS.undo.exportHistory().map(encode).join("#") : "";
    ws.send("24:" + profileOf() + "|" + encode(latest) + "|" + hist);
  }

  // Called from app.js on every rough-layer change (debounced — re-match on edit-release).
  // During a remote-sync apply only `latest` updates (so later local edits build on the synced
  // state) — no flush is scheduled, or the peers would ping-pong the same edit forever.
  // Step 20: a COMMITTED edit persists immediately (msg 24, no debounce, no match) — a tab killed
  // inside the match-debounce window loses nothing. The match + sync fan-out stay debounced.
  function sendPoints(points, committed) {
    latest = points;
    if (remoteApply) return;
    if (committed) persistNow();
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

  // Step 15: the elevation profile of the DETAILED route (the client sends the matched polyline
  // back, so the server needs no re-match). Reply "11:" lands in elevation.js.
  function requestElevation(points) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !points || points.length < 2) return;
    ws.send("10:" + encode(points));
  }

  // Step 16: the named route store (replies "13:" list / "17:" route land in routes.js).
  function saveRoute(name) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !latest || latest.length < 2) return;
    ws.send("12:" + name.replace(/[|\n]/g, " ") + "|" + profileOf() + "|" + encode(latest));
  }
  function requestRoutesList() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send("14:");
  }
  function openRoute(name) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send("16:" + name);
  }
  function deleteRoute(name) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send("18:" + name);
  }

  // Step 17: ask for a proposed name for the current sketch ("21:" lands in routes.js).
  function requestName() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !latest || latest.length < 2) return;
    ws.send("20:" + profileOf() + "|" + encode(latest));
  }

  NS.ws = {
    sendPoints, requestExport, requestImport, requestElevation, connect,
    saveRoute, requestRoutesList, openRoute, deleteRoute, requestName,
    get connected() { return !!ws && ws.readyState === WebSocket.OPEN; },
  };
  connect();
})();
