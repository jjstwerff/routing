// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// One headless browser per gate, owned by NODE, that cannot outlive the process that started it.
//
// ⚠ WHY THIS EXISTS. Every gate used to launch Chromium from bash with `--remote-debugging-port` and
// take it down from `trap cleanup EXIT`. That covers every way a script ENDS and nothing about the way
// these scripts actually die: a timeout or an interrupted turn kills the shell outright, no trap runs,
// and the browser — which is a DETACHED process holding a TCP port, owned by nobody — runs forever.
// Measured 2026-08-04: five complete leaked trees, 50 processes, 1.7 GB resident, the oldest 2 days
// 18 hours old, on a box whose swap was full at 8/8 GB. `HANDOFF` §1 item 5 names exactly that memory
// pressure as the leading suspect for nl_live_gate's `RuntimeError: unreachable`, so a leaked browser is
// not untidiness — it silently corrupts the next measurement.
//
// ⚠ AND THE FIX IS NOT A BETTER KILL. Two earlier attempts were rejected for good reasons and both are
// worth stating, because both look correct:
//
//   * SWEEP BY DIRECTORY at start-up — kill anything under `scratch/chromium-*`. This reaches into
//     browsers this run did not start: sibling agent workspaces run their own headless Chromium on the
//     same machine, and two gates in ONE checkout would kill each other. A run may only ever end the
//     browser it started itself.
//   * PROCESS GROUPS / a watchdog — `setsid`, `kill -- -$pgid`, `/proc` scans, systemd scopes. All of it
//     is Linux-only, and the gates have to run on macOS and Windows too.
//
// THE MECHANISM HERE IS NEITHER. `--remote-debugging-pipe` makes Chrome speak CDP over inherited file
// descriptors instead of a TCP port, and Chrome EXITS BY ITSELF when that pipe closes. Nothing has to
// notice, signal, or clean up: when this process dies — for any reason at all, including a hard kill —
// the OS closes its descriptors, and the browser goes with them. That is the same guarantee Puppeteer's
// `pipe: true` gives, it is the reason that mode exists, and it holds on every OS because "descriptors
// close when a process dies" is universal. There is no kill logic in this file, by design.
//
// The remaining bound is this process's own lifetime, so `maxLifetimeMs` caps it explicitly: a hung gate
// can hold a browser for that long and not one second more.
//
//   import { launch } from './cdp_transport.mjs';
//   const b = await launch({ bin, userDataDir, url });   // page attached, ready to drive
//   const r = await b.call('Runtime.evaluate', { … });   // page-level, sessionId added for you
//   b.close();
import { spawn } from 'node:child_process';

// 30 s is right for a gate: a call that takes longer is a hang, and a hang must fail rather than sit.
// But a probe that deliberately throttles the link can exceed it doing exactly what it is measuring —
// the whole-file names load is ~51 s at 10 Mbps — so the ceiling is overridable for those, and left
// alone (30 s) for everything else.
const CDP_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS || 30_000);

export async function launch({
  bin, userDataDir, url = 'about:blank', args = [], maxLifetimeMs = 600_000, clearStorage = true,
  // ⚠ NOT A COSMETIC DEFAULT. The window size sets the map viewport, which sets which terrain/base tiles
  // a camera needs. The browser/ gates all launched at 1000x700; the three server-app tests in tools/
  // launched with chrome's own default and `windowSize: null` keeps them there. Forcing 1000x700 on
  // client_elev_test moved the viewport off the single fixture tile it generates, and the profile drew
  // flat: `↑ 0 m` where the test requires `↑ 100 m`.
  windowSize = '1000,700',
  // ⚠ THE OLD GATES' `sleep 4`, KEPT WHERE IT WAS LOAD-BEARING. Every gate script slept 4 s between
  // launching the browser and running its driver. For the browser/ gates that sleep was slack — they
  // navigate themselves and poll for `window.__storeApp.ready`, so 0 is right. For the three server-app
  // tests it was doing real work: `document.readyState === 'complete'` is not "the app is ready", and
  // client_elev_test without it reports `↑ 0 m` where it must read `↑ 100 m` — reproducibly, and
  // reproducibly fixed by 4 s. Two other explanations were measured and refuted first (the localStorage
  // clear, and the forced --window-size), so this is the cause rather than the third guess.
  //
  // It is a settle, not a readiness signal, and that is a weakness inherited from the code it replaces:
  // the server app exposes no "ready" flag to poll the way the store app does. Whoever adds one should
  // delete this.
  settleMs = 0,
}) {
  // fd 3 = commands INTO the browser, fd 4 = messages OUT of it. That pair is the whole contract; the
  // browser watches fd 3 and shuts down the moment it reads EOF.
  // ⚠ ALWAYS STARTS ON about:blank, and navigates below even when a url was asked for. Passing the url
  // on the command line looks equivalent and is not: `Target.getTargets` can return the page before that
  // navigation commits, so the driver attaches to a BLANK page whose readyState is already 'complete' and
  // evaluates against a document that has none of the app in it. That is not a hypothetical — it broke
  // client_elev_test and client_routes_test, which open ON the app, and it surfaced as
  // `SyntaxError: "[object Object]" is not valid JSON` rather than as anything about a missing page.
  // Navigating explicitly makes "the page is the app" something this function established, not assumed.
  const child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    ...(windowSize ? [`--window-size=${windowSize}`] : []),
    `--user-data-dir=${userDataDir}`, '--remote-debugging-pipe', ...args, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  if (!toBrowser || !fromBrowser) throw new Error('cdp_transport: browser did not expose the CDP pipe on fd 3/4');

  // A gate that hangs must not park a browser indefinitely. Unref'd so it never keeps node alive itself.
  const lifeline = setTimeout(() => {
    console.error(`cdp_transport: exceeded maxLifetimeMs=${maxLifetimeMs}, closing the browser`);
    close(); process.exit(3);
  }, maxLifetimeMs);
  lifeline.unref?.();

  let nextId = 0;
  const pending = new Map();
  const eventHandlers = [];
  const errors = [];
  let sessionId = null;
  let closed = false;
  let dead = null;          // why the browser went away, if it did

  // ⚠ A BROWSER THAT NEVER STARTS MUST FAIL, NOT CRASH. If the profile is already locked — the exact
  // situation leak_gate.mjs provokes — Chrome exits immediately and the pipe raises ECONNRESET. As an
  // UNHANDLED stream 'error' that kills node with a stack trace, and it is not catchable around the
  // `await launch(...)` because it arrives asynchronously, so a caller's try/catch never sees it. Found
  // by the gate's own negative control, which is the whole reason for running one. Every in-flight and
  // future call is rejected with the reason instead.
  const bury = (reason) => {
    if (!dead) dead = reason;
    for (const [, p] of pending) p.reject?.(new Error(`cdp_transport: ${reason}`));
    pending.clear();
  };
  toBrowser.on('error', (e) => bury(`write to the browser failed: ${e.message}`));
  fromBrowser.on('error', (e) => bury(`read from the browser failed: ${e.message}`));
  child.on('error', (e) => bury(`the browser could not be started: ${e.message}`));
  child.on('exit', (code) => {
    if (!closed) bury(`the browser exited (code ${code}) — a locked --user-data-dir is the usual cause`);
  });

  // CDP over a pipe frames messages with a NUL byte — not newlines, which appear inside JSON strings.
  let buf = '';
  fromBrowser.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) !== -1) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!raw) continue;
      let msg; try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id); pending.delete(msg.id);
        resolve(msg);
      } else if (msg.method) {
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params?.exceptionDetails;
          errors.push(d?.exception?.description || d?.text || 'unknown exception');
        }
        for (const h of eventHandlers) h(msg);
      }
    }
  });

  const send = (method, params = {}, session) => new Promise((resolve, reject) => {
    if (dead) return reject(new Error(`cdp_transport: ${dead} (while sending ${method})`));
    if (closed) return reject(new Error(`cdp_transport: send after close (${method})`));
    const id = ++nextId;
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cdp_transport: ${method} did not answer within ${CDP_TIMEOUT_MS}ms`));
    }, CDP_TIMEOUT_MS);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
    const frame = { id, method, params };
    if (session) frame.sessionId = session;
    try { toBrowser.write(JSON.stringify(frame) + '\0'); } catch (e) { pending.delete(id); clearTimeout(t); reject(e); }
  });

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(lifeline);
    // Closing our end of the pipe IS the shutdown: the browser reads EOF and exits. No signal is sent.
    try { toBrowser.end(); } catch { /* already gone */ }
  }

  // Attach to a page target. `flatten: true` multiplexes the session over this one connection, which is
  // what lets page-level calls carry a sessionId instead of needing a second socket — the thing the old
  // per-page WebSocket was doing. Every session rides the same pipe, so a second page costs no extra
  // lifetime management: closing the pipe still takes the whole browser down.
  async function attach(targetId) {
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    const sid = attached.result?.sessionId;
    if (!sid) throw new Error('cdp_transport: could not attach to target ' + targetId);
    return {
      targetId,
      sessionId: sid,
      /** Page-level CDP call — resolves with the whole message, so `r.result` is the CDP result. */
      call: (method, params) => send(method, params, sid),
      /** Just the CDP result, for drivers whose `send()` was written that way. */
      callResult: async (method, params) => (await send(method, params, sid)).result,
      /** CDP events addressed to THIS session. */
      onEvent: (fn) => eventHandlers.push((m) => { if (!m.sessionId || m.sessionId === sid) fn(m); }),
    };
  }

  const targets = await send('Target.getTargets');
  let first = (targets.result?.targetInfos || []).find((t) => t.type === 'page');
  if (!first) {
    const made = await send('Target.createTarget', { url });
    first = { targetId: made.result?.targetId };
  }
  const page = await attach(first.targetId);
  sessionId = page.sessionId;

  // Navigate and WAIT. The gate scripts used to `sleep 4` between launching the browser and running the
  // driver; for the drivers that open ON the app that sleep was load-bearing. Waiting on readyState is
  // what it was approximating — deterministic, and faster.
  if (url && url !== 'about:blank') {
    await page.call('Page.enable');
    // PLAN-EDIT E9, and map_render_gate enforces it: a driver that boots a page must clear localStorage
    // first, or the previous run's autosaved sketch restores into this run's assertions and re-matches at
    // boot, moving the range-read and match counters other gates assert on. store-app.mjs named the weak
    // point of doing it per-driver — "the eighth forgetting to". Doing it HERE is what removes the eighth:
    // a driver that navigates through this function cannot forget.
    //
    // ⚠ `clearStorage: false` EXISTS FOR THE THREE SERVER-APP DRIVERS, whose subject IS persisted state —
    // route restore across a reload, the elevation dock's remembered open/closed, per-activity goals.
    // Clearing under them made client_elev_test report `↑ 0 m` where it reads `↑ 100 m`, reproducibly.
    // They stay hermetic the other way, by wiping their `--user-data-dir` before the run, and they are in
    // tools/ rather than browser/ so map_render_gate's rule never covered them either.
    if (clearStorage) {
      await page.call('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'local_storage' });
    }
    await page.call('Page.navigate', { url });
    for (let i = 0; i < 300; i++) {
      const r = await page.call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result?.result?.value === 'complete') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    if (settleMs) await new Promise((res) => setTimeout(res, settleMs));
  }

  return {
    ...page,
    /** Open and attach ANOTHER page on the same browser — cdp_sync drives two tabs. */
    newPage: async (pageUrl = 'about:blank') => {
      const made = await send('Target.createTarget', { url: pageUrl });
      return attach(made.result?.targetId);
    },
    /** Browser-level CDP call (Target.*, Browser.*) — no session. */
    callBrowser: (method, params) => send(method, params),
    /** Runtime.exceptionThrown descriptions, in arrival order. */
    errors,
    close,
    child,
  };
}
