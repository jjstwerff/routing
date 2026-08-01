// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// The acceptance test for a CORS host (PLAN-SCALE D2): the app on one origin, its blocks on ANOTHER,
// read by byte range.
//
// Neither GitHub surface can do this, measured 2026-07-30: release assets serve Range but send no
// Access-Control-Allow-Origin, and Pages sends the app's own origin but answers a Range request with 200
// and the whole file. So the browser has only ever read blocks same-origin, and "a CORS host would work"
// has been an assumption. This turns it into a test a candidate host either passes or fails.
//
//   node browser/cdp_cors_host.mjs <host:port> <app-url> <data-origin>
const [target, pageUrl, dataOrigin] = process.argv.slice(2);
setTimeout(() => { console.log('  FAIL: hard timeout'); process.exit(3); }, 120000);
const list = await (await fetch(`http://${target}/json/list`)).json();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠ THE CAMERA IS PINNED, not inherited. `DEFAULT_CAM` opens on the whole country (PLAN-SCALE §6i O1),
// which resolves to the OVERVIEW block — so a gate that navigated bare would measure a generalised
// national map while claiming to check a city's invariants. Every driver states the camera it means.
const GATE_CAM = '#16/52.2215/6.8937';
await call('Page.navigate', { url: pageUrl + GATE_CAM });
let st = null;
for (let i = 0; i < 90; i++) {
  await sleep(500);
  const s = await ev('window.__storeApp ? JSON.stringify(window.__storeApp) : ""');
  if (s) { st = JSON.parse(s); if (st.viewOk || st.ready) break; }
}
let ok = true;
if (!st || !st.viewOk) {
  console.log('  FAIL: the app never rendered from the cross-origin host —', JSON.stringify(st), errs.slice(-2));
  console.log('        A CORS failure looks exactly like this: the fetch is blocked, the store never loads.');
  process.exit(1);
}
console.log(`  ✓ rendered from a DIFFERENT origin (${dataOrigin}): ${st.view}`);

// The blocks must really have come from the other origin, and really by range — a host that answers 200
// would still render, having sent the whole file, and that is the failure this has to separate.
const cov = JSON.parse(await ev('JSON.stringify(window.__coverage?.block?.roads || null)') || 'null');
if (!cov || !String(cov.url).startsWith(dataOrigin)) {
  console.log(`  FAIL: the resolved block is not on the data origin (${cov && cov.url})`); ok = false;
} else console.log(`  ✓ the resolved block is the cross-origin one (${cov.url.split('/').pop()})`);

await ev("window.__readMode = 'paged'");
const m = JSON.parse(await ev(`(async () => JSON.stringify(await window.__perfHooks.matchSpec('52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554')))()`) || 'null');
const ks = JSON.parse(await ev('JSON.stringify(window.__perfHooks.kernelStats())') || 'null');
// Non-vacuity: a summary is printed even when the corridor found nothing, and "ways=0 route_pts=0" is
// exactly what a blocked cross-origin read produces. The route has to be real.
const ways = Number((m && m.summary || '').match(/ways=(\d+)/)?.[1] || 0);
const pts = Number((m && m.summary || '').match(/route_pts=(\d+)/)?.[1] || 0);
if (!m || ways < 100 || pts < 10) {
  console.log(`  FAIL: the match found nothing across the origin (${m && m.summary})`);
  console.log('        That is what a blocked read looks like — the fetch fails, the corridor is empty.');
  ok = false;
} else console.log(`  ✓ matched across it: ${m.summary}`);
if (!ks || !(ks.rangeReads > 0) || ks.rangeReads < ks.rangeAsked) {
  console.log(`  FAIL: ranges asked ${ks && ks.rangeAsked}, DELIVERED ${ks && ks.rangeReads} — the host blocked or refused reads`);
  for (const f of (ks && ks.rangeFails) || []) console.log(`        ${f.status ? 'HTTP ' + f.status : f.err} — bytes ${f.off}-${f.off + f.n - 1} of ${String(f.url).split('/').pop()}`);
  ok = false;
}
else {
  const pct = cov.bytes ? (100 * ks.rangeBytes / cov.bytes).toFixed(1) : '?';
  console.log(`  ✓ read BY RANGE across origins: ${ks.rangeReads} reads, ${(ks.rangeBytes / 1048576).toFixed(1)} MB = ${pct}% of the block`);
}
console.log(ok ? 'PASS — a CORS host serves paged blocks to the browser'
               : 'FAIL — cross-origin paged read');
process.exit(ok ? 0 : 1);
