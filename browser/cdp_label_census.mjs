// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// WHAT LABELS DOES THIS CAMERA ACTUALLY DRAW, and how much of it is one name repeated?
//
// The instrument behind PLAN-MAP § "Open work — street labels repeat". It answers the three questions
// that decide any thinning rule, and answers them from the RENDERER rather than from the store:
//
//   drawn        `_stats.streetLabels` — what layoutLabels PLACED, after the `fits` collision cull
//   candidates   features past the 70 px floor, i.e. what could have been labelled
//   names        distinct names among them — `candidates - names` is the cross-feature repetition
//   lengths      each candidate's on-screen length, which is what decides repeats WITHIN one feature
//
// ⚠ IT IS NOT `layerCounts.streetLabels`. That is the named-street features READ FROM THE STORE, and it
// does not move with any label rule at all (measured: 3912 at every spacing from 420 to 1000 px). Gates
// assert on the drawn result, never on the table — the first version of this probe measured the table
// and reported a flat line.
//
// ⚠ IT WAITS FOR THE CAMERA TO BE THE ONE ASKED FOR. A hash-only navigation does not reload, so a probe
// that merely waits for "some labels" reports the PREVIOUS camera's numbers — HANDOFF §2's rule, which
// this probe also had to learn (four different cameras returned identical rows).
//
//   node browser/cdp_label_census.mjs <devtools host:port> <app url with #zoom/lat/lon>
//
// To compare label rules: change the constant, rebuild (`node browser/build-site.mjs`), re-run. The draw
// path is inside the render, so there is no runtime knob to sweep.
const [dt, app] = process.argv.slice(2);
const want = (app.split('#')[1] || '').split('/').map(Number);

const tabs = await (await fetch(`http://${dt}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

await call('Page.navigate', { url: 'about:blank' });
await new Promise((r) => setTimeout(r, 500));
await call('Page.navigate', { url: app });

let settled = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const cam = await ev(`window.__map0 ? JSON.stringify([window.__map0.camera.zoom, window.__map0.camera.lat, window.__map0.camera.lon]) : null`);
  if (!cam) continue;
  const c = JSON.parse(cam);
  if (Math.abs(c[0] - want[0]) < 0.05 && Math.abs(c[1] - want[1]) < 1e-3 && Math.abs(c[2] - want[2]) < 1e-3
      && (await ev(`window.__map0?._stats?.streetLabels ?? -1`)) >= 0) { settled = true; break; }
}
if (!settled) { console.log('#L FAIL the camera never settled on the one asked for'); ws.close(); process.exit(1); }

const raw = await ev(`(() => {
  const m = window.__map0; const rows = [];
  for (const s of (m.streetLabels || [])) {
    const px = m._projLine(s.line);
    if (!s.label || px.length < 2 || !m._inView(px)) continue;
    let t = 0;
    for (let i = 1; i < px.length; i++) t += Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y);
    if (t < 70) continue;
    rows.push([s.label, Math.round(t)]);
  }
  return JSON.stringify({ drawn: m._stats?.streetLabels ?? -1, rows });
})()`);
const { drawn, rows } = JSON.parse(raw);
const byName = new Map();
for (const [n] of rows) byName.set(n, (byName.get(n) || 0) + 1);
const worst = [...byName.entries()].sort((a, b) => b[1] - a[1]).filter(([, c]) => c > 1).slice(0, 6);
const longest = rows.map(([, t]) => t).sort((a, b) => b - a).slice(0, 5);
console.log(`  drawn ${drawn} · candidates ${rows.length} · distinct names ${byName.size} · repeated-name candidates ${rows.length - byName.size}`);
console.log(`  longest candidates (px): ${longest.join(' ') || '(none)'}`);
if (worst.length) console.log(`  repeats: ${worst.map(([n, c]) => `${n} x${c}`).join(' · ')}`);
console.log(`#L drawn=${drawn} cands=${rows.length} names=${byName.size}`);
ws.close();
