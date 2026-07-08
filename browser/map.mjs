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

// Parse the areas.txt layer: one polygon per line, `cover;lat,lon;lat,lon;…` (emit_areas.loft).
export function parseAreas(txt) {
  const areas = [];
  for (const line of (txt || '').split('\n')) {
    const parts = line.split(';');
    if (parts.length < 4) continue;                 // need a cover + ≥3 vertices
    const cover = parts[0], ring = [];
    for (let i = 1; i < parts.length; i++) {
      const c = parts[i].split(','); const a = +c[0], b = +c[1];
      if (c.length === 2 && !Number.isNaN(a) && !Number.isNaN(b)) ring.push([a, b]);
    }
    if (ring.length >= 3) areas.push({ cover, ring });
  }
  return areas;
}

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
    this.areas = opts.areas || [];            // [{cover, ring:[[lat,lon],…]}] — M2 terrain
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
    const ctx = this.ctx, W = this.width, H = this.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f2efe9';                 // Carto land background
    ctx.fillRect(0, 0, W, H);
    // M2: terrain fills — back-most layer, one filled path per area, Carto cover colour.
    for (const a of this.areas) this.drawArea(a);
    // M0 probe: plot the test points as dots (real layers replace this at M2+).
    for (const p of this.points) {
      const s = this.project(p.lat, p.lon);
      ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = '#c0392b'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      if (p.name) { ctx.fillStyle = '#222'; ctx.font = '12px system-ui, sans-serif'; ctx.fillText(p.name, s.x + 7, s.y + 4); }
    }
    // Centre crosshair — the camera centre must sit at the middle of the viewport.
    const cx = W / 2, cy = H / 2;
    ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();
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
