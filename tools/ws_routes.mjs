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
check("open A round-trips exactly", r === `17:${A}|running_trail|${pts}|`, r.slice(0, 80));

r = await send("16:test_no such route");
check("open unknown → empty", r === "17:");

r = await send(`18:${B}`);
check("delete B removes it", names(r).includes(A) && !names(r).includes(B));

// Auto-proposed name (step 17): length + type are deterministic (2053.76 m → "2.1 km"); the
// area prefix depends on a live Nominatim lookup, so assert the tail only (offline → no prefix).
r = await send(`20:running_trail|${pts}`, 60000);
check("proposed name ends with length · type", r.startsWith("21:") && r.endsWith("2.1 km · Trail run"), r.slice(0, 80));

r = await send("20:walking_paved|52.0,4.97");
check("degenerate sketch → empty proposal", r === "21:");

// Instant persist (step 20) + draft save: msg 24 carries the undo history — _working stores it
// (line 4) and open returns it; the subscribed route (we're on A via the earlier open) is saved
// history-free. No Overpass involved.
const ptsP = "52.0,4.97;52.0,4.99";
const hist = `52.0,4.97;52.0,5.0#${ptsP}`;
r = await send(`24:cycling_road|${ptsP}|${hist}`);
check("persist acks", r === "25:");
r = await send("16:_working");
check("persist round-trips points + history", r === `17:_working|cycling_road|${ptsP}|${hist}`, r.slice(0, 100));
r = await send(`16:${A}`);
check("persist updates the subscribed route (history-free)", r === `17:${A}|cycling_road|${ptsP}|`, r.slice(0, 80));

// Import (8:) replies "<retrace_m>|<cleaned points>" — a zigzag out-and-back gets flagged.
r = await send("8:52.0,5.0;52.0,5.004;52.0,5.0002");
check("import reply carries a retrace flag", /^9:\d+\|52,/.test(r) && parseInt(r.slice(2)) > 200, r.slice(0, 60));

// _working has ONE writer (msg 24): a match request must leave it — history included — untouched.
await send(`4:walking_paved|${pts}`, 60000);
r = await send("16:_working");
check("a match request leaves _working untouched", r === `17:_working|cycling_road|${ptsP}|${hist}`, r.slice(0, 100));

// Deleting a route clears subscriptions to it — a later edit must NOT resurrect the file.
await send(`18:${A}`);
await send(`4:walking_paved|${pts}`, 60000);
r = await send("14:");
check("deleted route is not resurrected by a later edit", !names(r).includes(A), r.slice(0, 60));

// Cleanup: restore (or clear) the prior working sketch via msg 24 — its single writer — passing
// the profile|points|history tail of the "17:_working|…" reply through verbatim.
if (hadWorking) {
  const body = prevWorking.slice(3);
  await send("24:" + body.slice(body.indexOf("|") + 1));
}
console.log(fail ? "FAILURES" : "ALL PASS — named store + working-route autosave round-trip.");
ws.close();
process.exit(fail);
