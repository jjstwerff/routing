// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-EDIT E0 — the rough layer and the three chokepoints that make editing it safe.
//
// This step adds NO gesture. It exists so the ones that follow (insert, drag, delete, bulk-delete, undo)
// cannot each re-invent input handling, re-matching and redrawing — and it pays for itself immediately by
// killing two defects MEASURED in the append path (PLAN-EDIT §2):
//
//   P1  a PAN DRAG appended a spurious rough point. map.mjs bound `mousedown`→pan and store-app.mjs bound
//       `click`→append; neither knew about the other, and a browser fires `click` after a mouseup on the
//       same element even if the pointer travelled 200 px.
//   P4  a click arriving DURING a match was silently DROPPED (`if (sketch.length < 2 || busy) return`),
//       leaving the drawn route stale — measured ending 1417 m from the last rough point. The `busy` flag
//       was shared with the map-view loader, so a view in flight swallowed a match too.
//
// Both were invisible for two months for the same reason: a rough point renders as one unlabelled dot, so
// "did my click land?" has no visual answer. E1 gives the sketch a line; this file makes the line honest.
//
// THE INVARIANT (PLAN-EDIT §4). Every pointer event enters at exactly one place and leaves as at most one
// sketch mutation; every sketch mutation leaves at exactly one place; the sketch is the only state in
// between. A gesture never tested is correct because it is a sketch mutation like every other, and there
// is one road in and one road out. The three points that enforce it:
//
//   1. RoughLayer.pointerDown/Move/Up — the ONLY input path that can produce a sketch mutation. It
//      classifies the gesture and DELEGATES a pan to the camera (one classifier, two owners: camera state
//      is not sketch state). Nothing else may bind a pointer or click listener to the canvas.
//   2. RoughLayer.commitEdit — the ONLY path from a sketch mutation to a redraw and a match request.
//   3. KernelQueue — the ONLY way to reach the kernel: one job at a time, and a keyed job REPLACES a
//      pending one of the same key. Latest wins; nothing is ever dropped.

// Touch slop: a finger jitters by a pixel or two on a tap, so a gesture is only a pan once it has moved
// past this. Below it the camera does not move at all, which keeps a tap's coordinates exact.
export const PAN_SLOP_PX = 4;
// P2 — "a double-click must not drop two stacked points" — is now enforced by hit PRIORITY, not by a
// timer. E0 ported rough.js's 250 ms / 12 px dedupe for it; E2's hitTest made that dedupe unreachable and
// then harmful, so it is gone:
//
//   unreachable — a tap appends a point AT the press, so the second click of a double-click lands within
//     HIT_POINT_PX (15) of it and resolves to that POINT. 15 > 12, so the dedupe could never fire first.
//   harmful — it keyed on SCREEN position, which a pan invalidates. Tap, flick the map, tap the same spot
//     inside 250 ms and the dedupe swallowed a legitimate point that no longer had anything under it.
//
// E4's double-click-to-delete will need its own detector, keyed on the POINT's id rather than a screen
// spot — the same reason in reverse.

// Hit tolerances in SCREEN pixels, deliberately LARGER than the dot is drawn (map.mjs's ROUGH_DOT): how
// big a thing looks and how big it is to a fingertip are different questions. Ported from rough.js, where
// Leaflet expressed the same two numbers as a 30-px touch box around a 14-px dot and an 18-px transparent
// line under a 3-px one. Those stacked polylines do not survive onto a canvas — a transparent stroke
// catches nothing when there is no hit testing to catch it — but the tolerances and the priority do
// (PLAN-EDIT §3).
export const HIT_POINT_PX = 15;
export const HIT_SEGMENT_PX = 9;

// Distance from (px,py) to the segment a→b, and how far along it the foot lands (t in 0..1, clamped to the
// ends so a point beyond the segment measures to the nearer endpoint). Pure, and pure SCREEN space — see
// nearestSegment for why that matters.
export function pointToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return { d: Math.hypot(dx, dy), t };
}

// CHOKEPOINT 3 — every command to the kernel goes through here.
//
// The kernel is single-threaded and `runKernel` keeps ONE resolve slot, so a second concurrent call
// orphans the first promise: commands MUST be serialized. A single shared `busy` boolean used to do that,
// which conflated two different needs — a view and a match are mutually exclusive (correct) AND a request
// arriving while busy was dropped (P4, wrong).
//
// Here serialization is the queue's job and coalescing is per KEY. That is what makes E3's drag
// affordable: a warm match is ~545 ms throttled while a drag emits ~33 moves a second, so queueing them
// all would owe ~36 s of matching for a two-second drag. At most ONE match waits, and the one that waits
// is the LATEST — the route the user ends up looking at is the one for the sketch they ended up drawing.
export class KernelQueue {
  constructor() {
    this._running = false;
    this._pending = new Map();   // key → { job, resolve }
    this._gen = 0;
  }
  get pendingCount() { return this._pending.size; }
  get generation() { return this._gen; }

  // Post `job` under `key`, replacing any pending job with the same key. Resolves with the job's return
  // value, or `undefined` if a later post superseded it before it ran (a superseded job is SETTLED, never
  // left hanging — an awaited `ensureView()` that never resolves is a deadlock, not a saving).
  //
  // `job` is called with `isCurrent()`: false once a later job has started, so a stale line sink can
  // discard output that belongs to a match already superseded (PLAN-EDIT failure path 10).
  post(key, job) {
    return new Promise((resolve) => {
      const prev = this._pending.get(key);
      if (prev) prev.resolve(undefined);
      this._pending.set(key, { job, resolve });   // Map.set keeps a replaced key's original position
      if (!this._running) this._drain();
    });
  }

  async _drain() {
    this._running = true;
    try {
      while (this._pending.size) {
        const [key, entry] = this._pending.entries().next().value;
        this._pending.delete(key);
        const gen = ++this._gen;
        try { entry.resolve(await entry.job(() => gen === this._gen)); }
        catch (err) { entry.resolve(undefined); console.error(`kernel job "${key}" failed:`, err); }
      }
    } finally { this._running = false; }
  }
}

// The editable sketch: an ordered list of points, consecutive points joined by straight lines. First point
// is the start, last is the finish (DESIGN.md §1). The rough line is ALWAYS open — round-trip closure is
// inferred later, on the detailed layer.
export class RoughLayer {
  constructor(map, opts = {}) {
    this.map = map;
    this.onCommit = opts.onCommit || (() => {});
    // ONE array, shared with the renderer BY REFERENCE. `map.points` used to be rebuilt from a separate
    // `sketch` array on every click, so the two were copies of one truth and assigning `map.points = []`
    // silently did nothing — the next click resurrected the old points from `sketch` (failure path 11).
    this.points = [];
    map.points = this.points;
    this._seq = 0;
    this._g = null;                 // the in-progress gesture, or null when no pointer is down
    if (opts.bind !== false) this.bind();
  }

  // The sketch as the matcher wants it: [[lat, lon], …].
  coords() { return this.points.map((p) => [p.lat, p.lon]); }

  // ---- mutations — every one ends at commitEdit ------------------------------------------------------

  append(lat, lon) {
    this.points.push({ id: ++this._seq, lat, lon });
    this.commitEdit(true);
    return this;
  }

  clear() {
    this.points.length = 0;         // in place: the renderer holds this same array
    this.commitEdit(true);
    return this;
  }

  // Insert a point between `index-1` and `index`, WITHOUT committing. The sweep commits once on release,
  // so "drop a point on the line and drag it where you meant" is a single edit — and, from E6, a single
  // undo step rather than two.
  insertAt(index, lat, lon) {
    const pt = { id: ++this._seq, lat, lon };
    this.points.splice(index, 0, pt);
    this.commitEdit(false);
    return pt;
  }

  // ---- hit testing ---------------------------------------------------------------------------------

  // Every rough point in screen pixels. One projection pass per hit test — a sketch is a handful of
  // points, so there is nothing here worth caching and invalidating.
  _screen() {
    const out = new Array(this.points.length);
    for (let i = 0; i < this.points.length; i++) out[i] = this.map.project(this.points[i].lat, this.points[i].lon);
    return out;
  }

  // The segment (i → i+1) nearest to (x, y): { index, d, t }, or null when there is no segment yet. No
  // tolerance is applied — hitTest does that. An insert goes at index + 1.
  //
  // ⚠ SCREEN space, never degrees. A degree of longitude is not a degree of latitude on the ground, and
  // Mercator's y is not even linear in latitude, so "nearest" judged in degrees can name a DIFFERENT
  // segment than the one the user watched themselves tap. map.test.mjs pins a case where the two disagree.
  nearestSegment(x, y) {
    const px = this._screen();
    if (px.length < 2) return null;
    let best = null;
    for (let i = 0; i < px.length - 1; i++) {
      const r = pointToSegment(x, y, px[i].x, px[i].y, px[i + 1].x, px[i + 1].y);
      if (!best || r.d < best.d) best = { index: i, d: r.d, t: r.t };
    }
    return best;
  }

  // What is under (x, y)? { kind: 'point'|'segment', index, d, t? } or null.
  //
  // POINTS WIN OVER SEGMENTS, and the order is load-bearing rather than cosmetic: every point lies ON the
  // line, so segment-first would make each point unreachable — and pressing a point would insert a second
  // one on top of it instead of grabbing it. Grabbing the specific thing beats grabbing the general one.
  hitTest(x, y) {
    const px = this._screen();
    let best = null;
    for (let i = 0; i < px.length; i++) {
      const d = Math.hypot(x - px[i].x, y - px[i].y);
      if (d <= HIT_POINT_PX && (!best || d < best.d)) best = { kind: 'point', index: i, d };
    }
    if (best) return best;
    const seg = this.nearestSegment(x, y);
    return seg && seg.d <= HIT_SEGMENT_PX ? { kind: 'segment', index: seg.index, d: seg.d, t: seg.t } : null;
  }

  // CHOKEPOINT 2 — the only path from a sketch mutation to the world.
  //
  // `committed` is false during a live drag (E3): the sketch redraws every frame but the edit is not yet
  // one undo step (E6). It is passed through rather than interpreted here, because what "committed" costs
  // is the caller's business — this function's job is that NOBODY skips it.
  commitEdit(committed = true) {
    this.map.render();
    this.onCommit(this.coords(), committed);
    return this;
  }

  // ---- CHOKEPOINT 1 — input ------------------------------------------------------------------------
  //
  // Screen-space and DOM-free so map.test.mjs can drive a whole gesture without a browser; `bind()` below
  // is the thin adapter that turns real pointer events into these three calls.

  // One press, three possible gestures — decided here and nowhere else:
  //   on a SEGMENT → insert a point there and let this same gesture position it (the sweep)
  //   on a POINT   → reserved for E3's drag; inert for now, but it must NOT fall through to append, which
  //                  would stack a second point on top of the one being pressed
  //   on the MAP   → pan, or (if it never moves past the slop) a tap that appends
  pointerDown(x, y, t) {
    const hit = this.hitTest(x, y);
    if (hit && hit.kind === 'segment') {
      const ll = this.map.unproject(x, y);
      this._g = { kind: 'insert', x0: x, y0: y, t0: t, pt: this.insertAt(hit.index + 1, ll.lat, ll.lon) };
      return;
    }
    if (hit && hit.kind === 'point') {
      this._g = { kind: 'point', x0: x, y0: y, t0: t, index: hit.index };
      return;
    }
    this._g = { kind: 'pan', x0: x, y0: y, t0: t, grab: this.map.unproject(x, y), panning: false };
  }

  pointerMove(x, y) {
    const g = this._g;
    if (!g) return;
    if (g.kind === 'insert') {
      // The sketch line follows the finger EVERY frame — it is pure JS and costs nothing. The matched
      // route trails behind through the coalescer, which is DESIGN.md §1's two-tier feedback: distance is
      // instant, the route is lag-tolerant.
      const ll = this.map.unproject(x, y);
      g.pt.lat = ll.lat; g.pt.lon = ll.lon;
      this.commitEdit(false);
      return;
    }
    if (g.kind !== 'pan') return;
    // Below the slop this is still a candidate TAP and the camera must not move — otherwise a tap's own
    // coordinates would shift under it between press and release.
    if (!g.panning && Math.hypot(x - g.x0, y - g.y0) <= PAN_SLOP_PX) return;
    g.panning = true;
    this.map.dragTo({ x, y }, g.grab);   // delegate: the camera is map.mjs's business, not the sketch's
  }

  pointerUp() {
    const g = this._g;
    if (!g) return;
    this._g = null;
    if (g.kind === 'insert') { this.commitEdit(true); return; }   // ONE committed edit for the whole sweep
    if (g.kind === 'point') return;                               // E3 fills this in
    if (g.panning) return;                                        // P1: a pan is not an edit, and never commits
    this._tap(g.x0, g.y0);
  }

  // A cancelled sweep still leaves its point on the map, so it must still be committed — dropping the
  // commit would leave a real edit that undo could never take back.
  pointerCancel() {
    const g = this._g;
    this._g = null;
    if (g && g.kind === 'insert') this.commitEdit(true);
  }

  // A tap on empty map extends the sketch. A tap that lands on the sketch never reaches here — hitTest
  // resolved it to a point or a segment first, which is what keeps a double-click from double-adding.
  _tap(x, y) {
    const ll = this.map.unproject(x, y);
    this.append(ll.lat, ll.lon);
  }

  // The ONLY pointer binding on the canvas. Move/up listen on `window` so a gesture that leaves the canvas
  // still completes — a drag released outside it must not strand `_g` and turn the next press into a
  // continuation of the old gesture.
  bind() {
    if (this._bound || typeof window === 'undefined') return this;
    this._bound = true;
    const cv = this.map.canvas;
    const at = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const p = at(e);
      this.pointerDown(p.x, p.y, e.timeStamp);
      cv.style.cursor = 'grabbing';
      e.preventDefault();                                   // no text selection / native image drag
    });
    window.addEventListener('pointermove', (e) => { if (this._g) { const p = at(e); this.pointerMove(p.x, p.y); } });
    window.addEventListener('pointerup', () => { if (this._g) { this.pointerUp(); cv.style.cursor = ''; } });
    window.addEventListener('pointercancel', () => { this.pointerCancel(); cv.style.cursor = ''; });
    return this;
  }
}
