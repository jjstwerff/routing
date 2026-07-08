// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// Headless-Chromium verifier for PLAN-MAP M0 (browser/map-demo.html over file://): the projection +
// render + resize invariant on a REAL canvas.  node browser/cdp_verify_map.mjs <dt-host:port> <file-url>
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

let m0 = null;
for (let i = 0; i < 40; i++) { const s = await ev('window.__m0?JSON.stringify(window.__m0):""'); if (s) { m0 = JSON.parse(s); break; } await new Promise((r) => setTimeout(r, 250)); }
if (!m0) { console.log('FAIL: no window.__m0 (module did not load — file:// module CORS? render error?)'); process.exit(1); }

let ok = true;
console.log(`  viewport ${m0.W}×${m0.H} @${m0.dpr}x · centre (${m0.center.x.toFixed(1)},${m0.center.y.toFixed(1)}) · bg ${JSON.stringify(m0.bg)}`);
if (!m0.centerOK) { console.log('FAIL: camera centre does not project to the viewport centre'); ok = false; } else console.log('  ✓ centre projects to viewport centre (real canvas)');
if (!(m0.roundtripDeg < 1e-6)) { console.log('FAIL: unproject∘project error ' + m0.roundtripDeg); ok = false; } else console.log(`  ✓ round-trip ${m0.roundtripDeg.toExponential(1)}°`);
if (!m0.rendered) { console.log('FAIL: canvas centre pixel not opaque — render() did not paint'); ok = false; } else console.log('  ✓ render() painted the canvas');

// Resize: change the viewport, resize+render, the centre must stay centred.
await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 640, deviceScaleFactor: 1, mobile: false });
const r2 = await ev('(()=>{window.__map.resize();window.__map.render();const c=window.__map.project(window.__map.camera.lat,window.__map.camera.lon);return JSON.stringify({W:window.__map.width,H:window.__map.height,x:c.x,y:c.y});})()');
const j = JSON.parse(r2 || '{}');
const rOK = Math.abs(j.x - j.W / 2) < 1e-6 && Math.abs(j.y - j.H / 2) < 1e-6;
if (!rOK) { console.log('FAIL: resize did not keep the centre centred — ' + r2); ok = false; } else console.log(`  ✓ resize keeps the centre centred (${j.W}×${j.H})`);

console.log(ok ? 'PASS — M0 canvas renderer: projection + render + resize verified headless.' : 'FAILURES');
process.exit(ok ? 0 : 1);
