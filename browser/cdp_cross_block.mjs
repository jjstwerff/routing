// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-SCALE C2 — drive the REAL app across a block seam, in a real browser.
//
// The library property is proven natively (S8: a working set filled from two blocks routes like one), and
// the app's covering-set construction is proven in unit tests. This closes the gap between them: the
// browser running two blocks, over HTTP Range, through the same path a user's click takes.
//
// It needs no second dataset. The gate splits the shipped block into west/east halves beside it, then
// swaps the page's own coverage index for one naming both — so the SAME sketch is matched twice, once
// against the whole block and once against two, and the routes must agree.
//
//   node browser/cdp_cross_block.mjs <host:port> <page-url>
const [target, pageUrl] = process.argv.slice(2);
if (!target || !pageUrl) { console.log('usage: cdp_cross_block.mjs <host:port> <url>'); process.exit(2); }

const listTargets = async () => (await (await fetch(`http://${target}/json/list`)).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A sketch that straddles 6.90°E — west of the seam, east of it, and east again — so the corridor
// genuinely needs both halves. A sketch on one side would pass while proving nothing.
const SPEC = '52.2412299,6.8834496;52.2694705,6.9164085;52.3116272,6.9088554';
const SEAM_LON = 6.90;

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msg = { id: ++id, method, params };
  pending.set(msg.id, { resolve, reject });
  ws.send(JSON.stringify(msg));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result?.value;
};

const t = (await listTargets()).find((x) => x.type === 'page');
ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id).resolve(d.result); pending.delete(d.id); }
});

await send('Page.enable');
await send('Runtime.enable');
// ⚠ THE CAMERA IS PINNED, not inherited. `DEFAULT_CAM` opens on the whole country (PLAN-SCALE §6i O1),
// which resolves to the OVERVIEW block — so a gate that navigated bare would measure a generalised
// national map while claiming to check a city's invariants. Every driver states the camera it means.
const GATE_CAM = '#16/52.2215/6.8937';
await send('Page.navigate', { url: pageUrl + GATE_CAM });
for (let i = 0; i < 60; i++) { if (await ev('!!(window.__perfHooks && window.__perfHooks.matchSpec)')) break; await sleep(500); }
if (!(await ev('!!(window.__perfHooks && window.__perfHooks.matchSpec)'))) { console.log('  FAIL: the app never became ready'); process.exit(1); }

let ok = true;
// 1. The reference: the shipped single block.
const one = await ev(`(async () => JSON.stringify(await window.__perfHooks.matchSpec(${JSON.stringify(SPEC)})))()`);
const ref = JSON.parse(one);
console.log(`  single block : ${ref.blocks} url · ${ref.summary} · routeHash=${ref.routeHash}`);
if (ref.blocks !== 1) { console.log(`  FAIL: the reference run named ${ref.blocks} blocks, expected 1`); ok = false; }

// 2. Swap the page's index for one naming the two halves, and force paged reads (a plural covering set
// can only be paged — the kernel enforces it, and this makes the intent explicit).
await ev(`(() => {
  const idx = window.__coverage.index, b = idx.blocks[0];
  const half = (url, mnlo, mxlo) => ({ id: url, name: url, readMode: 'paged',
    roads: { url, bbox: { mnla: b.roads.bbox.mnla, mxla: b.roads.bbox.mxla, mnlo, mxlo } },
    base: b.base });
  const cut = Math.round(${SEAM_LON} * 1e7);
  idx.blocks = [half('stores/west.roads.store', b.roads.bbox.mnlo, cut - 1),
                half('stores/east.roads.store', cut, b.roads.bbox.mxlo)];
  window.__readMode = 'paged';
})()`);

const two = await ev(`(async () => JSON.stringify(await window.__perfHooks.matchSpec(${JSON.stringify(SPEC)})))()`);
const split = JSON.parse(two);
console.log(`  two blocks   : ${split.blocks} urls · ${split.summary} · routeHash=${split.routeHash}`);

if (split.blocks !== 2) {
  console.log(`  FAIL: the split run named ${split.blocks} block(s) — the covering set did not span the seam, so nothing was tested`);
  ok = false;
} else if (!split.summary || split.routeBytes < 100) {
  console.log('  FAIL: the split run produced no route at all');
  ok = false;
} else if (split.summary !== ref.summary || split.routeHash !== ref.routeHash) {
  console.log('  FAIL: the route across the SEAM differs from the single-block route');
  console.log(`        single: ${ref.summary} (${ref.routeHash})`);
  console.log(`        split : ${split.summary} (${split.routeHash})`);
  ok = false;
} else {
  const st = await ev('(() => JSON.stringify(window.__perfHooks.kernelStats()))()');
  const s = JSON.parse(st);
  console.log(`  ✓ two blocks, paged: ${s.rangeReads} range reads total; route identical to the single block`);
}

console.log(ok ? 'PASS — the app routes across a block seam exactly as it does within one block'
               : 'FAIL — cross-block browser gate');
process.exit(ok ? 0 : 1);
