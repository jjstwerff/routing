// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-PERF §0 step 10's observable: can JS READ a tile out of the exposed layout store, and does what
// it reads match what loft reads for the same tile?
//
// Step 9 proved JS holds a descriptor. That is not the same as being able to walk it — a descriptor
// whose field offsets or type ids we misread produces plausible numbers, not an error. So this prints a
// machine-readable TILE line in `tools/tile_lookup.loft`'s exact format, and the shell wrapper diffs the
// two. Equality across the whole line (three scalars, five collection counts, one nested ring length) is
// what makes the reader trustworthy enough to render from in steps 11-13.
//
// Also asserts the CHEAP SCREEN agrees with the FULL read: `scalar()` computes a field address from the
// descriptor without materialising the element, and steps 11-13 use it to reject off-viewport tiles. If
// it silently disagreed with the full walk the filter would drop the wrong tiles.
//
//   usage: node browser/cdp_deliver.mjs <devtools host:port> <app url>
const [dt, app] = process.argv.slice(2);
const list = await (await fetch(`http://${dt}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = [];
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
const ev = async (x) => {
  const r = await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 400) };
  return r.result?.result?.value;
};
const die = (msg) => { console.log('FAIL — ' + msg); ws.close(); process.exit(1); };

await call('Page.navigate', { url: app });
let st = null;
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await ev('window.__storeApp?JSON.stringify(window.__storeApp):""');
  if (s) { st = JSON.parse(s); if (st.ready) break; }
}
if (!st?.ready) die(`app never became ready ${JSON.stringify(st)} ${errs.slice(-2)}`);

// Prefer a CONTENT-RICH tile: one with buildings exercises the nested child-record walk, where a
// sparse tile (many are label-only) would let a broken vector reader pass on all-zero counts.
let pick = null, first = null;
for (let i = 0; i < 24; i++) {
  const raw = await ev(`JSON.stringify(window.__perfHooks.readTile(${i}))`);
  if (typeof raw !== 'string') die(`readTile(${i}) threw: ${JSON.stringify(raw).slice(0, 400)}`);
  const t = JSON.parse(raw);
  if (t.err) die(`readTile(${i}): ${t.err}`);
  if (!first) first = t;
  if (t.counts.buildings > 0) { pick = t; break; }
}
const t = pick || first;
if (!t) die('readTile returned nothing for any index');
if (!pick) console.log('  NOTE: no tile with buildings in the first 24 — falling back to a sparse one');

const fail = [];
if (t.scalars.tkey !== t.full.tkey || t.scalars.ox !== t.full.ox || t.scalars.oy !== t.full.oy) {
  fail.push(`cheap scalar screen disagrees with the full read: ${JSON.stringify(t.scalars)} vs ${JSON.stringify(t.full)} ` +
            `— steps 11-13 filter the viewport with scalar(), so this would drop the wrong tiles`);
}
const want = ['tkey', 'ox', 'oy', 'areas', 'buildings', 'lines', 'labels', 'pois'];
if (want.some((f) => !t.fields.includes(f))) fail.push(`descriptor fields ${JSON.stringify(t.fields)} do not cover PTile ${JSON.stringify(want)}`);
if (!t.tiles) fail.push('exposed collection reports 0 elements');

console.log(`  tiles=${t.tiles} index=${t.index} fields=${t.fields.join(',')}`);
console.log(`  names: ${JSON.stringify(t.sampleNames)}`);
console.log(`JSTILE tkey=${t.full.tkey} ox=${t.full.ox} oy=${t.full.oy} areas=${t.counts.areas} buildings=${t.counts.buildings} ` +
            `lines=${t.counts.lines} labels=${t.counts.labels} pois=${t.counts.pois} ring0=${t.ringLen}`);
if (fail.length) die(fail.join('\n  FAIL — '));

// --- step 11: areas read from the store == areas loft serialised for the same viewport ---------------
const rawAp = await ev('window.__perfHooks.areaParity().then(JSON.stringify)');
if (typeof rawAp !== 'string') die(`areaParity threw: ${JSON.stringify(rawAp).slice(0, 400)}`);
const ap = JSON.parse(rawAp);
if (ap.err) die(`areaParity: ${ap.err}`);
console.log('\n== step 11: do store-read areas equal the text areas? ==');
console.log(`  loft emitted A=${ap.emitted} · store hits=${ap.jsHits} · store renderable=${ap.jsRenderable} · text parsed=${ap.textCount}`);
console.log(`  cover mismatches=${ap.coverMismatch} ringLen mismatches=${ap.ringLenMismatch} maxCoordDelta=${ap.maxDelta} readMs=${ap.readMs}`);
const af = [];
if (!ap.textCount) af.push('the text path parsed 0 areas — the viewport has nothing to compare');
// loft's own A= is the count it EMITTED, so it must equal the unfiltered store hits: same tiles, same
// rings, same overlap test. A drift here means the two filters disagree, not that rendering differs.
if (ap.jsHits !== ap.emitted) af.push(`store hits ${ap.jsHits} != loft's emitted A=${ap.emitted} — the overlap test diverged`);
if (ap.jsRenderable !== ap.textCount) af.push(`renderable ${ap.jsRenderable} != text-parsed ${ap.textCount}`);
if (ap.coverMismatch) af.push(`${ap.coverMismatch} areas disagree on cover — wrong field or wrong order`);
if (ap.ringLenMismatch) af.push(`${ap.ringLenMismatch} areas disagree on ring length`);
// One unit in loft's last printed decimal is 1e-6; allow exactly that, since the text side is the lossy
// one. Anything larger is a real geometry disagreement, not formatting.
if (!(ap.maxDelta <= 1e-6)) af.push(`max coordinate delta ${ap.maxDelta} exceeds the 1e-6 print precision — geometry differs`);
if (af.length) die(af.join('\n  FAIL — '));
console.log('PASS — store-read areas match loft\'s text areas: count, cover, ring length, geometry to print precision');
// Exit explicitly — the open WebSocket would otherwise keep node alive forever on the success path
// (the trap that hid in cdp_expose.mjs until step 9 made it pass for the first time).
ws.close();
process.exit(0);
