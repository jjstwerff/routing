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
// Ported from rough.js: collapse the second click of a same-spot double-click so a double-tap does not
// drop two stacked points. Measured to be needed here too (P2), and it is the precondition for E4's
// double-click-to-delete — that gesture is unreachable while the first click of it appends a point.
export const DOUBLE_TAP_MS = 250;
export const DOUBLE_TAP_PX = 12;

// Is this tap the second of a double-click at the same spot? Pure, so map.test.mjs can pin the boundary
// without a browser. `prev` is the previous accepted tap ({t, x, y}) or null.
export function isDoubleTap(prev, t, x, y) {
  if (!prev) return false;
  return (t - prev.t) < DOUBLE_TAP_MS && Math.hypot(x - prev.x, y - prev.y) < DOUBLE_TAP_PX;
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
    this._lastTap = null;
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
    this._lastTap = null;
    this.commitEdit(true);
    return this;
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

  pointerDown(x, y, t) {
    this._g = { x0: x, y0: y, t0: t, grab: this.map.unproject(x, y), panning: false };
  }

  pointerMove(x, y) {
    const g = this._g;
    if (!g) return;
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
    if (g.panning) return;               // P1: a pan is not an edit and NEVER commits
    this._tap(g.x0, g.y0, g.t0);
  }

  pointerCancel() { this._g = null; }

  _tap(x, y, t) {
    if (isDoubleTap(this._lastTap, t, x, y)) { this._lastTap = null; return; }   // P2
    this._lastTap = { t, x, y };
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
