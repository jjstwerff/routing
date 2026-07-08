// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-MAP M4 — client working set. Loads only the tiles overlapping the viewport (browser/tiles/,
// baked by bake_tiles.mjs), fetched on camera-settle, cached, and evicted when off-screen. So the data
// held tracks the VIEWPORT, not the whole region. The renderer is unchanged — the loader just assembles
// the loaded tiles' feature lines (deduped by identical text) into map.areas/buildings/… and re-renders.
import { parseAreas, parseBuildings, parseStreets, parsePlaces, parseLines, parsePois } from './map.mjs';

export class TileLoader {
  constructor(map, base = 'tiles') { this.map = map; this.base = base; this.index = null; this.cache = new Map(); this.pad = 1; this.loaded = 0; }

  async start() {
    this.index = await fetch(`${this.base}/index.json`).then((r) => (r.ok ? r.json() : null));
    if (!this.index) throw new Error('no tiles/index.json');
    this.map.fitBounds(this.index.minLat, this.index.minLon, this.index.maxLat, this.index.maxLon);
    this.map.onMove(() => { this.update(); });
    await this.update();
    return this;
  }

  // Tile keys overlapping the viewport (+ a pad ring), restricted to tiles that actually exist.
  visibleKeys() {
    const b = this.map.bounds(), c = this.index.cell, pad = this.pad, present = new Set(this.index.keys);
    const tx0 = Math.floor(b.minLon / c) - pad, tx1 = Math.floor(b.maxLon / c) + pad;
    const ty0 = Math.floor(b.minLat / c) - pad, ty1 = Math.floor(b.maxLat / c) + pad;
    const keys = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) { const k = `${ty}_${tx}`; if (present.has(k)) keys.push(k); }
    return keys;
  }

  async update() {
    if (!this.index) return;
    const want = this.visibleKeys();
    await Promise.all(want.filter((k) => !this.cache.has(k)).map(async (k) => {
      const t = await fetch(`${this.base}/${k}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      this.cache.set(k, t || {});
    }));
    const keep = new Set(want);                          // working set: drop tiles no longer in view
    for (const k of [...this.cache.keys()]) if (!keep.has(k)) this.cache.delete(k);
    this.assemble(want);
    this.loaded = want.length;
    this.map.render();
  }

  assemble(keys) {
    const S = { a: new Set(), b: new Set(), s: new Set(), p: new Set(), l: new Set(), o: new Set() };
    for (const k of keys) { const t = this.cache.get(k); if (!t) continue; for (const key of Object.keys(S)) for (const line of (t[key] || [])) S[key].add(line); }
    const j = (set) => [...set].join('\n');
    this.map.areas = parseAreas(j(S.a));
    this.map.buildings = parseBuildings(j(S.b));
    this.map.streets = parseStreets(j(S.s));
    this.map.places = parsePlaces(j(S.p));
    this.map.lines = parseLines(j(S.l));
    this.map.pois = parsePois(j(S.o));
  }

  // Deterministic hook for the gate: jump the camera, load, and report the working set.
  async gotoAndLoad(lat, lon, zoom) {
    this.map.camera.lat = lat; this.map.camera.lon = lon; this.map.camera.zoom = zoom;
    await this.update();
    return {
      loaded: this.loaded, total: this.index.keys.length, keys: this.visibleKeys(),
      feats: { areas: this.map.areas.length, buildings: this.map.buildings.length, streets: this.map.streets.length, lines: this.map.lines.length, pois: this.map.pois.length },
    };
  }
}
