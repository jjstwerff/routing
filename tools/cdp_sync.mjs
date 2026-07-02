// Two-tab live-sync check (PLAN step 19) over the DevTools protocol: tab 1 saves a shared route
// and edits it; tab 2 (subscribed via open) receives the edit WITHOUT sending anything itself
// (echo-free apply). Uses REAL Vondelpark coordinates so the tight-corridor match succeeds on
// the first fetch — ocean points would walk the whole widening loop and stall the fan-out. NOTE: overwrites the developer's "_working" sketch.
// Usage: node tools/cdp_sync.mjs [devtools-host:port] [app-origin]
const dt = process.argv[2] || "127.0.0.1:9224";
const app = process.argv[3] || "http://127.0.0.1:18080";

// Headless Chromium rejects multiple startup URLs ("Multiple targets are not supported in
// headless mode") — open the second tab through CDP instead.
const targets = await (await fetch(`http://${dt}/json/list`)).json();
const pages = targets.filter((t) => t.type === "page" && t.url.startsWith(app));
if (pages.length < 1) { console.log("FAIL: no app tab"); process.exit(2); }
if (pages.length < 2) {
  const created = await (await fetch(`http://${dt}/json/new?${app}/?tab2`, { method: "PUT" })).json();
  pages.push(created);
  await new Promise((r) => setTimeout(r, 3000));   // let the new tab load the app
}

function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      console.log("FAIL: page exception:", r.result.exceptionDetails.text,
        JSON.stringify(r.result.exceptionDetails.exception || {}).slice(0, 200));
      process.exit(1);
    }
    const v = r.result && r.result.result && r.result.result.value;
    if (typeof v !== "string") { console.log("FAIL: evaluate", JSON.stringify(r.result).slice(0, 300)); process.exit(1); }
    return JSON.parse(v);
  };
  return { ws, call, evaluate, ready: new Promise((res) => ws.addEventListener("open", res)) };
}

const t1 = attach(pages[0]);
const t2 = attach(pages[1]);
await Promise.all([t1.ready, t2.ready]);
// The created tab may sit on about:blank — navigate it to the app explicitly.
await t2.call("Page.navigate", { url: `${app}/?tab2` });
await new Promise((r) => setTimeout(r, 2000));

// Tab 1: sketch + save the shared route (becomes its editor).
const s1 = await t1.evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(routing.ws && routing.ws.connected); i++) await sleep(100);
  routing.setProfile("walking_paved");
  routing.rough.setPoints([{ lat: 52.3579, lon: 4.8620 }, { lat: 52.3590, lon: 4.8686 }]);
  await sleep(2000);
  routing.ws.saveRoute("CDP Sync Route");
  await sleep(800);
  return JSON.stringify({ ok: true });
})()`);

// Tab 2: open the shared route (subscribes). The tab was created via CDP, so first wait for the
// app itself to exist.
const s2 = await t2.evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && typeof window.routing === "undefined"; i++) await sleep(100);
  for (let i = 0; i < 100 && !(routing.ws && routing.ws.connected); i++) await sleep(100);
  routing.ws.openRoute("CDP Sync Route");
  // Poll for the route's EXACT 2-point state — the silent _working restore may have already put
  // some other sketch on this tab. Generous window: the reply can queue behind tab 1's LIVE
  // debounced match on the single-threaded server (Overpass can take tens of seconds).
  let n = 0;
  for (let i = 0; i < 240 && n !== 2; i++) { await sleep(250); n = (routing.roughPoints || []).length; }
  return JSON.stringify({ opened: n });
})()`);

// Tab 1: edit the route (third point) — the debounced match commits + broadcasts.
await t1.evaluate(`(async () => {
  routing.rough.setPoints([{ lat: 52.3579, lon: 4.8620 }, { lat: 52.3590, lon: 4.8686 }, { lat: 52.3585, lon: 4.8700 }]);
  return JSON.stringify({ ok: true });
})()`);

// Tab 2: the edit must arrive (3 points) without tab 2 sending anything.
const s3 = await t2.evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let n = 0;
  for (let i = 0; i < 240 && n < 3; i++) { await sleep(250); n = (routing.roughPoints || []).length; }
  await sleep(1000);   // echo window: a ping-pong would keep mutating
  return JSON.stringify({ synced: n, stable: (routing.roughPoints || []).length });
})()`);

// Cleanup: delete the shared route.
await t1.evaluate(`(async () => { routing.ws.deleteRoute("CDP Sync Route"); await new Promise((r) => setTimeout(r, 500)); return JSON.stringify({ ok: true }); })()`);

t1.ws.close(); t2.ws.close();
console.log("RESULT", JSON.stringify({ s1, s2, s3 }));
const ok = s2.opened === 2 && s3.synced === 3 && s3.stable === 3;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
