// Headless-Chromium verifier for the loft-native browser app: load the page, wait for the in-browser
// wasm match, assert the route is byte-identical to the native reference, and exercise interactivity
// (a synthetic click must re-match). Driven over the DevTools protocol.
//   node browser/cdp_verify.mjs <dt-host:port> <page-url> <ref-file>
import { readFileSync } from 'node:fs';
const [dt, app, refFile] = process.argv.slice(2);
const refLine = readFileSync(refFile, 'utf8').trim().split('\n')[1] || '';
setTimeout(() => { console.log('[hard-timeout]'); process.exit(3); }, 30000);

const list = await (await fetch(`http://${dt}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
await call('Page.navigate', { url: app });
const ev = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

let m = null;
for (let i = 0; i < 50; i++) { const s = await ev('window.__match?JSON.stringify(window.__match):""'); if (s) { m = JSON.parse(s); break; } await new Promise((r) => setTimeout(r, 300)); }
if (!m) { console.log('FAIL: no window.__match'); process.exit(1); }
if (m.error) { console.log('FAIL: page error —', m.error.split('\n')[0]); process.exit(1); }
console.log('  default match:', m.summary);

let ok = true;
if (m.routeCount < 2) { console.log('FAIL: empty route'); ok = false; }
if (m.polyline !== refLine) { console.log('FAIL: polyline != native reference'); ok = false; } else console.log(`  polyline byte-identical to native (${m.routeCount} pts)`);

// PLAN-BASEMAP S7: our own terrain fills (the "Terrain (our data)" base) should draw from areas.txt.
const areasN = await ev('window.__areas ? window.__areas.count : -1');
if (areasN > 0) console.log(`  terrain: ${areasN} area fills drawn (S7 — our self-contained base)`);
else console.log('  terrain: none (areas.txt absent — S7 render skipped)');
const bldN = await ev('window.__buildings ? window.__buildings.count : -1');
if (bldN > 0) console.log(`  buildings: ${bldN} footprints drawn (S8)`);
else console.log('  buildings: none (buildings.txt absent — S8 render skipped)');
const plN = await ev('window.__places ? window.__places.count : -1');
if (plN > 0) console.log(`  places: ${plN} rank-gated labels (S9)`);
else console.log('  places: none (places.txt absent — S9 render skipped)');
const stN = await ev('window.__streets ? window.__streets.count : -1');
if (stN > 0) console.log(`  streets: ${stN} centerlines (S10 — labels repeat along the line on zoom)`);
else console.log('  streets: none (streets.txt absent — S10 render skipped)');
const stamp = await ev('window.__stamp || (document.getElementById("freshness")||{}).textContent || ""');
if (stamp && /\d{4}-\d\d-\d\d/.test(stamp)) console.log(`  freshness: "${String(stamp).trim()}" (S12)`);
else console.log('  freshness: no date rendered (S12)');
const gen = await ev('window.__gen ? JSON.stringify(window.__gen) : ""');
if (gen) console.log(`  generalization: ${gen} (S13 — buildings ≥z14, small areas drop out zoomed out)`);

// PLAN-BASEMAP S14: on the terrain base at a town zoom, the collision layout must leave NO two labels
// overlapping. (Then restore OSM base + fit so the later profile/click/offline checks are unaffected.)
await ev(`(()=>{try{const b=window.__bases;window.__map.removeLayer(b.osm);b.terrain.addTo(window.__map);window.__map.setView([52.304,6.917],16);}catch(e){}})()`);
await new Promise((r) => setTimeout(r, 1600));
const lbl = await ev(`(()=>{const rs=[...document.querySelectorAll('.plabel span,.slabel span')].map(e=>e.getBoundingClientRect()).filter(r=>r.width>0);let ov=0;for(let i=0;i<rs.length;i++)for(let j=i+1;j<rs.length;j++){const a=rs[i],b=rs[j];if(!(a.right<b.left||a.left>b.right||a.bottom<b.top||a.top>b.bottom))ov++;}return{labels:rs.length,overlaps:ov};})()`);
if (lbl && lbl.overlaps === 0) console.log(`  labels: ${lbl.labels} on terrain base, 0 overlaps (S14 collision layout)`);
else { console.log(`  FAIL: ${lbl ? lbl.overlaps : '?'} label overlaps (S14)`); ok = false; }
await ev(`(()=>{try{const b=window.__bases;window.__map.removeLayer(b.terrain);b.osm.addTo(window.__map);}catch(e){}})()`);

// Profile selector: switch to walking_paved on the same sketch — the route must change and re-match.
await ev(`(()=>{const s=document.getElementById('profile');s.value='walking_paved';s.dispatchEvent(new Event('change'));})()`);
let mp = null;
for (let i = 0; i < 25; i++) { const s = await ev('window.__match?JSON.stringify(window.__match):""'); if (s) { const j = JSON.parse(s); if (/profile=walking_paved/.test(j.summary)) { mp = j; break; } } await new Promise((r) => setTimeout(r, 200)); }
console.log('  profile → walking_paved:', (mp && mp.summary) || '(no re-match)');
if (!mp) { console.log('FAIL: profile change did not re-match'); ok = false; }
else if (mp.routeCount === m.routeCount) { console.log('FAIL: route unchanged across profiles'); ok = false; }
else console.log('  ✓ profile selector re-matched (route changed with profile)');
// Restore the default profile so the offline-reload assertions compare against the cycling_road reference.
await ev(`(()=>{const s=document.getElementById('profile');s.value='cycling_road';s.dispatchEvent(new Event('change'));})()`);

// Interactivity: clear, then a synthetic map click must produce a (different) sketch state.
await ev('document.getElementById("clear").click(); window.__match=null;');
const before = await ev('(document.getElementById("status")||{}).textContent');
await ev(`window.__map.fire('click',{latlng:{lat:52.255,lng:6.905}})`);
const after = await ev('window.__match?JSON.stringify(window.__match):(document.getElementById("status")||{}).textContent');
console.log('  after 1 click:', String(after).slice(0, 80));
if (before === after) { console.log('FAIL: click did not change state'); ok = false; } else console.log('  interactive click re-ran the matcher');

// Fully offline: wait for the service worker to control the page, drop the network entirely, reload.
// The SW must serve the shell + wasm and IndexedDB the dataset — a real no-network reload.
let swReady = false;
for (let i = 0; i < 40; i++) { if ((await ev('!!(navigator.serviceWorker && navigator.serviceWorker.controller)')) === true) { swReady = true; break; } await new Promise((r) => setTimeout(r, 300)); }
if (!swReady) { console.log('FAIL: service worker never took control'); ok = false; }
await call('Network.enable');
await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await call('Page.reload', {});
let m2 = null;
for (let i = 0; i < 60; i++) { const s = await ev('window.__match?JSON.stringify(window.__match):""'); if (s) { m2 = JSON.parse(s); break; } await new Promise((r) => setTimeout(r, 300)); }
const cache = await ev('window.__cache?JSON.stringify(window.__cache):""') || '';
console.log('  offline reload (network fully OFF):', (m2 && m2.summary) || '(no match)', '| source:', cache);
if (!m2 || m2.error) { console.log('FAIL: fully-offline reload produced no match (SW/IndexedDB miss)'); ok = false; }
else if (m2.routeCount !== 90 || !/cached/.test(cache)) { console.log('FAIL: offline reload wrong route or not served from cache'); ok = false; }
else console.log('  ✓ matched with the network fully OFF (SW shell + IndexedDB data)');

console.log(ok ? 'PASS — loft-native browser app functions online AND fully offline (service worker + IndexedDB), byte-identical to native.' : 'FAILURES');
process.exit(ok ? 0 : 1);
