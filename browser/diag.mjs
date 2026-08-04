// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// WHAT THE APP WAS DOING WHEN IT WENT WRONG — a rolling log, and a way to get it off the machine.
//
// Two faults are reported from real use and neither reproduces in a gate: **roads going missing after a
// pan**, and **a routing run that stops answering**. Neither is visible in a snapshot. Both are
// HISTORIES — which blocks answered a view, what the ring did with the ground around it, which reads
// failed, what the kernel's counters were doing across the run — so the app has to have been keeping
// notes before the fault, not after.
//
// ⚠ IT IS A RING BUFFER, NOT A LOG FILE. A session that runs for an hour must not grow a diagnostic that
// competes with the map for memory, and the interesting part of a fault is always the end. `CAP` records
// is a few tens of kB and bounded whatever the session does.
//
// ⚠ AND THE TRANSPORT IS DECIDED BY THE BROWSER, NOT BY US. Measured against the deployed site: an https
// page reaching http://127.0.0.1 or ws://127.0.0.1 is refused before the request leaves — the local
// server sees no preflight and no body. So there are two sinks and the page picks by its own origin:
//
//   * served from a LOCAL origin → stream to `tools/debug_server.loft` over a WebSocket, live, while the
//     fault is being reproduced;
//   * served from https (the real site) → DOWNLOAD the identical bundle, to be handed over afterwards.
//
// The bundle is the same object either way, so a fault reported from the live site and one reproduced
// locally are read with the same eyes.

const CAP = 400;                 // records retained; the fault is always at the end
const ring = [];
let seq = 0;
let sink = null;                 // an open WebSocket to a local debug server, when there is one

/** Append one record. `k` is the kind; everything else is whatever that kind needs. */
export function note(k, fields) {
  const rec = { n: ++seq, t: Math.round(performance.now()), k, ...fields };
  ring.push(rec);
  if (ring.length > CAP) ring.shift();
  // A live sink gets it immediately: a fault that ENDS the session (a kernel that stops answering, a
  // tab that dies) leaves nothing to press a button with, so the streaming case must not wait for one.
  if (sink && sink.readyState === 1) { try { sink.send(`1:${JSON.stringify(rec)}`); } catch { /* the sink is advisory */ } }
  return rec;
}

/** Errors are the records most worth having and the easiest to lose — hook them once, at the source. */
export function captureErrors(w = window) {
  w.addEventListener('error', (e) => note('error', {
    msg: String(e.message || e.error || 'error').slice(0, 300),
    at: `${e.filename || ''}:${e.lineno || 0}`,
  }));
  w.addEventListener('unhandledrejection', (e) => note('error', {
    msg: `unhandled rejection: ${String((e.reason && e.reason.message) || e.reason).slice(0, 300)}`,
  }));
}

/**
 * Everything known, as one object. `extra` is the caller's live state (kernel counters, coverage, the
 * device tier) — gathered at bundle time rather than logged per record, because it is a snapshot by
 * nature and logging it per view would be most of the bundle.
 */
export function bundle(extra = {}) {
  return {
    when: new Date().toISOString(),
    url: location.href,
    ua: navigator.userAgent,
    // The signals that decide what the app allows itself — worth having beside a complaint that it was
    // slow, because they are the reason it chose what it chose.
    machine: {
      cores: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
      mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
      heapLimit: performance.memory ? performance.memory.jsHeapSizeLimit : null,
      heapUsed: performance.memory ? performance.memory.usedJSHeapSize : null,
      screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
      connection: navigator.connection
        ? { type: navigator.connection.effectiveType, downlink: navigator.connection.downlink,
            rtt: navigator.connection.rtt, saveData: navigator.connection.saveData }
        : null,
    },
    ...extra,
    log: ring.slice(),
  };
}

/** True when this origin is allowed to reach a local server at all — see the header. */
export const canStream = () => location.protocol === 'http:'
  && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);

/** Open the live sink. Resolves to true when the socket is up. */
export function connect(port = 8791) {
  if (!canStream()) return Promise.resolve(false);
  return new Promise((res) => {
    try {
      const w = new WebSocket(`ws://127.0.0.1:${port}/`);
      w.onopen = () => { sink = w; note('diag', { msg: 'stream open' }); res(true); };
      w.onerror = () => res(false);
      w.onclose = () => { if (sink === w) sink = null; };
      setTimeout(() => res(sink === w), 4000);
    } catch { res(false); }
  });
}

/** Send the whole bundle to whichever sink this origin can use. Returns how it went, for the UI to say. */
export async function send(extra = {}, port = 8791) {
  const text = JSON.stringify(bundle(extra));
  if (canStream()) {
    const ok = sink && sink.readyState === 1 ? true : await connect(port);
    if (ok && sink) { sink.send(`1:${text}`); return { how: 'streamed', bytes: text.length }; }
  }
  // The deployed case, and the fallback for a local run with no server listening. A download needs no
  // permission, no network and no cooperation from anything — which is what makes it the honest floor.
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `routing-diag-${Date.now()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { how: 'downloaded', bytes: text.length };
}

/** For gates and probes: the records themselves, without going through a sink. */
export const records = () => ring.slice();
