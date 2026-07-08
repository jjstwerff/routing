// Headless-Chromium verifier for the SINGLE-FILE standalone app loaded over file:// — the real
// standalone proof: network is emulated fully OFF *before* navigation, so nothing can be fetched. The
// page must still load, run the embedded loft matcher in wasm, produce a route byte-identical to the
// native reference, report its data source as "embedded", and re-match on a synthetic click.
//   node browser/cdp_verify_standalone.mjs <dt-host:port> <file-url> <ref-file>
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
const ev = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

// Drop the network BEFORE loading the file:// page — a real "no server, no network" run.
await call('Network.enable');
await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await call('Page.navigate', { url: app });

let m = null;
for (let i = 0; i < 60; i++) { const s = await ev('window.__match?JSON.stringify(window.__match):""'); if (s) { m = JSON.parse(s); break; } await new Promise((r) => setTimeout(r, 300)); }
if (!m) { console.log('FAIL: no window.__match (page did not run from file://)'); process.exit(1); }
if (m.error) { console.log('FAIL: page error —', m.error.split('\n')[0]); process.exit(1); }
console.log('  default match:', m.summary);

let ok = true;
const cache = await ev('window.__cache?JSON.stringify(window.__cache):""') || '';
console.log('  data source:', cache);
if (!/embedded/.test(cache)) { console.log('FAIL: not served from the inlined assets'); ok = false; }
if (m.routeCount < 2) { console.log('FAIL: empty route'); ok = false; }
if (m.polyline !== refLine) { console.log('FAIL: polyline != native reference'); ok = false; } else console.log(`  polyline byte-identical to native (${m.routeCount} pts)`);

// Profile selector still works with everything embedded.
await ev(`(()=>{const s=document.getElementById('profile');s.value='walking_paved';s.dispatchEvent(new Event('change'));})()`);
let mp = null;
for (let i = 0; i < 25; i++) { const s = await ev('window.__match?JSON.stringify(window.__match):""'); if (s) { const j = JSON.parse(s); if (/profile=walking_paved/.test(j.summary)) { mp = j; break; } } await new Promise((r) => setTimeout(r, 200)); }
console.log('  profile → walking_paved:', (mp && mp.summary) || '(no re-match)');
if (!mp || mp.routeCount === m.routeCount) { console.log('FAIL: profile change did not re-match differently'); ok = false; }
else console.log('  ✓ profile selector re-matched');

// Interactivity: clear, then a synthetic click must produce a new match state.
await ev('document.getElementById("clear").click(); window.__match=null;');
const before = await ev('(document.getElementById("status")||{}).textContent');
await ev(`(()=>{const svg=document.getElementById('map');const r=svg.getBoundingClientRect();
  const e=new PointerEvent('pointerdown',{clientX:r.left+r.width*0.3,clientY:r.top+r.height*0.5,bubbles:true});
  svg.dispatchEvent(e);})()`);
const after = await ev('window.__match?JSON.stringify(window.__match):(document.getElementById("status")||{}).textContent');
if (before === after) { console.log('FAIL: click did not change state'); ok = false; } else console.log('  interactive click re-ran the matcher');

console.log(ok ? 'PASS — single-file standalone app runs from file:// with network OFF, byte-identical to native.' : 'FAILURES');
process.exit(ok ? 0 : 1);
