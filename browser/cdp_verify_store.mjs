// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// Headless-Chromium gate for the standalone store app (browser/index.html, PLAN-BUILD): loads the site over
// HTTP (the app fetches its stores by URL, so same-origin http, not file://), proves `view <bbox>` renders
// the region on load, then drives a `match` and proves the route draws.
//   node browser/cdp_verify_store.mjs <dt-host:port> <http-url>
const [dt, app] = process.argv.slice(2);
setTimeout(() => { console.log('  FAIL: hard timeout'); process.exit(3); }, 90000);

const list = await (await fetch(`http://${dt}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = [];
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

await call('Page.navigate', { url: app });
let ok = true;

// 1. view <bbox> renders the visible region on load.
let st = null;
for (let i = 0; i < 160; i++) { await new Promise((r) => setTimeout(r, 500)); const s = await ev('window.__storeApp?JSON.stringify(window.__storeApp):""'); if (s) { st = JSON.parse(s); if (st.viewOk || st.ready) break; } }
if (!st || !st.viewOk) { console.log('  FAIL: view <bbox> did not render —', JSON.stringify(st), errs.slice(-2)); ok = false; }
else console.log(`  ✓ view <bbox> rendered on load (${st.view})`);

// 2. a match draws the matched route.
const sum = await ev('window.__match?window.__match([[52.2412299,6.8834496],[52.2694705,6.9164085],[52.3116272,6.9088554]]):""');
const s2 = JSON.parse((await ev('JSON.stringify(window.__storeApp||{})')) || '{}');
if (!s2.matchOk || !(s2.routePts > 2)) { console.log('  FAIL: match/route —', sum, JSON.stringify(s2)); ok = false; }
else console.log(`  ✓ match drew the route (${sum}, ${s2.routePts} pts)`);

console.log(ok ? 'PASS — store app renders + routes in-browser (no server)' : 'FAIL — store app gate');
process.exit(ok ? 0 : 1);
