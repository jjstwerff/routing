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

// Phase 1: sketch 2 points, save; then a 3-point COMMITTED edit with the reload only 400 ms
// later — under the 700 ms match debounce, and the reload kills the pending debounce timer, so
// only the step-20 instant persist (msg 24) can carry the 3rd point across the reload.
const s1 = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  for (let i = 0; i < 100 && !(routing.ws && routing.ws.connected); i++) await sleep(100);
  out.panelClosedByDefault = document.getElementById("routes-panel").classList.contains("hidden");
  routing.setProfile("cycling_gravel");
  routing.rough.setPoints([{ lat: 52.0, lon: 4.97 }, { lat: 52.0, lon: 5.0 }]);
  await sleep(1500);   // let persist + match-commit settle
  // Box select: SHIFT+drag a marquee around both points → the range selects (then Esc clears).
  routing.map.setView([52.0, 4.985], 12);
  await sleep(300);
  const mapEl = document.getElementById("map");
  const mr = mapEl.getBoundingClientRect();
  const cp1 = routing.map.latLngToContainerPoint({ lat: 52.0, lng: 4.97 });
  const cp2 = routing.map.latLngToContainerPoint({ lat: 52.0, lng: 5.0 });
  const mev = (type, x, y) => new MouseEvent(type, {
    clientX: mr.left + x, clientY: mr.top + y, shiftKey: true, bubbles: true,
  });
  mapEl.dispatchEvent(mev("mousedown", Math.min(cp1.x, cp2.x) - 20, cp1.y - 20));
  mapEl.dispatchEvent(mev("mousemove", Math.max(cp1.x, cp2.x) + 20, cp1.y + 20));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await sleep(300);
  out.boxSelected = document.querySelectorAll(".rough-pt.is-selected").length;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(200);
  document.getElementById("routes-toggle").click();
  // Step 17: the panel prefills a proposed name ("[area ·] 2.1 km · Gravel ride"); typing
  // overrides. Up to 30 s: the reply always comes (failed geocode → the length·type fallback),
  // but the live Nominatim lookup blocks the single-threaded server while it runs.
  let prop = "";
  for (let i = 0; i < 120 && !prop; i++) {
    await sleep(250);
    prop = document.getElementById("route-name").value;
  }
  out.proposedName = prop;
  document.getElementById("route-name").value = "CDP Test Route";
  document.getElementById("route-save").click();
  let has = false;
  for (let i = 0; i < 40 && !has; i++) {
    await sleep(250);
    has = [...document.querySelectorAll("#routes-list .route-open")].some((b) => b.textContent === "CDP Test Route");
  }
  out.savedListed = has;
  routing.setProfile("running_trail");
  routing.rough.setPoints([{ lat: 52.0, lon: 4.97 }, { lat: 52.0, lon: 5.0 }, { lat: 52.0, lon: 5.01 }]);
  await sleep(400);    // reload inside the debounce window — msg 24 already fired
  return JSON.stringify(out);
})()`);

await call("Page.reload");
await waitEvent("Page.loadEventFired");

// Phase 2: after reload — silent restore of the working sketch, then open the saved route.
const s2 = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  // The remembered view: phase 1's setView(52.0, …) landed in localStorage, so the reloaded map
  // must OPEN near lat 52.0 (the hardcoded default is 52.36 — clearly distinct).
  out.rememberedView = Math.abs(routing.map.getCenter().lat - 52.0) < 0.2;
  for (let i = 0; i < 100 && !(routing.roughPoints && routing.roughPoints.length >= 2); i++) await sleep(100);
  out.restoredPoints = (routing.roughPoints || []).length;
  out.restoredProfile = routing.getProfile();
  // Draft save: the undo stack survives the reload — one undo steps 3 points back to 2.
  out.canUndo = routing.undo.canUndo;
  routing.undo.undo();
  out.undonePoints = (routing.roughPoints || []).length;
  routing.undo.redo();
  document.getElementById("routes-toggle").click();
  let btn = null;
  for (let i = 0; i < 40 && !btn; i++) {
    await sleep(250);
    btn = [...document.querySelectorAll("#routes-list .route-open")].find((b) => b.textContent === "CDP Test Route");
  }
  if (!btn) { out.openFailed = true; return JSON.stringify(out); }
  btn.click();
  // applyRoute closes the panel; poll for it — the name-proposal lookup (msg 20) can hold the
  // single-threaded server for a moment, so the open reply may trail.
  let closed = false;
  for (let i = 0; i < 60 && !closed; i++) {
    await sleep(250);
    closed = document.getElementById("routes-panel").classList.contains("hidden");
  }
  out.panelClosedAfterOpen = closed;
  out.openedProfile = routing.getProfile();
  out.openedPoints = (routing.roughPoints || []).length;
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
  // Per-activity goals: a cycling goal and a running goal coexist; switching activity recalls each.
  const goal = document.getElementById("goal-km");
  routing.setProfile("cycling_gravel");
  goal.value = "60";
  goal.dispatchEvent(new Event("input", { bubbles: true }));
  routing.setProfile("running_trail");
  out.goalClearedOnSwitch = goal.value === "";
  goal.value = "10";
  goal.dispatchEvent(new Event("input", { bubbles: true }));
  routing.setProfile("cycling_gravel");
  out.goalCyclingRecalled = goal.value === "60";
  routing.setProfile("running_trail");
  out.goalRunningRecalled = goal.value === "10";
  // The remembered profile: programmatic setProfile must NOT set the preference; a USER selector
  // change must (activity change resets the sub-mode to its first → cycling_road).
  out.prefUnsetByProgrammatic = localStorage.getItem("routing.profile") === null;
  const aSel = document.getElementById("activity");
  aSel.value = "Cycling";
  aSel.dispatchEvent(new Event("change", { bubbles: true }));
  out.prefRemembered = localStorage.getItem("routing.profile") === "cycling_road";
  return JSON.stringify(out);
})()`);

// Phase 3: another reload — the restored profile (running, from _working) brings ITS goal back.
await call("Page.reload");
await waitEvent("Page.loadEventFired");
const s3 = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(routing.roughPoints && routing.roughPoints.length >= 2); i++) await sleep(100);
  await sleep(300);
  return JSON.stringify({
    profile: routing.getProfile(),
    goalAfterReload: document.getElementById("goal-km").value,
  });
})()`);

ws.close();
console.log("PHASE1", JSON.stringify(s1));
console.log("PHASE2", JSON.stringify(s2));
console.log("PHASE3", JSON.stringify(s3));
// The 3-point edit was committed only 400 ms before the reload (inside the match debounce), so a
// 3-point restore proves the instant persist. The saved route is updated too (the saver is
// subscribed — step 19), so open returns the same 3-point state.
const ok = s1.panelClosedByDefault && s1.savedListed
  && s1.boxSelected === 2
  && s1.proposedName.endsWith("2.1 km · Gravel ride")
  && s2.rememberedView
  && s2.restoredPoints === 3 && s2.restoredProfile === "running_trail"
  && s2.canUndo && s2.undonePoints === 2
  && s2.openedPoints === 3 && s2.openedProfile === "running_trail"
  && s2.panelClosedAfterOpen && s2.deleted
  && s2.goalClearedOnSwitch && s2.goalCyclingRecalled && s2.goalRunningRecalled
  && s2.prefUnsetByProgrammatic && s2.prefRemembered
  && s3.profile === "running_trail" && s3.goalAfterReload === "10";   // the sketch's profile still
                                                                      // beats the remembered pref
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
