// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// WHAT ARMS THE WASM TRAP? — HANDOFF §1 item 5's named next probe.
//
// `RuntimeError: unreachable` out of wasm, in `matchSpec`. The A/B on file pinned it to the SERIAL PAGED
// READ: prefetch off traps 3/3, prefetch on passes 4/4, same box, same binary, same blocks. And
// `wasmBytes` was 41.0 MB in BOTH arms immediately before the trapping call, which refutes the
// memory.grow hypothesis outright — the arm that dies is not the bigger one.
//
// ⚠ BUT THAT A/B HAD A LOOSE END, AND IT IS THE REASON THIS EXISTS. The trapping arm also ran one more
// kernel command (2 vs 1), so the arms differed in WORK as well as in how many reads suspended wasm. Two
// variables, one result: the trigger could have been either, and "the serial read arms it" was the
// likelier of two readings rather than a measured fact.
//
// `window.__prefetchScope` closes that. The view and the ring both prefetch through one function, so
// scoping it to one of them keeps every kernel command, every store and every byte identical and moves
// ONLY the suspend count:
//
//   both  — view and ring prefetched   (fewest suspends)
//   view  — view prefetched, ring not  (same work, more suspends)
//   ring  — ring prefetched, view not  (same work, more suspends, differently placed)
//   none  — neither                    (most suspends)
//
// If suspends arm it, `none` traps and `both` passes with `view`/`ring` ordered in between. If it is the
// work rather than the suspends, all four behave alike — and the finding on file is wrong.
//
//   node browser/cdp_trap_scope.mjs <profile-dir> <page-url> <scope>
import { launch } from './cdp_transport.mjs';

const [profile, pageUrl, scope = 'both'] = process.argv.slice(2);
if (!profile || !pageUrl) { console.log('usage: cdp_trap_scope.mjs <profile> <url> <both|view|ring|none>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({ bin: process.env.CHROMIUM_BIN || 'chromium', userDataDir: profile });
const { call, close } = browser;
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

// The trap surfaces as an uncaught exception, so it has to be collected rather than inferred from a
// missing result — a swallowed throw would read as "passed with no route".
const errors = [];
browser.on?.('Runtime.exceptionThrown', (p) => errors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || '')));

try {
  await call('Runtime.enable', {});
  await call('Page.enable', {});
  // ⚠ SET BEFORE THE APP RUNS. The boot view prefetches, so a scope applied after load has already
  // missed the reads it was meant to change.
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__prefetchScope = ${JSON.stringify(scope)};` });
  // ⚠ THE CAMERA IS PART OF THE EXPERIMENT. At the boot camera the app resolves to the OVERVIEW, a
  // `whole` store that `isPaged` deliberately excludes — so no arm prefetches anything and all four
  // report identical counters, which is what the first run of this probe did. The trap was seen over
  // Amsterdam at z14, where the stores are paged; that is the camera nl_live_gate uses and the one that
  // gives the knob something to change.
  const CAM = process.env.TRAP_CAM || '#14/52.3702/4.8952';
  // The sketch autosave lives in localStorage and every driver reuses its --user-data-dir, so one
  // run's sketch restores into the next one's assertions. map_render_gate CHECKS for this line
  // rather than trusting discipline — and it caught both of these probes on their first run.
  await call('Storage.clearDataForOrigin', { origin: new URL(pageUrl).origin, storageTypes: 'local_storage' });
  await call('Page.navigate', { url: pageUrl + CAM });

  let ready = false;
  for (let i = 0; i < 300; i++) {
    if (await ev('!!(window.__perfHooks && window.__perfHooks.settled && window.__perfHooks.settled())')) { ready = true; break; }
    await sleep(500);
  }
  if (!ready) { console.log(`  scope=${scope}  FAIL: never became ready`); process.exit(1); }

  const ran = await ev('(window.__storeApp||{}).prefetchScope');
  const before = JSON.parse(await ev('JSON.stringify(window.__perfHooks.kernelStats())') || '{}');

  const SPEC = process.env.TRAP_SPEC || '52.3702,4.8952;52.3660,4.9000;52.3625,4.9065';
  const t0 = Date.now();
  let trapped = false, res = null;
  try {
    res = await ev(`(async () => { try {
      return JSON.stringify(await window.__perfHooks.matchSpec(${JSON.stringify(SPEC)}));
    } catch (e) { return JSON.stringify({ __trap: String(e && e.message || e) }); } })()`);
  } catch (e) { trapped = true; res = JSON.stringify({ __trap: String(e && e.message || e) }); }
  const ms = Date.now() - t0;
  const after = JSON.parse(await ev('JSON.stringify(window.__perfHooks.kernelStats())') || '{}');

  let parsed = null; try { parsed = JSON.parse(res || 'null'); } catch {}
  if (parsed && parsed.__trap) trapped = true;
  if (errors.some((e) => /unreachable|RuntimeError/.test(e))) trapped = true;

  const d = (k) => (after[k] ?? 0) - (before[k] ?? 0);
  // The suspend count IS the variable: a range read that came off the wire suspended wasm; one served
  // from the prefetch buffer did not.
  const real = d('rangeReads'), hits = d('prefetchHits');
  console.log(`  scope=${scope} (app confirms "${ran}")  ${trapped ? 'TRAPPED' : 'passed'}  in ${ms} ms`);
  console.log(`    suspends: ${real} real range reads · ${hits} served from the buffer · ${d('commands')} kernel commands`);
  console.log(`    wasmBytes ${(before.wasmBytes / 1e6).toFixed(1)} -> ${(after.wasmBytes / 1e6).toFixed(1)} MB`);
  // ⚠ THE DELTA ACROSS THE MATCH IS NOT THE SESSION. The view's prefetch runs during BOOT, before the
  // `before` snapshot, so a scope that changes boot behaviour shows up nowhere in a match-window delta —
  // which is exactly how the first run of this probe reported four identical arms and measured nothing.
  console.log(`    SESSION total: ${after.rangeReads} range reads · ${after.prefetchHits} prefetch hits · ` +
              `${((after.prefetchBytes || 0) / 1e6).toFixed(1)} MB prefetched · ${after.prefetchMiss || 0} misses · ${after.commands} commands`);
  if (trapped) console.log(`    trap: ${(parsed && parsed.__trap) || errors.find((e) => /unreachable|RuntimeError/.test(e)) || 'uncaught'}`);
  console.log(`RESULT\t${scope}\t${trapped ? 'TRAP' : 'PASS'}\t${real}\t${hits}\t${d('commands')}\t${ms}`);
} finally {
  await close();
}
