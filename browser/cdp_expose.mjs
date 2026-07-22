// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-PERF §0 step 9's observable: does JS actually RECEIVE the layout handle?
//
// `expose(1, layout)` is invisible from loft's side — expose_value's body is
// #[cfg(target_arch = "wasm32")], so it is a silent no-op anywhere but here, and a silent no-op is
// exactly what fooled an earlier probe of mine into a filed-and-retracted finding. So the assertion
// lives where the call actually lands: the host import in browser/store-kernel.mjs, which records
// __exposeCalls / __exposeArgs and counts handles in stats().exposed.
//
// Asserts, in order of what each would catch:
//   * called AT LEAST ONCE — zero means it never fired
//   * the bracket is BALANCED — releases == exposes - 1. The kernel must unpin before it reloads or
//     ITERATES the layout (a walk claims a cursor record inside the pinned store and the read-only lock
//     rejects it — PLAN-PERF §7d(2)), then re-pin after. So N views produce N exposes and N-1 releases;
//     any other ratio means loft is touching a store it has pinned, which traps silently in wasm.
//   * descriptor PARSES — the JSON crossed intact and is not the {__parseError} fallback
//   * the address is real — storeBase/rec nonzero (rec == 0 is expose_value's early return)
//   * the hash was PRE-FLATTENED — @PLN105 Phase 3's collect_keyed ran, so the descriptor is not a
//     bare keyed node JS cannot walk. This is the claim I got wrong twice; assert it, don't argue it.
//   usage: node browser/cdp_expose.mjs <devtools host:port> <app url>
const [dt, app] = process.argv.slice(2);
const list = await (await fetch(`http://${dt}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = [];
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
const ev = async (x) => {
  const r = await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
};
await call('Page.navigate', { url: app });
let st = null;
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await ev('window.__storeApp?JSON.stringify(window.__storeApp):""');
  if (s) { st = JSON.parse(s); if (st.ready) break; }
}
if (!st?.ready) { console.log('  FAIL: app never became ready', JSON.stringify(st), errs.slice(-2)); process.exit(1); }

const seen = await ev(`JSON.stringify({
  calls:    globalThis.__exposeCalls  || 0,
  releases: globalThis.__releaseCalls || 0,
  args:     globalThis.__exposeArgs   || null,
  info:     window.__perfHooks?.exposeInfo?.() || null,
})`);
const r = JSON.parse(seen || '{}');
const a = r.args || {};
const info = r.info;
const fail = [];
if (!r.calls) fail.push('expose never fired — no handle was ever delivered');
if (r.calls && r.releases !== r.calls - 1)
  fail.push(`bracket unbalanced: ${r.calls} exposes vs ${r.releases} releases (want releases == exposes-1) — ` +
            `loft is touching a store it has pinned, which traps silently in wasm`);
if (!info) fail.push('no descriptor for tag 1 — the host never stored the handle (or it was released and not re-pinned)');
else {
  if (!info.descLen) fail.push('descriptor is empty');
  if (!info.descNodes) fail.push(`descriptor has no nodes — JS cannot walk it (${JSON.stringify(info).slice(0, 200)})`);
  if (!Number(info.storeBase)) fail.push(`storeBase is ${info.storeBase} — not a real address`);
  if (!Number(info.rec)) fail.push(`rec is ${info.rec} — expose_value early-returns when rec == 0, so the value never crossed`);
}
console.log(`  exposes=${r.calls} releases=${r.releases} tag=${a.tag} typeId=${a.typeId} descLen=${a.descLen}`);
if (info) {
  console.log(`  handle: storeBase=${info.storeBase} rec=${info.rec} pos=${info.pos} descNodes=${info.descNodes} wasmMB=${info.wasmMB}`);
  console.log(`  names:  ${JSON.stringify(info.sampleNames || []).slice(0, 200)}`);
}
if (fail.length) { console.log('FAIL — ' + fail.join('\n  FAIL — ')); process.exit(1); }
console.log('PASS — JS holds a live layout handle: descriptor parsed + address delivered, bracket balanced');
// Exit explicitly: the open WebSocket keeps node's event loop alive, so the success path would otherwise
// hang forever. Only the FAIL branch ever called process.exit, and until step 9 landed this probe had
// never once passed — so nothing had exercised the path that returns.
ws.close();
process.exit(0);
