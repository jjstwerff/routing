// PLAN-PERF §0 step 2 — drive the loop probe in a real browser via loft's OWN generated page
// (which already implements loft_web.ws_yield), and answer the two questions that gate steps 4-8:
//   1. does state (count) persist ACROSS commands? -> loft can own the loop, main() never returns
//   2. does rAF keep firing while loft waits?      -> frame_yield really hands the frame back
//   node drive_probe.mjs <devtools host:port> <probe url>
const [dt, app] = process.argv.slice(2);
setTimeout(() => { console.log('  FAIL: hard timeout'); process.exit(3); }, 60000);

const list = await (await fetch(`http://${dt}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = []; const errs = [];
const call = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args || []).map((a) => a.value).join(' '));
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
await new Promise((r) => ws.addEventListener('open', r));
await call('Runtime.enable'); await call('Page.enable');
const ev = async (x) => (await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

// Seed the FIRST command before the page's loft_start runs, then push two more live.
await call('Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.loftInput = "alpha";' });
// Count frames on the main thread while loft is looping+yielding.
await call('Page.addScriptToEvaluateOnNewDocument', {
  source: 'globalThis.__f = 0; (function t(){ globalThis.__f++; requestAnimationFrame(t); })();',
});
await call('Page.navigate', { url: app });
await new Promise((r) => setTimeout(r, 2500));

const framesAfterFirst = await ev('globalThis.__f');
await ev('globalThis.loftPush && globalThis.loftPush("bravo")');
await new Promise((r) => setTimeout(r, 1200));
await ev('globalThis.loftPush && globalThis.loftPush("charlie")');
await new Promise((r) => setTimeout(r, 1200));
const framesEnd = await ev('globalThis.__f');
await ev('globalThis.loftPush && globalThis.loftPush("quit")');
await new Promise((r) => setTimeout(r, 600));

// println lands in the page's <pre id="out">, not console.log.
const pre = (await ev("document.getElementById('out')?.textContent || ''")) || '';
const out = pre.split('\n').filter((l) => l.startsWith('echo='));
if (!out.length) {
  console.log('  #out contents: ' + JSON.stringify(pre.slice(0, 200)));
  console.log('  console logs : ' + JSON.stringify(logs.slice(0, 4)));
}
console.log('\n=== loft output (one line per command) ===');
for (const l of out) console.log('  ' + l);
if (errs.length) console.log('  page errors: ' + errs.slice(0, 2).join(' | '));

// Q1: did state survive across commands?
const counts = out.map((l) => Number((l.match(/count=(\d+)/) || [])[1]));
const persisted = counts.length >= 3 && counts[0] === 1 && counts[1] === 2 && counts[2] === 3;
// Q2: did the frame keep firing while loft waited?
const framesDuring = framesEnd - framesAfterFirst;
const alive = framesDuring > 30;   // ~2.4s of waiting should be >100 frames if truly yielding

console.log('\n=== VERDICT (gates PLAN-PERF steps 4-8) ===');
console.log(`  1. state persists across commands : ${persisted ? 'YES' : 'NO'}  (counts seen: ${counts.join(',') || 'none'})`);
console.log(`  2. rAF keeps firing while waiting : ${alive ? 'YES' : 'NO'}  (${framesDuring} frames during ~2.4s of loft polling)`);
console.log(persisted && alive
  ? '\n  ✅ loft CAN own the loop and keep state. Steps 4-8 are real.'
  : '\n  ❌ blocked — steps 4-8 need rework. See numbers above.');
process.exit(persisted && alive ? 0 : 1);
