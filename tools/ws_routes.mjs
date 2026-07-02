// Node WebSocket check for the named route store (PLAN step 16). Sequential request/reply over
// one connection: save two names → list → open (exact round-trip) → delete → working-route
// autosave via a match request. Uses "test_"-prefixed names and restores the pre-test "_working"
// sketch, so a developer's own store survives the run.
// Usage: node tools/ws_routes.mjs [ws://host:port/ws]
const url = process.argv[2] || "ws://127.0.0.1:18080/ws";
const ws = new WebSocket(url);

const queue = [];
ws.addEventListener("message", (e) => { const w = queue.shift(); if (w) w(e.data.toString()); });
ws.addEventListener("error", () => { console.log("WS ERROR"); process.exit(2); });
const send = (msg, timeoutMs = 30000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for reply to ${msg.slice(0, 24)}`)), timeoutMs);
  queue.push((raw) => { clearTimeout(t); res(raw); });
  ws.send(msg);
});
await new Promise((res) => ws.addEventListener("open", res));

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) fail = 1;
};
const names = (raw) => raw.slice(raw.indexOf(":") + 1).split("\n").filter(Boolean);

// Preserve the developer's working sketch across the test.
const prevWorking = await send("16:_working");
const hadWorking = prevWorking.length > "17:".length;

const A = "test_Morning Loop";
const B = "test_Duinen éé";
const pts = "52.0,4.97;52.0,5.0";

let r = await send(`12:${A}|running_trail|${pts}`);
check("save A appears in list", names(r).includes(A), r.slice(0, 60));

r = await send(`12:${B}|cycling_gravel|${pts}`);
check("save B appears in list", names(r).includes(A) && names(r).includes(B));

r = await send("14:");
check("list shows both", names(r).includes(A) && names(r).includes(B));

r = await send(`16:${A}`);
check("open A round-trips exactly", r === `17:${A}|running_trail|${pts}`, r.slice(0, 80));

r = await send("16:test_no such route");
check("open unknown → empty", r === "17:");

r = await send(`18:${B}`);
check("delete B removes it", names(r).includes(A) && !names(r).includes(B));

// Working-route autosave: a match request (4:) persists "_working" BEFORE matching, so the
// assertion holds even when the corridor fetch fails offline.
await send(`4:walking_paved|${pts}`, 60000);
r = await send("16:_working");
check("match request autosaves _working", r === `17:_working|walking_paved|${pts}`, r.slice(0, 80));

// Cleanup: remove test names; restore (or clear) the prior working sketch.
await send(`18:${A}`);
if (hadWorking) await send("12:" + prevWorking.slice(3));
console.log(fail ? "FAILURES" : "ALL PASS — named store + working-route autosave round-trip.");
ws.close();
process.exit(fail);
