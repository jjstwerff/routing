// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-LAYERS §4 — DOES THE SIGNPOSTED NETWORK SURVIVE A ZOOM STEP?
//
// The reported bug, at #17.24/52.07561/6.42878: "the inner paths disappear under 15 but a lot of them
// also don't". Measured on the live site at that camera, walking profile, signposted ways keeping their
// band: 96/96 at z16, 173/173 at z15.05, and 137/241 at z14.6 — half a network, which reads as a scatter
// of disconnected stubs rather than as "less detail".
//
// The cause is a rule from the WRONG LAYER: a route's visibility was decided by the road class it happens
// to run on, so a national hiking route is drawn where it follows a `track` (debut z14) and dropped forty
// metres later where it follows a `path` (debut z15). The route did not change; the substrate did.
//
// So this asserts the invariant, at the zooms either side of every debut in ROAD_STYLES:
//
//     no signposted way in the viewport is dropped because of the class it rides on.
//
// ⚠ IT READS THE DRAW PATH, NOT THE STYLE TABLE. `map._netStats` is written by `_drawStreetsFlat` itself,
// so a fix that corrects the table while the drawing code asks a stale copy fails here. That is not
// hypothetical in this repo — the area debut ladder lived in six copies and the consolidation left the
// path that DRAWS on the old rule, with every test green (HANDOFF §0).
//
//   node browser/cdp_zoom_drop.mjs <dt-host:port> <http-url>
const [dt, app] = process.argv.slice(2);
setTimeout(() => { console.log('  FAIL: hard timeout'); process.exit(3); }, 300000);

const list = await (await fetch(`http://${dt}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
// PLAN-LAYERS §5c — the sketch autosave lives in localStorage, and every gate reuses its chromium
// --user-data-dir, so one run's sketch would restore into the next one's assertions. Cleared here, in
// EVERY driver, and map_render_gate checks the line is present: the app's camera comment predicted
// the "eighth one forgets" case exactly, so it is closed by a check rather than by discipline.
await call('Storage.clearDataForOrigin', { origin: new URL(app).origin, storageTypes: 'local_storage' });
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

// A camera over ground the shipped fixture actually covers, and dense in the classes that disagree:
// the Enschede block holds 12 960 footways, 4 118 paths, 4 274 cycleways and 1 548 tracks, with 4 543
// ways on the walking network — the same mixture the Achterhoek report is about.
const CAM = '#16/52.2215/6.8937';
await call('Page.navigate', { url: app + CAM });
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await ev('window.__storeApp?JSON.stringify(window.__storeApp):""');
  if (s && JSON.parse(s).ready) break;
}

let ok = true;
const rows = [];
// Either side of every debut a signposted way can carry: track/cycle/pedestrian at 14, path/foot/service
// at 15, platform at 16. z13.9 is below the roads band entirely and is checked by the overview gate.
for (const z of [16.0, 15.0, 14.6, 14.0]) {
  const st = JSON.parse(await ev(`(() => {
    const m = window.__map0;
    m.camera.zoom = ${z}; m._fireMove && m._fireMove();
    m.render();                                    // the stats are written BY the draw, so draw first
    return JSON.stringify(m._netStats || {});
  })()`) || '{}');
  rows.push({ z, ...st });
}
// The profile must actually be asking for a network — every row would read 0/0 for driving, and a gate
// that passes because it measured nothing is worse than no gate.
const profile = await ev('window.__map0 && window.__map0.profile');
const anyDrawn = rows.some((r) => r.drawn > 0);
if (!anyDrawn) {
  console.log(`  FAIL: no signposted way was drawn at ANY zoom (profile=${profile}) — the gate measured nothing`);
  ok = false;
}
// THE IDENTITY: every signposted way in the viewport is either drawn as network, or skipped for a reason
// that is not the class it rides on (degenerate geometry, no vertex near the screen). A shortfall is the
// bug — the ways are neither drawn nor accounted for, which is what "cut by another layer's rule" means.
for (const r of rows) {
  const lost = r.inView - r.drawn - r.skipped;
  if (lost > 0) {
    console.log(`  ✗ z${r.z.toFixed(1)}: ${lost} of ${r.inView} signposted ways in view are neither drawn nor skipped `
              + `(${r.drawn} drawn, ${r.skipped} off-screen) — the network is being cut by another layer's rule`);
    ok = false;
  } else if (lost < 0) {
    console.log(`  ✗ z${r.z.toFixed(1)}: the counts do not close (${r.drawn} drawn + ${r.skipped} skipped > ${r.inView} in view) — the instrument is wrong, not the map`);
    ok = false;
  } else {
    console.log(`  ✓ z${r.z.toFixed(1)}: the network is whole — ${r.drawn} drawn + ${r.skipped} off-screen = ${r.inView} in view`);
  }
}
console.log(ok ? 'PASS — a signposted route keeps its band at every zoom its block serves'
               : 'FAIL — the signposted network is cut by the road-class ladder');
process.exit(ok ? 0 : 1);
