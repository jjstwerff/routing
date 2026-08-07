// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
//
// The device tier, DOM-free. Run: node browser/device.test.mjs
//
// The tier decides three things at once — how much the prefetch buffer may retain, how much ground
// outside the screen is fetched, and how much detail is drawn. Getting it wrong is not a crash: it is a
// map that is quietly sparser, or a phone that is quietly killed, and neither announces itself. So the
// rules are asserted here rather than inferred from a browser run, and the browser gate then checks that
// the app actually OBEYS what this decides.

import { TIERS, TIER_ORDER, FAST_ENOUGH, SLOW_BELOW,
         declaredTier, measuredTier, createDevice } from './device.mjs';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };
const eq = (a, b, msg) => ok(a === b, `${msg}  got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const DESKTOP = { cores: 24, mobile: false, heapLimit: 4396e6, saveData: false };
const PHONE   = { cores: 8, mobile: true, heapLimit: 512e6, saveData: false };
const WEAK    = { cores: 4, mobile: true, heapLimit: 256e6, saveData: false };
const UNKNOWN = { cores: null, mobile: null, heapLimit: null, saveData: false };

console.log('the tiers are ordered, and every knob moves the same way');
eq(TIER_ORDER.join(), 'minimal,reduced,full', 'worst to best');
for (let i = 1; i < TIER_ORDER.length; i++) {
  const lo = TIERS[TIER_ORDER[i - 1]], hi = TIERS[TIER_ORDER[i]];
  ok(hi.cap >= lo.cap && hi.pad >= lo.pad && hi.ring >= lo.ring && hi.detail <= lo.detail,
     `${TIER_ORDER[i]} allows at least as much as ${TIER_ORDER[i - 1]} on every knob`);
}

console.log('\nDECLARED — what the browser says, before anything is measured');
eq(declaredTier(DESKTOP), 'full', 'a 24-core desktop with a 4.4 GB heap ceiling');
eq(declaredTier(PHONE), 'reduced', 'a mobile with 8 cores and a 512 MB ceiling');
eq(declaredTier(WEAK), 'minimal', 'a mobile with 4 cores and a 256 MB ceiling');
eq(declaredTier(UNKNOWN), 'full', 'a browser that says nothing gets the median assumption, not the worst');
// An explicit request outranks anything inferred — the user asked, we do not second-guess.
eq(declaredTier({ ...DESKTOP, saveData: true }), 'minimal', 'save-data beats a desktop');

console.log('\nMEASURED — the thresholds, against the readings they were set from');
eq(measuredTier(679), 'full', 'CPU 1x on this box (679 features/ms)');
eq(measuredTier(208), 'reduced', 'CPU 4x — the target phone (208)');
eq(measuredTier(102), 'minimal', 'CPU 8x — a weak phone (102)');
ok(679 > FAST_ENOUGH * 1.5 && 102 < SLOW_BELOW * 0.75,
   `and the readings are not ON the thresholds — 679 vs ${FAST_ENOUGH}, 102 vs ${SLOW_BELOW}`);
eq(measuredTier(0), null, 'no sample is not a slow sample');

console.log('\n⚠ SLOWNESS IS BELIEVED AT ONCE; SPEED HAS TO REPEAT');
const d = createDevice(DESKTOP);
eq(d.tier, 'full', 'starts at the declared tier');
ok(d.observe(100), 'one slow view drops it immediately');
eq(d.tier, 'minimal', '…to minimal');
ok(!d.observe(679), 'one fast view does NOT raise it');
eq(d.tier, 'minimal', '…because a single fast view is easy to come by on a busy phone');
ok(d.observe(679), 'a second consecutive fast view does');
eq(d.tier, 'full', '…and only then');
// The asymmetry is the point: the cost of believing slowness wrongly is some missing detail; the cost of
// ignoring it is a frozen map on the screen that decides whether the visitor stays.
d.observe(100); eq(d.tier, 'minimal', 'and it drops again on the next slow one');

console.log('\nthe cap is bounded by the BROWSER’s ceiling, not only by the tier');
eq(createDevice(DESKTOP).capBytes(), TIERS.full.cap, 'a 4.4 GB ceiling leaves the full tier’s cap intact');
// ⚠ THE TWO BOUNDS ARE SEPARATE, AND WHICHEVER IS TIGHTER WINS. 15% of a 512 MB ceiling is 77 MB, which
// is ABOVE the reduced tier's own 64 MiB — so that phone is bounded by its TIER, not by its heap. The
// first version of this test asserted the ceiling always cuts, which was a guess about arithmetic rather
// than a rule, and it failed on exactly the machine the tier already handles.
eq(createDevice(PHONE).capBytes(), TIERS.reduced.cap, 'a 512 MB ceiling is looser than the tier — the tier binds');
ok(createDevice({ ...PHONE, heapLimit: 300e6 }).capBytes() < TIERS.reduced.cap,
   `a 300 MB ceiling IS tighter, so it cuts the tier's cap ` +
   `(${(createDevice({ ...PHONE, heapLimit: 300e6 }).capBytes() / 1e6).toFixed(0)} MB)`);
ok(createDevice({ ...WEAK, heapLimit: 64e6 }).capBytes() >= 16 * 1024 * 1024,
   'and never below a floor that would make the buffer pointless');
eq(createDevice(UNKNOWN).capBytes(), TIERS.full.cap, 'no ceiling reported → the tier decides alone');

console.log(fails ? `\n  FAIL: ${fails} check(s)` : '\n  ALL DEVICE-TIER CHECKS PASS');
process.exit(fails ? 1 : 0);
