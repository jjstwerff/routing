// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// Headless verifier for PLAN-MAP M4 (browser/map.html over file://): the whole-region tiled WORKING SET.
// Proves the data held tracks the viewport, not the region: zooming in loads a strict subset of tiles,
// panning loads a different subset, and the layers render from tiles.
//   node browser/cdp_verify_tiles.mjs <dt-host:port> <file-url>
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

await call('Page.navigate', { url: app });
let m4 = null;
for (let i = 0; i < 50; i++) { const s = await ev('window.__m4?JSON.stringify(window.__m4):""'); if (s) { m4 = JSON.parse(s); break; } await new Promise((r) => setTimeout(r, 250)); }
if (!m4) { console.log('FAIL: no window.__m4 (map.html did not load)'); process.exit(1); }
if (m4.error) { console.log('FAIL: tile app error —', m4.error, '(run `node browser/bake_tiles.mjs`)'); process.exit(1); }

let ok = true;
const total = m4.total;
console.log(`  region: ${total} tiles (baked)`);
const goto = async (lat, lon, z) => JSON.parse(await ev(`window.__tiles.gotoAndLoad(${lat},${lon},${z}).then((r)=>JSON.stringify(r))`) || '{}');

// Zoom into a sub-region — the working set must be a strict, non-empty subset of the region.
const A = await goto(52.245, 6.905, 16);
console.log(`  zoom-in @16: ${A.loaded}/${total} tiles · feats ${JSON.stringify(A.feats)}`);
if (!(A.loaded > 0 && A.loaded < total)) { console.log('FAIL: working set is not a strict subset of the region'); ok = false; } else console.log(`  ✓ viewport loads only ${A.loaded}/${total} tiles (working set)`);
if (!(A.feats.areas > 0 && A.feats.buildings > 0 && A.feats.streets > 0)) { console.log('FAIL: core layers did not render from tiles'); ok = false; } else console.log('  ✓ terrain + buildings + streets render from tiles');

// Pan to a different sub-region — a different set of tiles must load.
const B = await goto(52.305, 6.925, 16);
const overlap = A.keys.filter((k) => B.keys.includes(k)).length;
console.log(`  pan @16: ${B.loaded}/${total} tiles · overlap with prev ${overlap}`);
if (!(B.loaded > 0 && overlap < A.keys.length)) { console.log('FAIL: panning did not change the loaded tile set'); ok = false; } else console.log('  ✓ panning loads a different working set (incremental)');

// Zoom out to the whole region — now (nearly) all tiles are in view: working set scales up with the view.
const W = await goto((A.feats ? 52.27 : 52.27), 6.90, 11);
console.log(`  zoom-out @11: ${W.loaded}/${total} tiles`);
if (!(W.loaded > A.loaded)) { console.log('FAIL: zooming out did not enlarge the working set'); ok = false; } else console.log(`  ✓ working set scales with the viewport (${A.loaded} → ${W.loaded})`);

console.log(ok ? 'PASS — M4: whole-region tiled working set (viewport-scoped loading) verified headless.' : 'FAILURES');
process.exit(ok ? 0 : 1);
