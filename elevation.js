// routing — elevation dock (PLAN step 15, DESIGN §1/§7). The LAG-TOLERANT tier: when the dock is
// open, the profile of the matched route is requested over WS (10: → 11:) and drawn along the
// bottom, with total ascent ↑ / descent ↓ beside it. Closed by default (low floor); it trails the
// drawing by design and never blocks the instant length or the map interaction.

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const dock = document.getElementById("elev-dock");
  const toggle = document.getElementById("elev-toggle");
  const totals = document.getElementById("elev-totals");
  const close = document.getElementById("elev-close");
  const canvas = document.getElementById("elev-canvas");

  let open = false;
  let matched = [];       // latest matched route (pushed from ws.js)
  let profile = null;     // { up, down, samples: [{d, e}] } | null
  let requested = "";     // encoding of the route last asked about (dedupe re-requests)

  const encode = (points) => points.map((p) => p.lat + "," + p.lon).join(";");

  function request() {
    if (!open || matched.length < 2) return;
    const spec = encode(matched);
    if (spec === requested) return;
    requested = spec;
    if (NS.ws && NS.ws.requestElevation) NS.ws.requestElevation(matched);
  }

  // "11:<up>|<down>|<d,e;…>" — parse and draw (called from ws.js).
  function apply(raw) {
    const parts = raw.slice(raw.indexOf(":") + 1).split("|");
    const samples = (parts[2] || "")
      .split(";")
      .filter(Boolean)
      .map((s) => {
        const c = s.split(",");
        return { d: parseFloat(c[0]), e: parseFloat(c[1]) };
      })
      .filter((s) => Number.isFinite(s.d) && Number.isFinite(s.e));
    profile = { up: parseFloat(parts[0]) || 0, down: parseFloat(parts[1]) || 0, samples };
    render();
  }

  // Called from ws.js whenever a new matched route lands (or the route clears).
  function onMatched(points) {
    matched = points || [];
    if (matched.length < 2) { profile = null; requested = ""; }
    if (open) { render(); request(); }
  }

  function render() {
    if (!open || !canvas) return;
    const ss = profile ? profile.samples : [];
    totals.textContent = ss.length >= 2
      ? `↑ ${Math.round(profile.up)} m   ↓ ${Math.round(profile.down)} m`
      : "elevation —";

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (ss.length < 2) return;

    const dMax = ss[ss.length - 1].d || 1;
    let lo = Infinity, hi = -Infinity;
    for (const s of ss) { if (s.e < lo) lo = s.e; if (s.e > hi) hi = s.e; }
    if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; } // flat-route floor
    const padX = 6, padTop = 8, padBot = 14;
    const px = (s) => padX + (s.d / dMax) * (w - 2 * padX);
    const py = (s) => h - padBot - ((s.e - lo) / (hi - lo)) * (h - padTop - padBot);

    // Filled area under the profile, then a 2px line on top (the app's route blue).
    ctx.beginPath();
    ctx.moveTo(px(ss[0]), h - padBot);
    for (const s of ss) ctx.lineTo(px(s), py(s));
    ctx.lineTo(px(ss[ss.length - 1]), h - padBot);
    ctx.closePath();
    ctx.fillStyle = "rgba(43, 108, 255, 0.28)";
    ctx.fill();
    ctx.beginPath();
    ss.forEach((s, i) => (i ? ctx.lineTo(px(s), py(s)) : ctx.moveTo(px(s), py(s))));
    ctx.strokeStyle = "#2b6cff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Recessive min/max/distance labels in muted ink (identity is carried by the dock, not color).
    ctx.fillStyle = "#9aa5b1";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`${Math.round(hi)} m`, padX, padTop + 4);
    ctx.fillText(`${Math.round(lo)} m`, padX, h - 3);
    const dTxt = dMax >= 1000 ? `${(dMax / 1000).toFixed(1)} km` : `${Math.round(dMax)} m`;
    ctx.fillText(dTxt, w - padX - ctx.measureText(dTxt).width, h - 3);
  }

  function setOpen(want) {
    open = want;
    dock.classList.toggle("hidden", !open);
    toggle.classList.toggle("is-active", open);
    if (open) { render(); request(); }
  }

  toggle.addEventListener("click", () => setOpen(!open));
  close.addEventListener("click", () => setOpen(false));
  window.addEventListener("resize", () => { if (open) render(); });

  NS.elevation = { apply, onMatched };
})();
