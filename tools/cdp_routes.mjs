// Drive the app in headless Chromium over the DevTools protocol and verify the routes panel
// (PLAN step 16): save with a name, list shows it, PAGE RELOAD restores the working sketch
// silently, opening the saved route applies its points + profile, delete removes it.
// NOTE: overwrites the developer's "_working" sketch with the test route (it IS the restore test).
// Usage: node tools/cdp_routes.mjs [devtools-host:port] [app-origin]
const dt = process.argv[2] || "127.0.0.1:9222";
const app = process.argv[3] || "http://127.0.0.1:18080";

const targets = await (await fetch(`http://${dt}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith(app));
if (!page) { console.log("FAIL: no app page target"); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
const call = (method, params) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const waitEvent = (method, timeoutMs = 20000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("timeout waiting " + method)), timeoutMs);
  events.push({ method, res: (m) => { clearTimeout(t); res(m); } });
});
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  const i = events.findIndex((w) => w.method === m.method);
  if (i >= 0) events.splice(i, 1)[0].res(m);
});
await new Promise((res) => ws.addEventListener("open", res));
await call("Page.enable");

const evaluate = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  const v = r.result && r.result.result && r.result.result.value;
  if (!v) { console.log("FAIL: evaluate", JSON.stringify(r.result).slice(0, 400)); process.exit(1); }
  return JSON.parse(v);
};

// Phase 1: sketch (profile cycling_gravel autosaves via the debounced match), then save the named
// route under a DIFFERENT profile (running_trail) so restore-vs-open are distinguishable.
const s1 = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  for (let i = 0; i < 100 && !(routing.ws && routing.ws.connected); i++) await sleep(100);
  out.panelClosedByDefault = document.getElementById("routes-panel").classList.contains("hidden");
  routing.setProfile("cycling_gravel");
  routing.rough.setPoints([{ lat: 52.0, lon: 4.97 }, { lat: 52.0, lon: 5.0 }]);
  await sleep(2500);                                  // debounce (700ms) + autosave round-trip
  routing.setProfile("running_trail");
  document.getElementById("routes-toggle").click();
  document.getElementById("route-name").value = "CDP Test Route";
  document.getElementById("route-save").click();
  let has = false;
  for (let i = 0; i < 40 && !has; i++) {
    await sleep(250);
    has = [...document.querySelectorAll("#routes-list .route-open")].some((b) => b.textContent === "CDP Test Route");
  }
  out.savedListed = has;
  return JSON.stringify(out);
})()`);

await call("Page.reload");
await waitEvent("Page.loadEventFired");

// Phase 2: after reload — silent restore of the working sketch, then open the saved route.
const s2 = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  for (let i = 0; i < 100 && !(routing.roughPoints && routing.roughPoints.length >= 2); i++) await sleep(100);
  out.restoredPoints = (routing.roughPoints || []).length;
  out.restoredProfile = routing.getProfile();
  document.getElementById("routes-toggle").click();
  let btn = null;
  for (let i = 0; i < 40 && !btn; i++) {
    await sleep(250);
    btn = [...document.querySelectorAll("#routes-list .route-open")].find((b) => b.textContent === "CDP Test Route");
  }
  if (!btn) { out.openFailed = true; return JSON.stringify(out); }
  btn.click();
  await sleep(500);
  out.openedProfile = routing.getProfile();
  out.openedPoints = (routing.roughPoints || []).length;
  out.panelClosedAfterOpen = document.getElementById("routes-panel").classList.contains("hidden");
  document.getElementById("routes-toggle").click();
  const del = [...document.querySelectorAll("#routes-list .route-del")].find(
    (b) => b.previousSibling && b.previousSibling.textContent === "CDP Test Route");
  if (del) del.click();
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await sleep(250);
    gone = ![...document.querySelectorAll("#routes-list .route-open")].some((b) => b.textContent === "CDP Test Route");
  }
  out.deleted = gone;
  return JSON.stringify(out);
})()`);

ws.close();
console.log("PHASE1", JSON.stringify(s1));
console.log("PHASE2", JSON.stringify(s2));
const ok = s1.panelClosedByDefault && s1.savedListed
  && s2.restoredPoints === 2 && s2.restoredProfile === "cycling_gravel"
  && s2.openedPoints === 2 && s2.openedProfile === "running_trail"
  && s2.panelClosedAfterOpen && s2.deleted;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
