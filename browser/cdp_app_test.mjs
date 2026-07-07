// Headless-Chromium verifier for the browser shell (PLAN-APP Track 1a–c): load the page, wait for
// the in-browser wasm match to finish, and assert it produced the expected route. Driven over the
// DevTools protocol (same pattern as tools/cdp_routes.mjs).
//   node browser/cdp_app_test.mjs [devtools-host:port] [app-url] [expected-route-file]
import { readFileSync } from 'node:fs';

const dt = process.argv[2] || '127.0.0.1:9224';
const app = process.argv[3] || 'http://127.0.0.1:8099/browser/';
const expectFile = process.argv[4];   // optional: file whose 2nd line is the expected polyline

const targets = await (await fetch(`http://${dt}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.log('FAIL: no page target'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (method, params) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await call('Page.enable');
await call('Runtime.enable');
await call('Page.navigate', { url: app });

const evaluate = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) { console.log('FAIL: JS exception', JSON.stringify(r.result.exceptionDetails).slice(0, 400)); process.exit(1); }
  return r.result?.result?.value;
};

// Poll window.__match (the page sets it when the wasm match resolves or errors).
let match = null;
for (let i = 0; i < 60; i++) {
  match = await evaluate('window.__match ? JSON.stringify(window.__match) : ""');
  if (match) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!match) { console.log('FAIL: timed out waiting for window.__match'); process.exit(1); }
const m = JSON.parse(match);
if (m.error) { console.log('FAIL: page error —', m.error.split('\n')[0]); process.exit(1); }

console.log('  browser:', m.summary);
let ok = true;
if (m.routeCount < 2) { console.log(`FAIL: route too short (${m.routeCount} pts)`); ok = false; }

if (expectFile) {
  const expected = readFileSync(expectFile, 'utf8').trim().split('\n')[1] || '';
  if (m.polyline !== expected) { console.log('FAIL: browser polyline != reference (wasmtime/native)'); ok = false; }
  else console.log(`  polyline byte-identical to reference (${m.routeCount} pts)`);
}

if (ok) { console.log('PASS — full matcher ran in headless Chromium, whole-file test set, no server.'); process.exit(0); }
process.exit(1);
