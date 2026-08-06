// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-SCALE §6f F1+F2's observable: does the app draw a base map it never downloaded whole, and does
// the cost of the NEXT viewport stay the cost of a viewport as the working set grows?
//
// It runs the SAME camera path twice against the SAME block — once with the base map read WHOLE (what
// ships today) and once PAGED — and compares what got drawn, viewport by viewport. That comparison is
// the point: a paged read that silently drops features is exactly the failure this rung exists to
// prevent, and it looks identical to success from every other angle (no error, no exception, a map that
// merely has less on it — which is how the blank map shipped in the first place).
//
// What it asserts, and what each would catch:
//   F1  the layout really is read by RANGE — rangeReads > 0 and only a fraction of the store fetched.
//       A `store_load_keys` that quietly fell back to a whole load passes every count check below.
//   F1  every viewport draws within LOSS_MAX of the whole-load run, per kind. The residual is REAL and
//       measured (tools/layout_page_probe.loft): a layout feature is keyed by its first vertex and
//       overhangs its cell, so a padded window still misses a few very wide ones. The bound is what
//       stops that becoming "most of the map" without anyone noticing.
//   F2  the expose bracket stays balanced — releases == exposes - 1. A paged load WRITES to the store,
//       and `expose` pins it read-only; loading under the pin traps silently in wasm.
//   F2  per-viewport cost does not grow with the working set. `expose` is O(collection) per call and
//       the collection is now growing, so this is the one number that could make the whole design
//       unviable (§6f's stated risk). Reported as a series, not an average.
//
// ⚠ The milliseconds here are NOT a latency claim. They are unthrottled and fetched over loopback, so
// they flatter a phone on mobile data several times over (CLAUDE.md: profile with CPU_THROTTLE=4). What
// this gate asserts is the RATIO — later viewport / earlier viewport — which is what an O(collection)
// re-expose would blow up and which survives both distortions. For an honest per-interaction cost, use
// tools/map_profile.sh; for the BYTES a viewport really costs, tools/layout_page_probe.loft `pageload`.
//
//   node browser/cdp_base_paged.mjs <devtools host:port> <app url> [config json]
//
// The optional config switches data set and question:
//   {"mode":"paged","start":{...},"waypoints":[...]}   render-only, for a store too big to load WHOLE —
//                                                       which is the case the whole rung exists for, and
//                                                       where there is no whole-load run to compare to.
import { launch } from './cdp_transport.mjs';
const [profile, app, cfgJson] = process.argv.slice(2);
const cfg = cfgJson ? JSON.parse(cfgJson) : {};
const COMPARE = cfg.mode !== 'paged';

// The camera walk: the app's own start, then a boustrophedon over the block's interior.
//
// ⚠ THE STEP HAS TO LEAVE THE LOADED BOX OR NOTHING HAPPENS. `ensureViewNow` loads only when the
// viewport+5% escapes the box it last loaded, which was padded by 60% — at z16 that is ~0.0124° of
// longitude, so a "pan" smaller than that returns without a view and the gate measures the same
// viewport twelve times. (First version of this file did exactly that.) The waypoints are also kept
// INSIDE the Enschede block's own extent: two runs that both draw nothing compare equal.
const START = cfg.start || { lat: 52.2215, lon: 6.8937, zoom: 16 };
const WAYPOINTS = cfg.waypoints || [];
if (!WAYPOINTS.length) {
  for (const [ri, lat] of [52.19, 52.24, 52.29].entries()) {
    const lons = [6.80, 6.86, 6.92, 6.98];
    for (const lon of (ri % 2 ? [...lons].reverse() : lons)) WAYPOINTS.push({ lat, lon });
  }
}
// THE RESIDUAL IS REAL, AND THIS IS A REGRESSION BOUND, NOT A CLEAN BILL OF HEALTH.
//
// `map_kernel::LAYOUT_PAD` widens the fetch window by one cell because a layout feature is keyed by its
// first vertex and overhangs its own cell — and one cell is not enough for all of them. Measured with
// tools/layout_page_probe.loft: exactness needs 11 cells for a z16 viewport of Amsterdam and 50 for a
// z14 one, i.e. fetching the region. So a paged base map draws slightly less than a whole one, today,
// by construction. What removes it is bounding a feature's reach at GENERATION (PLAN-SCALE §6f F3), not
// a bigger window here.
//
// Two bounds, because one number cannot hold both ends of the distribution:
//   * AGG — the aggregate over every viewport and kind. This is the honest "how much of the map is
//     missing" figure, and the one a retiering must drive to zero.
//   * ABS — the worst single (viewport, kind) drop in absolute features. A dense viewport losing 40
//     buildings is a broken render path; a rural viewport losing its 4 lines is the known residual, and
//     a percentage bound would call the second one catastrophic and the first one fine.
const LOSS_AGG_MAX = 0.01;
const LOSS_ABS_MAX = 20;

// ⚠ PHASE 1's RESIDUAL IS A PROPERTY OF THE SHIPPED BLOCK, NOT OF THE READER. Since PLAN-SCALE §6f F3
// the reader pads the LOW side of each tier's window only, which is exactly right for a store whose
// features are keyed at their bbox's minimum corner — and `browser/stores/enschede.layout.store` was
// built before that and keys by first vertex, so its features reach both ways. The residual on it grew
// from 7 features to 12 when the reader changed; the four NL regions, built by the current generator,
// measure ZERO (tools/layout_page_probe.loft `verify`, bound 0).
//
// So this bound is a REGRESSION guard on a legacy artifact, and the way to retire it is to regenerate
// that block (tools/build-blocks.sh + build-base.sh for its bbox, then copy the layout store into
// browser/stores/ and refresh the index) — not to widen it further.
// A late viewport may legitimately cost more than the first (a denser part of town), but not
// PROPORTIONALLY more — that is what an O(working set) re-expose would look like.
const GROWTH_MAX = 3.0;

const browser = await launch({ bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: profile });
const { call, errors: errs } = browser;
await call('Runtime.enable'); await call('Page.enable');
// PLAN-EDIT E9 — the sketch autosave lives in localStorage, and every gate reuses its chromium
// --user-data-dir, so one run's sketch would restore into the next one's assertions. Cleared here, in
// EVERY driver, and map_render_gate checks the line is present: the app's camera comment predicted
// the "eighth one forgets" case exactly, so it is closed by a check rather than by discipline.
await call('Storage.clearDataForOrigin', { origin: new URL(app).origin, storageTypes: 'local_storage' });

const ev = async (x) => {
  const r = await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
};
const evj = async (x) => { const s = await ev(x); return typeof s === 'string' && s ? JSON.parse(s) : s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One run of the camera path. `mode` is forced into the page BEFORE its module runs — the app reads
// `window.__baseReadMode` at load and never again, which is what lets a gate page a block whose index
// says "whole" without a second dataset.
async function run(mode) {
  const boot = await call('Page.addScriptToEvaluateOnNewDocument', {
    // ⚠ AND THE DEVICE TIER IS PINNED. The tier decides `viewPad`, which decides the BOX a view reads —
    // so with it free, the two arms of this diff can look at different ground and the comparison means
    // nothing. It reported exactly that ("the two runs looked at different boxes") the moment the pad
    // started following a measurement. A gate that compares two runs has to fix every input that is not
    // the thing under test.
    source: `window.__baseReadMode = ${JSON.stringify(mode)}; window.__deviceTier = 'full';`,
  });
  // ⚠ VIA about:blank. The app writes the camera into `location.hash`, so by the end of a run the URL
  // differs from the next run's only in its FRAGMENT — and navigating between two URLs that differ only
  // there does not reload the document. The second run then inherits the first's page, its read mode and
  // its `__storeApp`, and reports the first run's last viewport as its own first.
  await call('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await call('Page.navigate', { url: `${app}#${START.zoom}/${START.lat}/${START.lon}` });
  let st = null;
  for (let i = 0; i < 200; i++) {
    await sleep(250);
    st = await evj('window.__storeApp?JSON.stringify(window.__storeApp):""');
    if (st?.ready && st?.viewSeq) break;
  }
  // Ready AND having drawn once: `ready` is set when the module finishes wiring, which is before the
  // first view completes. Proceeding on `ready` alone would compare a viewport that had not rendered.
  if (!st?.ready || !st?.viewSeq) {
    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: boot.result.identifier });
    return { mode, fail: st?.ready ? 'app never completed its first view' : 'app never became ready', st };
  }

  const views = [];
  // WAIT FOR THE APP TO STOP WORKING BEFORE READING ITS COUNTERS. The view being complete no longer means
  // the kernel is idle: the ring prefetch keeps paging the surrounding screens after the view has
  // reported. A snapshot taken mid-command sees the `expose` bracket balanced — loft releases the pin at
  // the start of a call and re-takes it at the end — and F2 then reports a missing pin that is simply a
  // command in flight. Bounded, and it SAYS SO when it gives up: a silent timeout here would turn this
  // check back into the ill-timed read it exists to prevent.
  let settleTimeouts = 0;
  const settle = async () => {
    for (let i = 0; i < 120; i++) {
      if (await evj('JSON.stringify(!!window.__perfHooks?.settled?.())') === true) return true;
      await sleep(250);
    }
    settleTimeouts++;
    return false;
  };
  const snap = async () => {
    await settle();
    return await evj(`JSON.stringify({
      seq: window.__storeApp?.viewSeq || 0, bbox: window.__storeApp?.viewBbox || '',
      ms: window.__storeApp?.lastViewMs || 0, counts: window.__storeApp?.layerCounts || {},
      view: window.__storeApp?.view || '',
      stats: window.__perfHooks?.kernelStats?.() || null,
      ring: window.__perfHooks?.ringStats?.() || null,
      exposes: globalThis.__exposeCalls || 0, releases: globalThis.__releaseCalls || 0,
    })`);
  };
  views.push(await snap());

  for (const { lat, lon } of WAYPOINTS) {
    // The PREVIOUS successful view's sequence — never a stalled entry's -1, which would make the next
    // wait return instantly and snapshot the viewport before it had rendered.
    const before = Math.max(...views.map((v) => v.seq));
    await ev(`(() => { const m = window.__map0; m.camera.lat = ${lat}; m.camera.lon = ${lon}; m._fireMove(); return 1; })()`);
    let got = null;
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      const cur = await evj('JSON.stringify({seq: window.__storeApp?.viewSeq || 0})');
      if (cur.seq > before) { await sleep(120); got = await snap(); break; }
    }
    if (!got) { views.push({ seq: -1, bbox: `${lat},${lon}`, ms: 0, counts: {}, stalled: true }); continue; }
    views.push(got);
  }
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: boot.result.identifier });
  return { mode, views, settleTimeouts };
}

const whole = COMPARE ? await run('whole') : null;
const paged = await run('paged');
const fail = [];
for (const r of [whole, paged]) if (r && r.fail) fail.push(`${r.mode}: ${r.fail}`);

// RENDER-ONLY: a store that cannot be loaded whole has no reference run, so the question is not "as much
// as the whole load" but "anything at all, from bytes it fetched by range". That is F1's own observable,
// and it is the one a blank map fails.
if (!COMPARE && !fail.length) {
  const kinds = ['areas', 'buildings', 'lines', 'pois', 'places', 'streetLabels'];
  let prev = 0, drawnAny = 0;
  console.log('   #  bbox                              drawn                                          ms   fetched');
  for (const [i, p] of paged.views.entries()) {
    if (p.stalled) { fail.push(`viewport ${i} never rendered`); continue; }
    const shown = kinds.map((k) => `${k} ${p.counts[k] || 0}`).filter((s) => !s.endsWith(' 0')).join(' ');
    const total = kinds.reduce((n, k) => n + (p.counts[k] || 0), 0);
    drawnAny += total;
    const kb = p.stats ? Math.round(p.stats.rangeBytes / 1024) : 0;
    console.log(`  ${String(i).padStart(2)}  ${p.bbox.padEnd(33)} ${(shown || 'NOTHING').padEnd(44)} ${String(Math.round(p.ms)).padStart(5)} ${String(kb - prev).padStart(6)} kB`);
    prev = kb;
    if (total === 0) fail.push(`viewport ${i} drew NOTHING — that is the blank map this rung exists to fix`);
  }
  const st = paged.views[paged.views.length - 1]?.stats || {};
  console.log(`\n  F1 · ${drawnAny} features drawn across ${paged.views.length} viewports, ` +
              `${st.rangeReads || 0} range requests, ${((st.rangeBytes || 0) / 1048576).toFixed(1)} MB fetched`);
  if (!(st.rangeReads > 0)) fail.push('no range reads — nothing was paged');
}

if (COMPARE && !fail.length) {
  const kinds = ['areas', 'buildings', 'lines', 'pois', 'places', 'streetLabels'];
  console.log(`  camera path: ${whole.views.length} viewports, ${START.zoom}/${START.lat}/${START.lon} marching NE`);
  console.log('   #  bbox                              whole → paged (per kind)                     ms   fetched');
  let drawnWhole = 0, drawnPaged = 0, worstAbs = 0, worstAt = '';
  let prevKb = 0;
  for (let i = 0; i < Math.min(whole.views.length, paged.views.length); i++) {
    const w = whole.views[i], p = paged.views[i];
    if (w.stalled || p.stalled) { fail.push(`viewport ${i} never rendered (${w.stalled ? 'whole' : ''}${p.stalled ? ' paged' : ''} run)`); continue; }
    if (w.bbox !== p.bbox) { fail.push(`viewport ${i}: the two runs looked at different boxes (${w.bbox} vs ${p.bbox})`); continue; }
    const diffs = [];
    for (const k of kinds) {
      const a = w.counts[k] || 0, b = p.counts[k] || 0;
      if (a === 0 && b === 0) continue;
      drawnWhole += a; drawnPaged += Math.min(a, b);
      const drop = a - b;
      if (drop > worstAbs) { worstAbs = drop; worstAt = `${k} @ viewport ${i} (${a} → ${b})`; }
      if (drop > LOSS_ABS_MAX) fail.push(`viewport ${i}: ${k} lost ${drop} features paged (${a} → ${b}) — beyond the known overhang residual`);
      if (b > a) diffs.push(`${k} ${a}→${b}(+)`); else if (b < a) diffs.push(`${k} ${a}→${b}`);
    }
    const kb = p.stats ? Math.round(p.stats.rangeBytes / 1024) : 0;
    console.log(`  ${String(i).padStart(2)}  ${p.bbox.padEnd(33)} ${(diffs.join(' ') || 'identical').padEnd(44)} ${String(Math.round(p.ms)).padStart(5)} ${String(kb - prevKb).padStart(6)} kB`);
    prevKb = kb;
  }
  const aggLoss = drawnWhole > 0 ? (drawnWhole - drawnPaged) / drawnWhole : 0;
  if (aggLoss > LOSS_AGG_MAX) {
    fail.push(`the paged run drew ${(aggLoss * 100).toFixed(2)}% less of the map than the whole one ` +
              `(${drawnWhole - drawnPaged} of ${drawnWhole} features), past the ${LOSS_AGG_MAX * 100}% residual bound`);
  }

  const last = paged.views[paged.views.length - 1];
  const st = last?.stats || {};
  console.log(`\n  F1 · range reads: ${st.rangeReads || 0} requests, ${((st.rangeBytes || 0) / 1048576).toFixed(2)} MB fetched across ${paged.views.length} viewports`);
  console.log(`  F1 · drawn: ${drawnPaged}/${drawnWhole} features, ${(aggLoss * 100).toFixed(2)}% short of the whole-load run (bound ${LOSS_AGG_MAX * 100}%)`);
  console.log(`  F1 · worst single drop: ${worstAbs} features${worstAt ? ` — ${worstAt}` : ''} (bound ${LOSS_ABS_MAX})`);
  if (!(st.rangeReads > 0)) {
    fail.push('no range reads — the layout was not paged at all (a silent whole-file fallback looks like this)');
  }
}

// F2 applies to every paged run, comparison or not: the pin comes off and back on around each load, and
// `expose` is O(collection) over a collection that now grows.
if (paged?.views?.length) {
  // First and last thirds of the walk, medians, so one slow viewport does not decide it.
  const last = paged.views[paged.views.length - 1];
  const ms = paged.views.filter((v) => !v.stalled).map((v) => v.ms).slice(1);
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const head = med(ms.slice(0, Math.ceil(ms.length / 3))), tail = med(ms.slice(-Math.ceil(ms.length / 3)));
  const growth = head > 0 ? tail / head : 0;
  console.log(`  F2 · per-viewport cost: first third ${head.toFixed(0)} ms → last third ${tail.toFixed(0)} ms (${growth.toFixed(2)}×, bound ${GROWTH_MAX}×)`);
  console.log(`  F2 · expose bracket: ${last?.exposes} exposes / ${last?.releases} releases (want releases == exposes - 1)`);
  if (last?.ring) console.log(`  F2 · ring: ${last.ring.done}/${last.ring.planned} cell(s) paged${last.ring.skipped ? `, ${last.ring.skipped} skipped (whole)` : ''}${last.ring.abandoned ? `, ${last.ring.abandoned} abandoned` : ''}${last.ring.rebuilt ? `, ${last.ring.rebuilt} index rebuild(s)` : ''}${last.ring.promoted ? `, promoted: ${last.ring.promoted}` : ''}`);
  // A snapshot that gave up waiting is an ill-timed read, and every count above it is suspect. Fail on it
  // rather than reporting numbers whose provenance is "the app was probably done".
  if (paged.settleTimeouts) {
    fail.push(`${paged.settleTimeouts} snapshot(s) timed out waiting for the kernel to go idle — the counters below were read mid-command`);
  }
  if (growth > GROWTH_MAX) {
    fail.push(`per-viewport cost grew ${growth.toFixed(2)}× across the walk — that is the O(collection) re-expose ` +
              `§6f warned about; the fallback is JS reading pages directly, never a decoder of our own`);
  }
  if (last && last.exposes && last.releases !== last.exposes - 1) {
    fail.push(`expose bracket unbalanced: ${last.exposes} exposes vs ${last.releases} releases — loft is touching a store it has pinned`);
  }
}

if (errs.length) console.log(`  page errors: ${errs.slice(-3).join(' | ')}`);
if (fail.length) { console.log('\nFAIL\n  - ' + fail.join('\n  - ')); process.exit(1); }
console.log('\nPASS — the base map renders from a store read by RANGE, and the next viewport still costs a viewport');
process.exit(0);
