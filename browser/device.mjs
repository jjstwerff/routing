// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// HOW MUCH IS THIS MACHINE GOOD FOR? — the one place that decides, and it decides TWICE.
//
// Three knobs want the same answer: how large the retention buffer may be, how much ground to fetch
// outside the screen, and how much detail to draw. Answering them separately is how they drift apart, so
// they are one tier here.
//
// ⚠ AND THE ANSWER ARRIVES IN TWO STAGES, BECAUSE NEITHER SOURCE IS SUFFICIENT ALONE.
//
//   1. DECLARED, before the first paint. `hardwareConcurrency`, `userAgentData.mobile`,
//      `jsHeapSizeLimit`, the reduced-data preferences. Available immediately — which matters, because
//      the first screen is the one the visitor judges — but they describe HARDWARE, not speed. Measured
//      under CPU throttling of 1x/4x/8x, every one of them is UNCHANGED while the same work takes 1.0x,
//      2.7x and 4.2x longer (browser/cdp_device_probe.mjs). A machine four times slower looks identical
//      to them.
//   2. MEASURED, after the first view. The app times its own post-kernel work — building the store index
//      and drawing it — over a known number of features, so `features/ms` is a speed that does not depend
//      on how much data the viewport happened to hold. That is the number that moves when the machine
//      does, and it corrects the declared guess from the second view onward.
//
// ⚠ WASM CANNOT ANSWER THIS. The sandbox exposes no CPU, no memory and no device; wasm can only be TIMED,
// which is what stage 2 does. Anything else would be a hint dressed as a fact.
//
// The memory knob is deliberately NOT measured: `performance.memory.jsHeapSizeLimit` is the browser's own
// ceiling for the tab, it is exactly the budget the retention buffer spends, and it does not get truer by
// timing it. ⚠ It counts the JS heap ONLY — wasm's memory is outside it, and on this app wasm is the
// bigger term (202.6 MB against a 294.9 MB heap on Amsterdam) — so the fraction below is a share of the
// heap, not of the tab.

// The tiers, and every number in them is a knob some other file used to hardcode.
//
//   cap     bytes the prefetch buffer may retain (store-kernel.mjs)
//   detail  zoom levels to WITHHOLD detail by: a mark that debuts at z14 debuts at z15 when this is 1
//   pad     how far outside the screen a view reads, as a fraction of the screen (store-app.mjs VIEW_PAD)
//   ring    how many neighbouring screens to page after the view (store-app.mjs RING_CELLS)
export const TIERS = {
  full:    { cap: 128 * 1024 * 1024, detail: 0, pad: 0.15, ring: 8 },
  reduced: { cap:  64 * 1024 * 1024, detail: 1, pad: 0.08, ring: 4 },
  minimal: { cap:  24 * 1024 * 1024, detail: 2, pad: 0.04, ring: 0 },
};
export const TIER_ORDER = ['minimal', 'reduced', 'full'];

// The measured boundaries, in features indexed-and-drawn per millisecond. Set from
// `browser/cdp_device_probe.mjs` at 1x / 4x / 8x CPU throttle — the throttle IS the slower machine, and
// 4x is the mid-range phone PLAN-PERF targets throughout.
export const FAST_ENOUGH = 900;      // at or above this, `full`
export const SLOW_BELOW = 220;       // below this, `minimal`

/** What the browser SAYS about itself, gathered in one place so the tier logic stays pure. */
export function declaredSignals(w = (typeof window !== 'undefined' ? window : undefined)) {
  const nav = w && w.navigator ? w.navigator : {};
  const perf = w && w.performance ? w.performance : {};
  const mq = (q) => { try { return !!(w && w.matchMedia && w.matchMedia(q).matches); } catch { return false; } };
  return {
    cores: nav.hardwareConcurrency || null,
    mobile: nav.userAgentData ? !!nav.userAgentData.mobile : (mq('(pointer: coarse)') || null),
    heapLimit: perf.memory ? perf.memory.jsHeapSizeLimit : null,
    // Two ways a user can ASK for less, and both outrank anything we infer.
    saveData: !!(nav.connection && nav.connection.saveData) || mq('(prefers-reduced-data: reduce)'),
  };
}

/**
 * The tier to start with, from declared signals alone. Deliberately pessimistic where it is blind:
 * being one tier low costs some detail on the first screen, being one tier high costs a phone the frame
 * budget on the screen that decides whether the visitor stays.
 */
export function declaredTier(s) {
  if (s.saveData) return 'minimal';                        // asked for, not inferred — no second-guessing
  const cores = s.cores || 4;                              // a browser that will not say gets the median
  // A heap ceiling under ~400 MB is a phone whatever else it claims; desktop Chromium reports ~4.4 GB.
  const tightHeap = s.heapLimit !== null && s.heapLimit < 400e6;
  if (s.mobile === true) return (cores <= 4 || tightHeap) ? 'minimal' : 'reduced';
  if (tightHeap) return 'reduced';
  return cores <= 2 ? 'reduced' : 'full';
}

/** The tier a measured speed implies, on its own. */
export function measuredTier(featuresPerMs) {
  if (!(featuresPerMs > 0)) return null;                   // no sample is not a slow sample
  if (featuresPerMs >= FAST_ENOUGH) return 'full';
  return featuresPerMs < SLOW_BELOW ? 'minimal' : 'reduced';
}

/**
 * The live device model. Starts declared, corrects itself once the first view has been measured.
 *
 * ⚠ A MEASUREMENT MAY ONLY LOWER THE TIER ON ITS OWN; RAISING IT NEEDS TWO. A single fast view is easy
 * to come by on a loaded phone (a small viewport, a warm cache), and flipping up to `full` on it means
 * the next real screen is drawn at a detail the machine cannot hold. Slowness is believed at once because
 * the cost of believing it wrongly is some missing detail, and the cost of ignoring it is a frozen map.
 */
export function createDevice(signals = declaredSignals()) {
  let tier = declaredTier(signals);
  let source = 'declared';
  let fastRun = 0;
  const samples = [];
  const capOf = (t) => {
    const c = TIERS[t].cap;
    // The tier proposes; the browser's own ceiling disposes. 15% of the JS heap limit leaves room for the
    // map, the index and everything else that is not this buffer.
    if (!signals.heapLimit) return c;
    return Math.max(16 * 1024 * 1024, Math.min(c, Math.round(signals.heapLimit * 0.15)));
  };
  return {
    get tier() { return tier; },
    get source() { return source; },
    capBytes: () => capOf(tier),
    detailShift: () => TIERS[tier].detail,
    viewPad: () => TIERS[tier].pad,
    ringCells: () => TIERS[tier].ring,
    signals: () => ({ ...signals }),
    samples: () => samples.slice(-8),
    /** Feed one view's measured speed. Returns true when the tier changed. */
    observe(featuresPerMs) {
      const want = measuredTier(featuresPerMs);
      if (!want) return false;
      samples.push(Math.round(featuresPerMs));
      const now = TIER_ORDER.indexOf(tier), next = TIER_ORDER.indexOf(want);
      source = 'measured';
      if (next < now) { tier = want; fastRun = 0; return true; }   // slower: believed immediately
      if (next > now) { fastRun++; if (fastRun >= 2) { tier = want; fastRun = 0; return true; } return false; }
      fastRun = 0;
      return false;
    },
  };
}
