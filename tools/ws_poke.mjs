// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Speak the server's WebSocket protocol by hand — one frame in, every reply out, timestamped.
//
// This is the debugging tool the repo lacked: `tools/ws_sync.mjs` drives a fixed 3-client SCENARIO and
// asserts, which is what you want in a gate and not what you want at 1 a.m. with one broken message. Here
// you send exactly the frames you name and see exactly what comes back, with no browser and no assertions
// in the way — so a failure is attributable to the SERVER before anyone opens devtools.
//
//   node tools/ws_poke.mjs [ws://127.0.0.1:18080/ws] '4:cycling_road|52.0,4.97;52.0,5.0' [more frames…]
//   node tools/ws_poke.mjs --listen                    # connect, send nothing, print what arrives
//                                                      #   (this is how you see a BROADCAST)
//   WAIT=4000 node tools/ws_poke.mjs '14:'             # how long to keep listening after the last frame
//
// Frames are `"<opcode>:<payload>"`, payload fields `|`-separated, points `lat,lon;lat,lon`. Replies use
// the NEXT odd opcode (4→5, 12→13, 16→17 …) — see docs/debug-websocket.md for the table.
// Needs node 22+ (global WebSocket).
const args = process.argv.slice(2);
const listenOnly = args.includes('--listen');
const rest = args.filter((a) => a !== '--listen');
const url = (rest[0] || '').startsWith('ws') ? rest.shift() : 'ws://127.0.0.1:18080/ws';
const frames = rest;
const wait = Number(process.env.WAIT || (frames.length ? 2500 : 8000));

if (typeof WebSocket !== 'function') {
  console.error('need node 22+ (global WebSocket)');
  process.exit(2);
}

const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(5) + 'ms';
// A reply can be large (a matched polyline is thousands of points); print the shape, not the flood.
const show = (s) => {
  const nl = s.replace(/\n/g, '\\n');
  return nl.length <= 300 ? nl : `${nl.slice(0, 220)} …[${nl.length} chars total]`;
};

let ws;
try {
  ws = new WebSocket(url);
} catch (e) {
  console.error(`connect threw: ${e.message}`);
  process.exit(1);
}
let replies = 0;

ws.addEventListener('open', () => {
  console.log(`${stamp()}  OPEN  ${url}`);
  if (listenOnly) return;
  for (const f of frames) {
    console.log(`${stamp()}  →  ${show(f)}`);
    ws.send(f);
  }
  if (!frames.length) console.log(`${stamp()}  (no frames given — listening; try --listen or pass one)`);
});
ws.addEventListener('message', (ev) => {
  replies += 1;
  const raw = typeof ev.data === 'string' ? ev.data : '[binary]';
  console.log(`${stamp()}  ←  ${show(raw)}`);
});
ws.addEventListener('error', () => console.log(`${stamp()}  ERROR (is the server up? fuser 18080/tcp)`));
ws.addEventListener('close', (ev) => console.log(`${stamp()}  CLOSE code=${ev.code}`));

setTimeout(() => {
  console.log(`${stamp()}  done — ${replies} reply frame(s)`);
  // No reply at all is the single most common symptom, and it has a short list of causes.
  if (!replies && !listenOnly) {
    console.log('        no reply: the opcode may be unhandled, the payload unparseable, or the handler');
    console.log('        may have raised — check the SERVER log (see docs/debug-websocket.md § 3).');
  }
  try { ws.close(); } catch {}
  process.exit(replies || listenOnly ? 0 : 1);
}, wait);
