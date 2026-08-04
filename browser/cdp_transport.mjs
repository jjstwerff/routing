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

const CDP_TIMEOUT_MS = 30_000;

export async function launch({
  bin, userDataDir, url = 'about:blank', args = [], maxLifetimeMs = 600_000,
}) {
  // fd 3 = commands INTO the browser, fd 4 = messages OUT of it. That pair is the whole contract; the
  // browser watches fd 3 and shuts down the moment it reads EOF.
  const child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1000,700',
    `--user-data-dir=${userDataDir}`, '--remote-debugging-pipe', ...args, url,
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
    if (closed) return reject(new Error(`cdp_transport: send after close (${method})`));
    const id = ++nextId;
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cdp_transport: ${method} did not answer within ${CDP_TIMEOUT_MS}ms`));
    }, CDP_TIMEOUT_MS);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
    const frame = { id, method, params };
    if (session) frame.sessionId = session;
    toBrowser.write(JSON.stringify(frame) + '\0');
  });

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(lifeline);
    // Closing our end of the pipe IS the shutdown: the browser reads EOF and exits. No signal is sent.
    try { toBrowser.end(); } catch { /* already gone */ }
  }

  // Attach to the page the browser opened for `url`. `flatten: true` multiplexes the page session over
  // this one connection, which is what lets page-level calls carry a sessionId instead of needing a
  // second socket — the thing the old per-page WebSocket was doing.
  const targets = await send('Target.getTargets');
  let page = (targets.result?.targetInfos || []).find((t) => t.type === 'page');
  if (!page) {
    const made = await send('Target.createTarget', { url });
    page = { targetId: made.result?.targetId };
  }
  const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  sessionId = attached.result?.sessionId;
  if (!sessionId) throw new Error('cdp_transport: could not attach to the page target');

  return {
    /** Page-level CDP call — resolves with the whole message, so `r.result` is the CDP result. */
    call: (method, params) => send(method, params, sessionId),
    /** Browser-level CDP call (Target.*, Browser.*) — no session. */
    callBrowser: (method, params) => send(method, params),
    /** Every CDP event on this connection. */
    onEvent: (fn) => eventHandlers.push(fn),
    /** Runtime.exceptionThrown descriptions, in arrival order. */
    errors,
    close,
    child,
  };
}
