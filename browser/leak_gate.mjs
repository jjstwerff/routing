// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// THE GATE FOR THE LEAK: a browser whose owner is killed outright must not survive it.
//
// This is the property `browser/cdp_transport.mjs` exists to provide, and it had never been tested —
// which is how five leaked browser trees sat on this machine for two and a half days (HANDOFF §1). The
// old gates all had `trap cleanup EXIT`, so they looked correct; nothing ever killed one to find out.
//
// ⚠ IT DOES NOT COUNT PROCESSES, deliberately. `pgrep`/`ps`/`/proc` is Linux-shaped, and matching by
// name would also see browsers this machine's OTHER checkouts are running — a gate that fails because a
// sibling workspace is busy is worse than no gate. It asks a question only the OS can answer, the same
// way on every platform: CAN A NEW BROWSER TAKE THE PROFILE?
//
// Chrome holds an exclusive lock on its `--user-data-dir` for as long as it lives. So:
//
//   1. a child process launches a browser on profile P and reports it is up
//   2. the child is SIGKILLed — nothing in it can run, no trap, no handler, no cleanup
//   3. THIS process launches a browser on the SAME profile P
//
// If step 3 succeeds the step-1 browser is provably gone, because it could not have released the lock
// otherwise. If it leaked, step 3 cannot get the profile and the gate fails. Both outcomes are decided
// by the OS, not by a process listing we interpret.
//
//   node browser/leak_gate.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { launch } from './cdp_transport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.env.CHROMIUM_BIN || 'chromium';
const profile = join(here, '..', 'scratch', 'chromium-leakgate');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the child half: bring a browser up on the profile, say so, then wait to be killed -------------
if (process.argv[2] === '--child') {
  await launch({ bin, userDataDir: profile, maxLifetimeMs: 120_000 });
  console.log('UP');
  await new Promise(() => {});           // never resolves; the parent kills us
}

// --- the gate ---------------------------------------------------------------------------------------
console.log('== browser leak gate: does a killed owner take its browser with it? ==');
rmSync(profile, { recursive: true, force: true });

const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'],
  { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });

const up = await new Promise((resolve) => {
  let seen = '';
  const t = setTimeout(() => resolve(false), 120_000);
  child.stdout.on('data', (d) => {
    seen += d.toString();
    if (seen.includes('UP')) { clearTimeout(t); resolve(true); }
  });
  child.on('exit', () => { clearTimeout(t); resolve(seen.includes('UP')); });
});
if (!up) { console.log('  FAIL: the child never got a browser up — the gate proved nothing'); process.exit(1); }
console.log('  ✓ a browser is up on the profile, owned by a child process');

// SIGKILL: the one signal nothing can catch, which is exactly the case every `trap` misses.
child.kill('SIGKILL');
await sleep(3000);

// The question. A browser still holding this profile makes it unanswerable — which is the failure.
let taken = false, why = '';
try {
  const b = await launch({ bin, userDataDir: profile, maxLifetimeMs: 60_000 });
  const r = await b.call('Runtime.evaluate', { expression: '1+1', returnByValue: true });
  taken = r.result?.result?.value === 2;
  why = taken ? '' : `the new browser answered oddly: ${JSON.stringify(r).slice(0, 200)}`;
  b.close();
} catch (e) {
  why = e.message;
}
await sleep(500);
rmSync(profile, { recursive: true, force: true });

if (!taken) {
  console.log(`  FAIL: a fresh browser could not take the profile — the killed owner's browser is still holding it`);
  console.log(`        ${why}`);
  console.log('FAIL — a killed gate leaks its browser (see browser/cdp_transport.mjs)');
  process.exit(1);
}
console.log('  ✓ a fresh browser took the same profile, so the first one is gone');
console.log('PASS — a browser cannot outlive the process that started it');
process.exit(0);
