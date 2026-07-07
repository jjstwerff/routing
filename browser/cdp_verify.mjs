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

// Interactivity: clear, then a synthetic click must produce a (different) match state.
await ev('document.getElementById("clear").click(); window.__match=null;');
const before = await ev('(document.getElementById("status")||{}).textContent');
await ev(`(()=>{const svg=document.getElementById('map');const r=svg.getBoundingClientRect();
  const e=new PointerEvent('pointerdown',{clientX:r.left+r.width*0.3,clientY:r.top+r.height*0.5,bubbles:true});
  svg.dispatchEvent(e);})()`);
const after = await ev('window.__match?JSON.stringify(window.__match):(document.getElementById("status")||{}).textContent');
console.log('  after 1 click:', String(after).slice(0, 80));
if (before === after) { console.log('FAIL: click did not change state'); ok = false; } else console.log('  interactive click re-ran the matcher');

console.log(ok ? 'PASS — loft-native browser app functions (fetch → match in wasm → draw), byte-identical to native.' : 'FAILURES');
process.exit(ok ? 0 : 1);
