// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-MAP M4 — bake the whole-region layer text (areas/buildings/streets/places/lines/pois.txt) into a
// static tile pyramid the browser loads as a WORKING SET: browser/tiles/<ty>_<tx>.json (features whose
// bbox touches that cell) + tiles/index.json (grid + region bbox + keys). A feature spanning cells is
// written into each; the client dedups by the identical text line. The loft PTile store (S6) stays the
// canonical authoring format; static tiles are the presentation-only, no-wasm, Pages-friendly client read.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CELL = 0.01;                                   // ~0.7 km cells
const LAYERS = { a: 'areas', b: 'buildings', s: 'streets', p: 'places', l: 'lines', o: 'pois' };
const read = (n) => { try { return readFileSync(join(here, n + '.txt'), 'utf8'); } catch { return ''; } };

// lat/lon bbox of a layer line — scan its "num,num" tokens (prefixes like cover/name/rank aren't coords).
function bbox(line) {
  let miLa = Infinity, maLa = -Infinity, miLo = Infinity, maLo = -Infinity;
  for (const part of line.split(';')) {
    const c = part.split(','); if (c.length !== 2) continue;
    const a = +c[0], b = +c[1];
    if (!Number.isNaN(a) && !Number.isNaN(b) && a > -90 && a < 90) { miLa = Math.min(miLa, a); maLa = Math.max(maLa, a); miLo = Math.min(miLo, b); maLo = Math.max(maLo, b); }
  }
  return miLa === Infinity ? null : { miLa, maLa, miLo, maLo };
}

const tiles = new Map();                             // "ty_tx" → {a:[],b:[],s:[],p:[],l:[],o:[]}
let rMiLa = Infinity, rMaLa = -Infinity, rMiLo = Infinity, rMaLo = -Infinity;
const counts = {};
for (const [k, name] of Object.entries(LAYERS)) {
  const lines = read(name).split('\n').filter(Boolean);
  counts[name] = lines.length;
  for (const line of lines) {
    const bb = bbox(line); if (!bb) continue;
    rMiLa = Math.min(rMiLa, bb.miLa); rMaLa = Math.max(rMaLa, bb.maLa); rMiLo = Math.min(rMiLo, bb.miLo); rMaLo = Math.max(rMaLo, bb.maLo);
    const ty0 = Math.floor(bb.miLa / CELL), ty1 = Math.floor(bb.maLa / CELL), tx0 = Math.floor(bb.miLo / CELL), tx1 = Math.floor(bb.maLo / CELL);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const kk = `${ty}_${tx}`; let t = tiles.get(kk); if (!t) { t = { a: [], b: [], s: [], p: [], l: [], o: [] }; tiles.set(kk, t); }
      t[k].push(line);
    }
  }
}

const dir = join(here, 'tiles');
if (existsSync(dir)) rmSync(dir, { recursive: true });
mkdirSync(dir);
const keys = [];
for (const [kk, t] of tiles) { keys.push(kk); writeFileSync(join(dir, kk + '.json'), JSON.stringify(t)); }
writeFileSync(join(dir, 'index.json'), JSON.stringify({ cell: CELL, minLat: rMiLa, minLon: rMiLo, maxLat: rMaLa, maxLon: rMaLo, keys, counts }));
console.log(`baked ${keys.length} tiles (cell ${CELL}°) → browser/tiles/  region ${rMiLa.toFixed(3)},${rMiLo.toFixed(3)}..${rMaLa.toFixed(3)},${rMaLo.toFixed(3)}`);
console.log('  layer counts:', JSON.stringify(counts));
