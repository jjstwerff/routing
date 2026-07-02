// Node 3-client check for live sync (PLAN step 19). A saves + edits shared route X; B (subscribed
// via open) receives the 23-broadcast, A gets no echo; C joins late and sees the current state via
// plain open (the disk is always current); B switches to route Y and stops receiving X's edits.
// Offline-safe: the match inside an edit may fail (empty match part) — assertions stop at the
// rough-points part. Uses "test_"-prefixed names; restores the prior "_working".
// Usage: node tools/ws_sync.mjs [ws://host:port/ws]
const url = process.argv[2] || "ws://127.0.0.1:18080/ws";

class Conn {
  constructor(label) {
    this.label = label;
    this.msgs = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      const raw = e.data.toString();
      const i = this.waiters.findIndex((w) => w.pred(raw));
      if (i >= 0) this.waiters.splice(i, 1)[0].res(raw);
      else this.msgs.push(raw);
    });
    this.ws.addEventListener("error", () => { console.log(`WS ERROR (${label})`); process.exit(2); });
  }
  open() { return new Promise((res) => this.ws.addEventListener("open", res)); }
  send(m) { this.ws.send(m); }
  wait(pred, ms = 30000) {
    const i = this.msgs.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.label}: timeout`)), ms);
      this.waiters.push({ pred, res: (raw) => { clearTimeout(t); res(raw); } });
    });
  }
  request(m, pred, ms) { this.send(m); return this.wait(pred, ms); }
  async quiet(pred, ms) {
    await new Promise((r) => setTimeout(r, ms));
    return !this.msgs.some(pred);
  }
  drain() { this.msgs.length = 0; }
}

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) fail = 1;
};

const X = "test_sync X", Y = "test_sync Y";
const pts1 = "0,-30;0.01,-30";
const pts2 = "0,-30;0.02,-30";
const pts3 = "0,-30;0.03,-30";
const is23 = (raw) => raw.startsWith("23:");

const A = new Conn("A"), B = new Conn("B"), C = new Conn("C");
await Promise.all([A.open(), B.open(), C.open()]);

const prevWorking = await A.request("16:_working", (r) => r.startsWith("17:"));

await A.request(`12:${X}|walking_paved|${pts1}`, (r) => r.startsWith("13:"));

let r = await B.request(`16:${X}`, (r2) => r2.startsWith("17:"));
check("B opens X at pts1", r === `17:${X}|walking_paved|${pts1}`, r.slice(0, 60));

A.drain(); B.drain(); C.drain();
A.send(`4:walking_paved|${pts2}`);
await A.wait((r2) => r2.startsWith("5:"), 60000);
r = await B.wait(is23, 60000);
check("B receives A's edit", r.startsWith(`23:${X}|walking_paved|${pts2}|`), r.slice(0, 60));
check("A gets no echo", await A.quiet(is23, 800));
check("C (not subscribed) stays quiet", await C.quiet(is23, 200));

r = await C.request(`16:${X}`, (r2) => r2.startsWith("17:"));
check("late joiner C opens X at pts2", r === `17:${X}|walking_paved|${pts2}`, r.slice(0, 60));

await B.request(`12:${Y}|cycling_road|${pts1}`, (r2) => r2.startsWith("13:"));
A.drain(); B.drain(); C.drain();
A.send(`4:walking_paved|${pts3}`);
await A.wait((r2) => r2.startsWith("5:"), 60000);
r = await C.wait(is23, 60000);
check("C (on X) receives the next edit", r.startsWith(`23:${X}|walking_paved|${pts3}|`), r.slice(0, 60));
check("B (switched to Y) stays quiet", await B.quiet(is23, 1200));

await A.request(`18:${X}`, (r2) => r2.startsWith("13:"));
await A.request(`18:${Y}`, (r2) => r2.startsWith("13:"));
if (prevWorking.length > "17:".length) await A.request("12:" + prevWorking.slice(3), (r2) => r2.startsWith("13:"));

console.log(fail ? "FAILURES" : "ALL PASS — subscribe, broadcast (echo-free), late-join replay, unsubscribe-by-switch.");
for (const c of [A, B, C]) c.ws.close();
process.exit(fail);
