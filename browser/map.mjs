// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// browser/map.mjs — our own canvas map renderer (replaces Leaflet). PLAN-MAP M0.
//
// M0 scope: a full-bleed <canvas>, a camera {lat,lon,zoom}, a spherical Web-Mercator
// projection (camera + devicePixelRatio applied), and a render() that clears + plots test
// points. The projection is factored into PURE functions (projectWorld/unprojectWorld/makeView)
// so the invariant — center projects to screen-centre, unproject∘project ≈ identity, resize
// keeps the centre centred — is provable in node with no DOM (see map.test.mjs).
//
// Interaction (pan/wheel), the layers, and the feature catalog arrive in M1+. The seam
// exported at the bottom (project/unproject/camera/onRender/hitTest) is what PLAN-EDIT builds on.

const TILE = 256;                         // world-pixel size of one tile at zoom 0
const MAX_LAT = 85.05112877980659;        // Web-Mercator latitude limit (where y → ±∞)
const MIN_ZOOM = 2, MAX_ZOOM = 19;        // pan/zoom clamp (M1)
const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

// --- Pure spherical Web-Mercator: lon/lat ↔ world pixels at a given (fractional) zoom -------

export function projectWorld(lon, lat, zoom) {
  const scale = TILE * Math.pow(2, zoom);
  const s = Math.sin(clampLat(lat) * Math.PI / 180);
  return {
    x: (lon + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

export function unprojectWorld(x, y, zoom) {
  const scale = TILE * Math.pow(2, zoom);
  const n = Math.PI - 2 * Math.PI * y / scale;
  return {
    lon: x / scale * 360 - 180,
    lat: Math.atan(Math.sinh(n)) * 180 / Math.PI,
  };
}

// --- A view = camera {lat,lon,zoom} + a viewport size (CSS px). Pure, DOM-free, node-testable.
// The camera centre sits at the middle of the viewport; project/unproject are defined relative
// to it, so pan is "move the centre" and zoom-about-a-point is "hold unproject(point) fixed".

export function makeView(camera, width, height) {
  const c = projectWorld(camera.lon, camera.lat, camera.zoom);
  return {
    camera, width, height,
    project(lat, lon) {
      const p = projectWorld(lon, lat, camera.zoom);
      return { x: p.x - c.x + width / 2, y: p.y - c.y + height / 2 };
    },
    unproject(sx, sy) {
      return unprojectWorld(c.x + sx - width / 2, c.y + sy - height / 2, camera.zoom);
    },
  };
}

// --- Catalog v1 (§4b): landcover fill colours, following OpenStreetMap standard (Carto). ------
export const COVER_COLORS = {
  water: '#a5c8e8', forest: '#a6d99a', grass: '#cfeca8', park: '#c6e2a6', farmland: '#eff0d6',
  residential: '#e6e1de', industrial: '#e6d5e2', sand: '#f5e7c0', wetland: '#bfd8d8', bare: '#e0dccb',
};
const COVER_FALLBACK = '#ebe7e0';

// Buildings + roads (Carto). Roads are drawn as a casing + white core (two passes).
const BUILDING_FILL = '#d9c7b0', BUILDING_STROKE = '#b6a488';
const ROAD_CASING = '#c9c4bd', ROAD_CORE = '#ffffff';
const BUILDINGS_MINZOOM = 14;                       // footprints only when zoomed in (S13)
const STREET_MINZOOM = 13, STREET_SPACING_PX = 190; // street labels repeat every ~190 px (S10)
const STREET_FONTPX = 11;
// Place labels (S9): rank → the min zoom it appears at, and its font size (city → hamlet).
const RANK_MINZOOM = { 6: 0, 5: 9, 4: 11, 3: 12, 2: 13, 1: 14 };
const RANK_FONTPX = { 6: 16, 5: 14, 4: 12, 3: 11, 2: 10, 1: 9 };
const roadWidth = (z) => (z >= 16 ? 4.5 : z >= 14 ? 3 : z >= 12 ? 2 : 1.4);

// S13 generalization: big areas (forest, water) survive to low zoom; tiny patches only appear zoomed in.
function areaMinZoom(ring) {
  let miLa = Infinity, maLa = -Infinity, miLo = Infinity, maLo = -Infinity;
  for (const [a, b] of ring) { miLa = Math.min(miLa, a); maLa = Math.max(maLa, a); miLo = Math.min(miLo, b); maLo = Math.max(maLo, b); }
  const diag = Math.hypot(maLa - miLa, maLo - miLo);
  return diag > 0.008 ? 0 : diag > 0.003 ? 11 : diag > 0.0015 ? 12 : diag > 0.0007 ? 13 : 14;
}

// --- Layer parsers (the emit_*.loft text formats) ---------------------------------------------
export function parseAreas(txt) {                   // `cover;lat,lon;…`
  const areas = [];
  for (const line of (txt || '').split('\n')) {
    const parts = line.split(';');
    if (parts.length < 4) continue;                 // need a cover + ≥3 vertices
    const cover = parts[0], ring = [];
    for (let i = 1; i < parts.length; i++) {
      const c = parts[i].split(','); const a = +c[0], b = +c[1];
      if (c.length === 2 && !Number.isNaN(a) && !Number.isNaN(b)) ring.push([a, b]);
    }
    if (ring.length >= 3) areas.push({ cover, ring, minZoom: areaMinZoom(ring) });
  }
  return areas;
}
export function parseBuildings(txt) {               // `lat,lon;lat,lon;…` (ring, no prefix)
  const out = [];
  for (const line of (txt || '').split('\n')) {
    const ring = [];
    for (const p of line.split(';')) { const c = p.split(','); const a = +c[0], b = +c[1]; if (c.length === 2 && !Number.isNaN(a) && !Number.isNaN(b)) ring.push([a, b]); }
    if (ring.length >= 3) out.push({ ring });
  }
  return out;
}
export function parseStreets(txt) {                 // `name;lat,lon;lat,lon;…`
  const out = [];
  for (const line of (txt || '').split('\n')) {
    const parts = line.split(';'); if (parts.length < 3) continue;
    const name = parts[0], geom = [];
    for (let i = 1; i < parts.length; i++) { const c = parts[i].split(','); const a = +c[0], b = +c[1]; if (c.length === 2 && !Number.isNaN(a) && !Number.isNaN(b)) geom.push([a, b]); }
    if (geom.length >= 2) out.push({ name, line: geom });
  }
  return out;
}
export function parsePlaces(txt) {                  // `rank;name;lat,lon`
  const out = [];
  for (const line of (txt || '').split('\n')) {
    const parts = line.split(';'); if (parts.length < 3) continue;
    const rank = +parts[0], name = parts[1], c = parts[2].split(','); const a = +c[0], b = +c[1];
    if (c.length === 2 && !Number.isNaN(a) && !Number.isNaN(b)) out.push({ rank, name, at: [a, b] });
  }
  return out;
}
export function parseLines(txt) {                   // `kind;name;lat,lon;…`
  const out = [];
  for (const line of (txt || '').split('\n')) {
    const parts = line.split(';'); if (parts.length < 3) continue;
    const kind = parts[0], name = parts[1], geom = [];
    for (let i = 2; i < parts.length; i++) { const c = parts[i].split(','); const a = +c[0], b = +c[1]; if (c.length === 2 && !Number.isNaN(a) && !Number.isNaN(b)) geom.push([a, b]); }
    if (geom.length >= 2) out.push({ kind, name, geom });
  }
  return out;
}
export function parsePois(txt) {                    // `kind;name;lat,lon`
  const out = [];
  for (const line of (txt || '').split('\n')) {
    const parts = line.split(';'); if (parts.length < 3) continue;
    const kind = parts[0], name = parts[1], c = parts[2].split(','); const a = +c[0], b = +c[1];
    if (c.length === 2 && !Number.isNaN(a) && !Number.isNaN(b)) out.push({ kind, name, at: [a, b] });
  }
  return out;
}

// --- Catalog v2 (§4b): Line + POI styles, following OSM Carto. Each kind is a row — grow freely. -----
const LINE_STYLES = {                               // waterway = blue; railway = grey dashes; barriers muted
  river: { color: '#a5c8e8', width: 3, minZoom: 11 }, stream: { color: '#a5c8e8', width: 1.5, minZoom: 13 },
  ditch: { color: '#b6d0e6', width: 1, minZoom: 14 }, canal: { color: '#a5c8e8', width: 2.5, minZoom: 12 },
  railway: { color: '#8a8a8a', width: 1.6, dash: [6, 4], minZoom: 12 }, tram: { color: '#9a9a9a', width: 1.2, dash: [4, 4], minZoom: 13 },
  hedge: { color: '#8fb37a', width: 1.4, minZoom: 15 }, wall: { color: '#b0a89a', width: 1, minZoom: 15 }, fence: { color: '#c2bbaa', width: 0.8, minZoom: 16 },
};
const POI_STYLES = {                                // color · minZoom · glyph shape (circle/square/triangle)
  tree: { color: '#6b9b37', z: 15, shape: 'circle', r: 2.5 }, bench: { color: '#8a6d3b', z: 16, shape: 'square', r: 2 },
  picnic: { color: '#8a6d3b', z: 15, shape: 'square', r: 2.5 }, shelter: { color: '#8a6d3b', z: 15, shape: 'square', r: 2.5 },
  drinking_water: { color: '#4a90d9', z: 16, shape: 'circle', r: 2 }, fountain: { color: '#4a90d9', z: 15, shape: 'circle', r: 2.5 }, spring: { color: '#4a90d9', z: 14, shape: 'circle', r: 2.5 },
  viewpoint: { color: '#b5651d', z: 13, shape: 'triangle', r: 4 }, tower: { color: '#7a5230', z: 12, shape: 'triangle', r: 4 }, peak: { color: '#7a5230', z: 12, shape: 'triangle', r: 4.5 }, camp: { color: '#2e7d32', z: 12, shape: 'triangle', r: 4.5 },
  crossing: { color: '#555555', z: 16, shape: 'square', r: 2 }, playground: { color: '#e08a2b', z: 14, shape: 'circle', r: 3 },
  ruins: { color: '#7a5230', z: 13, shape: 'square', r: 3 }, monument: { color: '#7a5230', z: 13, shape: 'triangle', r: 3.5 }, information: { color: '#4a90d9', z: 15, shape: 'square', r: 2.5 },
};
const POI_FALLBACK = { color: '#777777', z: 15, shape: 'circle', r: 2.5 };

// The camera centre that puts geographic `latlon` under screen point `mouse` (CSS px) at `zoom`.
// Pan is "hold the grabbed lat/lon under the cursor"; zoom-about-a-point is "hold the cursor's
// lat/lon fixed while zoom changes" — both are just this, so both share one tested helper (M1).
export function panCenter(latlon, mouse, zoom, width, height) {
  const gw = projectWorld(latlon.lon, latlon.lat, zoom);
  return unprojectWorld(gw.x - mouse.x + width / 2, gw.y - mouse.y + height / 2, zoom);
}

// --- RouteMap: binds a view to a canvas (HiDPI backing store, resize) + render(). Browser only.

export class RouteMap {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = { lat: opts.lat ?? 52.2215, lon: opts.lon ?? 6.8937, zoom: opts.zoom ?? 13 };
    this.points = opts.points || [];          // [{lat,lon,name?}] — M0 test dots
    this.areas = opts.areas || [];            // [{cover, ring, minZoom}] — M2 terrain
    this.buildings = opts.buildings || [];    // [{ring}]                  — M3 footprints
    this.streets = opts.streets || [];        // [{name, line}]            — M3 roads + labels
    this.places = opts.places || [];          // [{rank, name, at}]        — M3 place labels
    this.lines = opts.lines || [];            // [{kind, name, geom}]      — M3b streams/rails/barriers
    this.pois = opts.pois || [];              // [{kind, name, at}]        — M3b point features
    this._stats = {};                         // per-render draw counts (gate hook)
    this.width = 1; this.height = 1; this.dpr = 1;
    this._renderCbs = [];
    this._raf = 0;
    if (typeof window !== 'undefined') window.addEventListener('resize', () => { this.resize(); this.render(); });
    this.resize();
    if (opts.interactive !== false) this.enableInteraction();
  }

  // Size the backing store to CSS-px × devicePixelRatio and draw in CSS px (crisp on HiDPI).
  resize() {
    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const r = this.canvas.getBoundingClientRect
      ? this.canvas.getBoundingClientRect()
      : { width: this.canvas.width || 1, height: this.canvas.height || 1 };
    this.width = Math.max(1, Math.round(r.width));
    this.height = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  view() { return makeView(this.camera, this.width, this.height); }
  project(lat, lon) { return this.view().project(lat, lon); }
  unproject(x, y) { return this.view().unproject(x, y); }

  // --- M1: pan (left-drag) + wheel zoom, both cursor-anchored -----------------------------------
  // Move the camera so `latlon` sits under screen point `mouse` (keeps the grabbed point pinned).
  panTo(mouse, latlon) {
    const ll = panCenter(latlon, mouse, this.camera.zoom, this.width, this.height);
    this.camera.lat = ll.lat; this.camera.lon = ll.lon;
  }
  // Zoom by `dz` about `mouse`: the geographic point under the cursor stays under the cursor.
  zoomAt(mouse, dz) {
    const anchor = this.unproject(mouse.x, mouse.y);
    this.camera.zoom = clampZoom(this.camera.zoom + dz);
    this.panTo(mouse, anchor);
  }
  enableInteraction() {
    if (typeof window === 'undefined' || this._interactive) return;
    this._interactive = true;
    const cv = this.canvas;
    const posOf = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    this._grab = null;
    cv.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const m = posOf(e);
      this._grab = this.unproject(m.x, m.y);       // the lat/lon we grabbed — held under the cursor
      cv.style.cursor = 'grabbing';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this._grab) return;
      this.panTo(posOf(e), this._grab);
      this.requestRender();
    });
    window.addEventListener('mouseup', () => { if (this._grab) { this._grab = null; cv.style.cursor = 'grab'; } });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dz = Math.max(-1, Math.min(1, -e.deltaY * 0.005));   // ~0.5 zoom / notch, clamped per event
      this.zoomAt(posOf(e), dz);
      this.requestRender();
    }, { passive: false });
    cv.style.cursor = 'grab';
  }

  onRender(cb) { this._renderCbs.push(cb); return this; }
  // Coalesce redraw requests to one per frame (used by pan/zoom in M1).
  requestRender() {
    if (this._raf || typeof requestAnimationFrame === 'undefined') { if (!this._raf) this.render(); return; }
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    const ctx = this.ctx, W = this.width, H = this.height, z = this.camera.zoom;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f2efe9';                 // Carto land background
    ctx.fillRect(0, 0, W, H);
    // z-order: terrain → buildings → roads → labels. S13 gates small features by zoom.
    let areasN = 0;
    for (const a of this.areas) if (z >= a.minZoom) { this.drawArea(a); areasN++; }
    const lnN = this.drawLines();              // streams / rails / barriers, above terrain
    let bN = 0;
    if (z >= BUILDINGS_MINZOOM) for (const b of this.buildings) { const px = this._projLine(b.ring); if (px.length >= 3 && this._inView(px, 20)) { this._fillPx(px, BUILDING_FILL, BUILDING_STROKE); bN++; } }
    const sN = this.drawStreets();
    const poiN = this.drawPois();              // point glyphs, above roads
    const lab = this.layoutLabels();
    this._stats = { areas: areasN, lines: lnN, buildings: bN, streets: sN, pois: poiN, placeLabels: lab.placeLabels, streetLabels: lab.streetLabels };
    // M0 probe: optional test dots (empty once real layers are loaded).
    for (const p of this.points) {
      const s = this.project(p.lat, p.lon);
      ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = '#c0392b'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    for (const cb of this._renderCbs) cb(ctx, this);
  }

  // M2: one filled path per area, coloured by Carto cover class.
  drawArea(area) {
    const r = area.ring;
    if (r.length < 3) return;
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < r.length; i++) { const s = this.project(r[i][0], r[i][1]); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); }
    ctx.closePath();
    ctx.fillStyle = COVER_COLORS[area.cover] || COVER_FALLBACK;
    ctx.fill();
  }

  // Fill (and optionally stroke) an already-projected ring — used by building footprints (≥ z14).
  _fillPx(px, fill, stroke) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < px.length; i++) { if (i === 0) ctx.moveTo(px[i].x, px[i].y); else ctx.lineTo(px[i].x, px[i].y); }
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.6; ctx.stroke(); }
  }

  // M3: roads — casing then white core (two passes), Carto style. Returns the count drawn (in view).
  _projLine(g) { const px = new Array(g.length); for (let i = 0; i < g.length; i++) px[i] = this.project(g[i][0], g[i][1]); return px; }
  _inView(px, pad = 60) { for (const p of px) if (p.x >= -pad && p.x <= this.width + pad && p.y >= -pad && p.y <= this.height + pad) return true; return false; }
  _strokePx(px) { const ctx = this.ctx; ctx.beginPath(); for (let i = 0; i < px.length; i++) { if (i === 0) ctx.moveTo(px[i].x, px[i].y); else ctx.lineTo(px[i].x, px[i].y); } ctx.stroke(); }
  drawStreets() {
    if (!this.streets.length) return 0;
    const ctx = this.ctx, w = roadWidth(this.camera.zoom);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const vis = [];
    for (const st of this.streets) { const px = this._projLine(st.line); if (px.length >= 2 && this._inView(px)) vis.push({ st, px }); }
    ctx.strokeStyle = ROAD_CASING; ctx.lineWidth = w + 2; for (const v of vis) this._strokePx(v.px);   // casing
    ctx.strokeStyle = ROAD_CORE;   ctx.lineWidth = w;     for (const v of vis) this._strokePx(v.px);   // core
    this._visStreets = vis;                                                                             // reused by labels
    return vis.length;
  }

  // M3b: stroked lines (streams/rails/barriers), per-kind Carto style, zoom-gated + culled.
  drawLines() {
    if (!this.lines.length) return 0;
    const z = this.camera.zoom, ctx = this.ctx; let n = 0;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const ln of this.lines) {
      const st = LINE_STYLES[ln.kind]; if (!st || z < st.minZoom) continue;
      const px = this._projLine(ln.geom); if (px.length < 2 || !this._inView(px)) continue;
      ctx.strokeStyle = st.color; ctx.lineWidth = st.width; ctx.setLineDash(st.dash || []);
      this._strokePx(px); n++;
    }
    ctx.setLineDash([]);
    return n;
  }

  // M3b: one POI glyph (circle/square/triangle), zoom-gated, with a white halo. Returns true if drawn.
  drawPoi(p) {
    const st = POI_STYLES[p.kind] || POI_FALLBACK;
    if (this.camera.zoom < st.z) return false;
    const s = this.project(p.at[0], p.at[1]);
    if (s.x < 0 || s.x > this.width || s.y < 0 || s.y > this.height) return false;
    const ctx = this.ctx, r = st.r || 2.5;
    ctx.beginPath();
    if (st.shape === 'square') ctx.rect(s.x - r, s.y - r, 2 * r, 2 * r);
    else if (st.shape === 'triangle') { ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y + r); ctx.lineTo(s.x - r, s.y + r); ctx.closePath(); }
    else ctx.arc(s.x, s.y, r, 0, 2 * Math.PI);
    ctx.setLineDash([]); ctx.fillStyle = st.color; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1;
    ctx.fill(); ctx.stroke();
    return true;
  }
  drawPois() { let n = 0; for (const p of this.pois) if (this.drawPoi(p)) n++; return n; }

  // M3 S9/S10/S14: ONE collision-aware label pass. Place labels first (highest rank wins), then street
  // labels along the centreline, repeated, skipping any candidate overlapping an already-placed label.
  layoutLabels() {
    const ctx = this.ctx, z = this.camera.zoom, placed = [];
    const fits = (x, y, w, h) => {
      const l = x - w / 2, t = y - h / 2, r = x + w / 2, b = y + h / 2;
      for (const q of placed) if (!(r < q[0] || l > q[2] || b < q[1] || t > q[3])) return false;
      placed.push([l, t, r, b]); return true;
    };
    let placeLabels = 0;
    for (const p of [...this.places].sort((a, b) => b.rank - a.rank)) {
      if (z < (RANK_MINZOOM[p.rank] ?? 14)) continue;
      const s = this.project(p.at[0], p.at[1]);
      if (s.x < -40 || s.x > this.width + 40 || s.y < -40 || s.y > this.height + 40) continue;
      const f = RANK_FONTPX[p.rank] || 10, font = `600 ${f}px system-ui, sans-serif`;
      ctx.font = font;
      if (!fits(s.x, s.y, ctx.measureText(p.name).width + 6, f + 6)) continue;
      this._label(p.name, s.x, s.y, font, '#3a3a3a');
      placeLabels++;
    }
    const streetLabels = z >= STREET_MINZOOM ? this._streetLabels(fits) : 0;
    return { placeLabels, streetLabels };
  }
  _streetLabels(fits) {
    const ctx = this.ctx, font = `${STREET_FONTPX}px system-ui, sans-serif`; let n = 0;
    ctx.font = font;
    for (const { st, px } of (this._visStreets || [])) {
      const seg = []; let total = 0;
      for (let i = 1; i < px.length; i++) { const d = Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y); seg.push(d); total += d; }
      if (total < 70) continue;
      const w0 = ctx.measureText(st.name).width + 4;
      const count = Math.max(1, Math.round(total / STREET_SPACING_PX)), step = total / (count + 1);
      for (let k = 1; k <= count; k++) {
        const target = step * k; let acc = 0, i = 1;
        while (i < px.length && acc + seg[i - 1] < target) { acc += seg[i - 1]; i++; }
        if (i >= px.length) i = px.length - 1;
        const p0 = px[i - 1], p1 = px[i], t = seg[i - 1] ? (target - acc) / seg[i - 1] : 0;
        const cx = p0.x + (p1.x - p0.x) * t, cy = p0.y + (p1.y - p0.y) * t;
        let ang = Math.atan2(p1.y - p0.y, p1.x - p0.x); const deg = ang * 180 / Math.PI;
        if (deg > 90) ang -= Math.PI; else if (deg < -90) ang += Math.PI;    // keep the text upright
        const aw = Math.abs(w0 * Math.cos(ang)) + Math.abs(STREET_FONTPX * Math.sin(ang));   // rotated AABB
        const ah = Math.abs(w0 * Math.sin(ang)) + Math.abs(STREET_FONTPX * Math.cos(ang));
        if (!fits(cx, cy, aw, ah)) continue;
        this._rotLabel(st.name, cx, cy, ang, font, '#555');
        n++;
      }
    }
    return n;
  }
  _label(text, x, y, font, color) {
    const ctx = this.ctx;
    ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }
  _rotLabel(text, x, y, rad, font, color) {
    const ctx = this.ctx; ctx.save(); ctx.translate(x, y); ctx.rotate(rad); this._label(text, 0, 0, font, color); ctx.restore();
  }

  // Centre + zoom the camera so a lat/lon box fits the viewport (with a little padding).
  fitBounds(minLat, minLon, maxLat, maxLon, pad = 1.12) {
    this.camera.lat = (minLat + maxLat) / 2;
    this.camera.lon = (minLon + maxLon) / 2;
    for (let z = MAX_ZOOM; z >= MIN_ZOOM; z -= 0.25) {
      const a = projectWorld(minLon, maxLat, z), b = projectWorld(maxLon, minLat, z);
      if (Math.abs(b.x - a.x) * pad <= this.width && Math.abs(b.y - a.y) * pad <= this.height) { this.camera.zoom = z; return; }
    }
    this.camera.zoom = MIN_ZOOM;
  }

  hitTest(/* x, y */) { return null; }         // stub — PLAN-EDIT fills this in

  // The seam PLAN-EDIT rides (never reaches into internals).
  get seam() {
    return {
      project: (lat, lon) => this.project(lat, lon),
      unproject: (x, y) => this.unproject(x, y),
      camera: this.camera,
      onRender: (cb) => this.onRender(cb),
      hitTest: (x, y) => this.hitTest(x, y),
    };
  }
}
