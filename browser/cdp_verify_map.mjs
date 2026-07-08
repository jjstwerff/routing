// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// Headless-Chromium verifier for PLAN-MAP M0 (browser/map-demo.html over file://): the projection +
// render + resize invariant on a REAL canvas.  node browser/cdp_verify_map.mjs <dt-host:port> <file-url>
import { readFileSync } from 'node:fs';
const [dt, app] = process.argv.slice(2);
setTimeout(() => { console.log('[hard-timeout]'); process.exit(3); }, 30000);

const list = await (await fetch(`http://${dt}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
const ev = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
// Centre the map on ll=[lat,lon] at zoom z, render, and read back a small JSON selector of _stats.
const at = async (ll, z, sel) => JSON.parse(await ev(`(()=>{const m=window.__map;m.camera.lat=${ll[0]};m.camera.lon=${ll[1]};m.camera.zoom=${z};m.render();return JSON.stringify(${sel});})()`) || '{}');

await call('Page.navigate', { url: app });

let m0 = null;
for (let i = 0; i < 40; i++) { const s = await ev('window.__m0?JSON.stringify(window.__m0):""'); if (s) { m0 = JSON.parse(s); break; } await new Promise((r) => setTimeout(r, 250)); }
if (!m0) { console.log('FAIL: no window.__m0 (module did not load — file:// module CORS? render error?)'); process.exit(1); }

let ok = true;
console.log(`  viewport ${m0.W}×${m0.H} @${m0.dpr}x · centre (${m0.center.x.toFixed(1)},${m0.center.y.toFixed(1)}) · bg ${JSON.stringify(m0.bg)}`);
if (!m0.centerOK) { console.log('FAIL: camera centre does not project to the viewport centre'); ok = false; } else console.log('  ✓ centre projects to viewport centre (real canvas)');
if (!(m0.roundtripDeg < 1e-6)) { console.log('FAIL: unproject∘project error ' + m0.roundtripDeg); ok = false; } else console.log(`  ✓ round-trip ${m0.roundtripDeg.toExponential(1)}°`);
if (!m0.rendered) { console.log('FAIL: canvas centre pixel not opaque — render() did not paint'); ok = false; } else console.log('  ✓ render() painted the canvas');

// M2 · terrain: the areas render, count == emitted, and the central region is painted (not the land bg).
let srcAreas = null;
try { const t = readFileSync(new URL('./areas.txt', import.meta.url), 'utf8'); srcAreas = t.split('\n').filter((l) => l.split(';').length >= 4).length; } catch {}
let m2 = null;
for (let i = 0; i < 40; i++) { const s = await ev('window.__m2?JSON.stringify(window.__m2):""'); if (s) { m2 = JSON.parse(s); break; } await new Promise((r) => setTimeout(r, 250)); }
if (srcAreas === null) console.log('  ~ M2 skipped: no browser/areas.txt (run `node browser/build.mjs`)');
else if (!m2) { console.log('FAIL: areas.txt present but window.__m2 never set — file:// fetch failed?'); ok = false; }
else {
  console.log(`  terrain: rendered ${m2.areas} areas, emitted ${srcAreas}, central painted ${(m2.frac * 100).toFixed(0)}%`);
  if (m2.areas !== srcAreas) { console.log(`FAIL: rendered ${m2.areas} areas != ${srcAreas} emitted`); ok = false; } else console.log('  ✓ every emitted area rendered');
  if (!(m2.frac > 0.3)) { console.log(`FAIL: terrain not painted (central colored fraction ${m2.frac})`); ok = false; } else console.log('  ✓ terrain fills the view (Carto cover colours)');
}

// M3 · buildings + streets + labels: counts == emitted; S13 gates buildings by zoom; labels draw.
const cnt = (f, min) => { try { return readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').filter((l) => l.split(';').length >= min).length; } catch { return null; } };
const srcB = cnt('./buildings.txt', 3), srcS = cnt('./streets.txt', 3), srcP = cnt('./places.txt', 3);
let m3 = null;
for (let i = 0; i < 40; i++) { const s = await ev('window.__m3?JSON.stringify(window.__m3):""'); if (s) { m3 = JSON.parse(s); break; } await new Promise((r) => setTimeout(r, 250)); }
if (srcB === null) console.log('  ~ M3 skipped: no browser/{buildings,streets,places}.txt (run `node browser/build.mjs`)');
else if (!m3) { console.log('FAIL: layers present but window.__m3 never set'); ok = false; }
else {
  console.log(`  layers: buildings ${m3.counts.buildings}/${srcB} · streets ${m3.counts.streets}/${srcS} · places ${m3.counts.places}/${srcP}`);
  if (m3.counts.buildings !== srcB || m3.counts.streets !== srcS || m3.counts.places !== srcP) { console.log('FAIL: parsed layer counts != emitted'); ok = false; } else console.log('  ✓ buildings/streets/places all parsed');
  // The sample crops sit in different sub-regions (S11 fixture mismatch — M4 unifies them), so verify
  // each layer WHERE its data lives: centre on it, render, read the stats.
  const anchors = JSON.parse(await ev(`(()=>{const m=window.__map;
    const st=m.streets[0], sp=st.line[Math.floor(st.line.length/2)];
    const b=m.buildings[0], bp=b.ring[0]; const p=m.places[0];
    return JSON.stringify({sp,bp,pp:p.at});})()`));
  // S13: centre on a building — hidden below z14, shown at/above.
  const blo = await at(anchors.bp, 12, '{b:m._stats.buildings}'), bhi = await at(anchors.bp, 16, '{b:m._stats.buildings}');
  if (!(blo.b === 0 && bhi.b > 0)) { console.log(`FAIL: S13 building zoom-gate wrong (z12 ${blo.b}, z16 ${bhi.b})`); ok = false; } else console.log(`  ✓ S13 buildings gated by zoom (z12 hidden → z16 ${bhi.b} in view)`);
  // streets + street labels: centre on a street at z15.
  const sT = await at(anchors.sp, 15, '{streets:m._stats.streets,sl:m._stats.streetLabels}');
  if (!(sT.streets > 0)) { console.log('FAIL: no streets drawn where streets are'); ok = false; } else console.log(`  ✓ ${sT.streets} streets drawn (casing + core)`);
  if (!(sT.sl > 0)) { console.log('FAIL: no street labels'); ok = false; } else console.log(`  ✓ ${sT.sl} street labels along centrelines (collision-filtered)`);
  // place labels: centre on a place at z13.
  const pT = await at(anchors.pp, 13, '{pl:m._stats.placeLabels}');
  if (!(pT.pl > 0)) { console.log('FAIL: no place labels'); ok = false; } else console.log(`  ✓ ${pT.pl} place labels (rank-gated)`);
}

// M3b · lines + POIs: counts == emitted; streams stroke; POI glyphs draw (zoom-gated).
const srcL = cnt('./lines.txt', 3), srcPo = cnt('./pois.txt', 3);
let m3b = null;
for (let i = 0; i < 40; i++) { const s = await ev('window.__m3b?JSON.stringify(window.__m3b):""'); if (s) { m3b = JSON.parse(s); break; } await new Promise((r) => setTimeout(r, 250)); }
if (srcL === null) console.log('  ~ M3b skipped: no browser/{lines,pois}.txt (run the emitters)');
else if (!m3b) { console.log('FAIL: layers present but window.__m3b never set'); ok = false; }
else {
  console.log(`  layers: lines ${m3b.counts.lines}/${srcL} · pois ${m3b.counts.pois}/${srcPo}`);
  if (m3b.counts.lines !== srcL || m3b.counts.pois !== srcPo) { console.log('FAIL: parsed line/poi counts != emitted'); ok = false; } else console.log('  ✓ lines/pois all parsed');
  const anc = JSON.parse(await ev(`(()=>{const m=window.__map;const l=m.lines[0],lp=l.geom[Math.floor(l.geom.length/2)];return JSON.stringify({lp,pp:m.pois[0].at});})()`));
  const lT = await at(anc.lp, 14, '{lines:m._stats.lines}');
  if (!(lT.lines > 0)) { console.log('FAIL: no lines stroked'); ok = false; } else console.log(`  ✓ ${lT.lines} lines stroked (streams/rails/barriers)`);
  const poT = await at(anc.pp, 17, '{pois:m._stats.pois}');
  if (!(poT.pois > 0)) { console.log('FAIL: no POI glyphs drawn'); ok = false; } else console.log(`  ✓ ${poT.pois} POI glyphs (zoom-gated, catalog rows)`);
}

// M1 · pan: dispatch a real left-drag; the lat/lon grabbed at mousedown must sit under the cursor at
// mouseup (and zoom must not change).
const pan = JSON.parse(await ev(`(()=>{const map=window.__map,cv=map.canvas;
  const a={x:200,y:150},b={x:340,y:260};
  const grab=map.unproject(a.x,a.y), z0=map.camera.zoom;
  cv.dispatchEvent(new MouseEvent('mousedown',{clientX:a.x,clientY:a.y,button:0,bubbles:true}));
  window.dispatchEvent(new MouseEvent('mousemove',{clientX:b.x,clientY:b.y,button:0,bubbles:true}));
  window.dispatchEvent(new MouseEvent('mouseup',{clientX:b.x,clientY:b.y,button:0,bubbles:true}));
  const now=map.unproject(b.x,b.y);
  return JSON.stringify({dLat:Math.abs(now.lat-grab.lat),dLon:Math.abs(now.lon-grab.lon),dZoom:Math.abs(map.camera.zoom-z0)});})()`) || '{}');
if (!(pan.dLat < 1e-9 && pan.dLon < 1e-9 && pan.dZoom === 0)) { console.log('FAIL: pan did not hold the grabbed point under the cursor — ' + JSON.stringify(pan)); ok = false; }
else console.log(`  ✓ pan holds the grabbed point under the cursor (${pan.dLat.toExponential(1)}°, zoom fixed)`);

// M1 · wheel: dispatch a real wheel tick; the cursor's lat/lon must stay fixed while zoom increases.
const zm = JSON.parse(await ev(`(()=>{const map=window.__map,cv=map.canvas;
  const c={x:300,y:220};const anchor=map.unproject(c.x,c.y),z0=map.camera.zoom;
  cv.dispatchEvent(new WheelEvent('wheel',{clientX:c.x,clientY:c.y,deltaY:-120,bubbles:true,cancelable:true}));
  const after=map.unproject(c.x,c.y);
  return JSON.stringify({dLat:Math.abs(after.lat-anchor.lat),dLon:Math.abs(after.lon-anchor.lon),z0,z1:map.camera.zoom});})()`) || '{}');
if (!(zm.dLat < 1e-9 && zm.dLon < 1e-9 && zm.z1 > zm.z0)) { console.log('FAIL: wheel zoom not cursor-anchored or did not zoom — ' + JSON.stringify(zm)); ok = false; }
else console.log(`  ✓ wheel zoom cursor-anchored (${zm.dLat.toExponential(1)}°) z ${zm.z0}→${zm.z1.toFixed(2)}`);

// Resize: change the viewport, resize+render, the centre must stay centred.
await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 640, deviceScaleFactor: 1, mobile: false });
const r2 = await ev('(()=>{window.__map.resize();window.__map.render();const c=window.__map.project(window.__map.camera.lat,window.__map.camera.lon);return JSON.stringify({W:window.__map.width,H:window.__map.height,x:c.x,y:c.y});})()');
const j = JSON.parse(r2 || '{}');
const rOK = Math.abs(j.x - j.W / 2) < 1e-6 && Math.abs(j.y - j.H / 2) < 1e-6;
if (!rOK) { console.log('FAIL: resize did not keep the centre centred — ' + r2); ok = false; } else console.log(`  ✓ resize keeps the centre centred (${j.W}×${j.H})`);

console.log(ok ? 'PASS — M0..M3b: projection + pan/zoom + terrain + buildings/streets/labels + lines/POIs verified headless.' : 'FAILURES');
process.exit(ok ? 0 : 1);
