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

// A second press on the SAME POINT inside this window deletes it (E4, mouse). Keyed on the point's `id`,
// never on a screen position — that is the whole lesson of the dedupe E2 removed: a screen-keyed timer
// breaks the moment the map moves under it, and a point is a thing, not a place.
export const DOUBLE_CLICK_MS = 250;

// Below this a shift-drag is a stray shift-click, not a box — it leaves the selection alone rather than
// clearing it (ported from rough.js).
export const BOX_MIN_PX = 5;

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

// Undo depth, and how long the bulk-delete offer stays up. Ported from undo.js.
export const UNDO_MAX = 200;
export const SNACKBAR_MS = 6000;

// A per-session, ephemeral, LOCAL edit history over snapshots of the rough sketch (DESIGN.md §1, which
// makes undo a primitive rather than an extra). `_stack[_idx]` IS the current state, and the stack is
// seeded with the initial empty sketch so the very first edit is undoable back to nothing.
//
// Because it is per-session and local, undo only ever takes back YOUR own recent actions — which is what
// sidesteps the collaborative-undo footguns in multi-user mode.
export class History {
  constructor(max = UNDO_MAX) {
    this._stack = [];
    this._idx = -1;
    this._max = max;
    this.applying = false;      // true while REPLAYING, so a restore does not record itself
  }
  get canUndo() { return this._idx > 0; }
  get canRedo() { return this._idx < this._stack.length - 1; }
  get depth() { return this._stack.length; }
  get index() { return this._idx; }
  get current() { return this._idx < 0 ? null : this._stack[this._idx].map((p) => ({ ...p })); }

  // Record a committed state. Returns how many points the edit DROPPED — the bulk-delete signal — or -1
  // when suppressed because a replay is in progress.
  record(points) {
    if (this.applying) return -1;
    const prev = this._idx >= 0 ? this._stack[this._idx] : [];
    const dropped = prev.length - points.length;
    this._stack.splice(this._idx + 1);                            // a fresh edit truncates the redo tail
    this._stack.push(points.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon })));
    this._idx = this._stack.length - 1;
    if (this._stack.length > this._max) { this._stack.shift(); this._idx--; }
    return dropped;
  }

  undo() { if (!this.canUndo) return null; this._idx--; return this.current; }
  redo() { if (!this.canRedo) return null; this._idx++; return this.current; }
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
    this._anchorA = null;           // selection is a contiguous RANGE between two anchor ids (E5)
    this._anchorB = null;
    this._lastPress = null;         // { id, t } — the last press that landed on a point (E4's dblclick)
    this._deleteBtn = opts.deleteButton || null;
    this._snack = opts.snackbar || null;   // { el, label, button } — the bulk-delete undo offer (E6)
    this._boxEl = opts.boxElement || null;  // the shift-drag rubber band (E7, desktop)
    this._snackTimer = null;
    // Undo lives INSIDE the layer, hanging off the commit chokepoint, so every gesture is undoable by
    // construction. Wiring it externally would make "remember to also record undo" a per-gesture duty —
    // exactly the N-silent-sites problem the chokepoints exist to remove (PLAN-EDIT §4).
    this.history = new History();
    this.history.record(this.points);      // seed with the initial empty sketch
    this._syncSelection();
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
    this._anchorA = null;
    this._anchorB = null;
    this._lastPress = null;
    this._syncSelection();
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

  removeId(id) {
    const i = this.points.findIndex((p) => p.id === id);
    if (i < 0) return this;
    this.points.splice(i, 1);
    if (this._anchorA === id) this._anchorA = null;
    if (this._anchorB === id) this._anchorB = null;
    this._syncSelection();
    this.commitEdit(true);
    return this;
  }

  // Remove the whole selected range — DESIGN.md §1's "biggest lever when editing a route someone else
  // already made". Whatever survives at the ends simply becomes the new start/finish, because roles are
  // positional; there is no re-roling step to forget.
  deleteSelected() {
    const sel = new Set(this.selectedIds());
    if (!sel.size) return this;
    // Compact IN PLACE. rough.js could write `this._pts = this._pts.filter(…)` because its markers were
    // Leaflet's; here the renderer holds this exact array by reference, and replacing it would leave
    // map.points pointing at the pre-delete sketch — failure path 11, silently and only on bulk delete.
    let w = 0;
    for (let i = 0; i < this.points.length; i++) if (!sel.has(this.points[i].id)) this.points[w++] = this.points[i];
    this.points.length = w;
    this._anchorA = null;
    this._anchorB = null;
    this._syncSelection();
    this.commitEdit(true);       // ONE committed edit however many points went
    return this;
  }

  // ---- selection -----------------------------------------------------------------------------------
  //
  // Selection is a contiguous RANGE between two anchors: tap the first and last point of a stretch (the
  // touch-first model — no keyboard, no lasso). Anchors are ids, not indices, so they survive a splice.
  //
  // Selection is NOT a sketch mutation: it changes no geometry, so it must never reach commitEdit and
  // never re-match. It only redraws and re-labels the Delete button. That is what stops "I tapped a point
  // to look at it" from costing a match.

  // Drop anchors whose point no longer exists, promoting B if only A died. Called before every read and
  // every change, so the selection is SELF-HEALING rather than depending on each mutation to remember.
  //
  // Earned: `clear()` did not reset the anchors, so a stale anchor from an earlier sketch made the next
  // tap look like the second end of a range whose first end no longer existed — `selectedIds` then found
  // index -1 and returned nothing, and selecting a point silently did nothing at all. A dangling anchor
  // must not be able to swallow a selection, whichever mutation left it behind.
  _pruneAnchors() {
    const live = (id) => id !== null && this.points.some((p) => p.id === id);
    if (!live(this._anchorA)) { this._anchorA = live(this._anchorB) ? this._anchorB : null; this._anchorB = null; }
    else if (!live(this._anchorB)) this._anchorB = null;
  }

  select(id) {
    this._pruneAnchors();
    if (this._anchorA === null) { this._anchorA = id; this._anchorB = null; }
    else if (this._anchorB === null) {
      if (id === this._anchorA) this._anchorA = null;      // tapping the lone anchor again deselects
      else this._anchorB = id;                             // a second tap closes the range
    } else { this._anchorA = id; this._anchorB = null; }    // tapping once a range exists starts fresh
    this._syncSelection();
    this.map.requestRender();
    return this;
  }

  clearSelection() {
    if (this._anchorA === null && this._anchorB === null) return this;
    this._anchorA = null;
    this._anchorB = null;
    this._syncSelection();
    this.map.requestRender();
    return this;
  }

  // Select the contiguous range SPANNING every point inside the box (E7, desktop). Deliberately a span,
  // not a set: the selection model is a contiguous range (E5), so a point between the first and last hits
  // is selected even if the box missed it. That is what makes box-select and tap-first/tap-last the same
  // selection, reachable two ways, rather than two selection models to keep in step.
  selectBox(x0, y0, x1, y1) {
    const lox = Math.min(x0, x1), hix = Math.max(x0, x1);
    const loy = Math.min(y0, y1), hiy = Math.max(y0, y1);
    const px = this._screen();
    let first = -1, last = -1;
    for (let i = 0; i < px.length; i++) {
      if (px[i].x >= lox && px[i].x <= hix && px[i].y >= loy && px[i].y <= hiy) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) return this.clearSelection();
    this._anchorA = this.points[first].id;
    this._anchorB = last > first ? this.points[last].id : null;
    this._syncSelection();
    this.map.requestRender();
    return this;
  }

  // The rubber-band rectangle is a DOM element, not a canvas draw: it is transient desktop chrome, and
  // routing it through the render path would put editor state in the renderer and re-bake it every frame.
  _drawBox() {
    const el = this._boxEl, g = this._g;
    if (!el || !g || g.kind !== 'box') return;
    el.style.left = `${Math.min(g.x0, g.x1)}px`;
    el.style.top = `${Math.min(g.y0, g.y1)}px`;
    el.style.width = `${Math.abs(g.x1 - g.x0)}px`;
    el.style.height = `${Math.abs(g.y1 - g.y0)}px`;
    el.classList.remove('hidden');
  }

  _hideBox() { if (this._boxEl) this._boxEl.classList.add('hidden'); }

  // The ids in the selected index range, in sketch order. Empty when nothing is selected. Order-free: it
  // does not matter which end was tapped first.
  selectedIds() {
    this._pruneAnchors();
    if (this._anchorA === null) return [];
    const ia = this.points.findIndex((p) => p.id === this._anchorA);
    const ib = this._anchorB === null ? ia : this.points.findIndex((p) => p.id === this._anchorB);
    return this.points.slice(Math.min(ia, ib), Math.max(ia, ib) + 1).map((p) => p.id);
  }

  // The renderer draws a point's ring from a flag ON THE POINT: the layer owns what is selected, map.mjs
  // owns what selected looks like.
  _syncSelection() {
    const sel = new Set(this.selectedIds());
    for (const p of this.points) p.selected = sel.has(p.id);
    if (this._deleteBtn) {
      this._deleteBtn.classList.toggle('hidden', sel.size === 0);
      this._deleteBtn.textContent = sel.size > 1 ? `Delete ${sel.size} points` : 'Delete point';
    }
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
    // The history hangs off this one line, which is why every gesture is undoable and why a LIVE drag
    // frame is not: `committed` is false until the finger lifts, so a drag is one undo step, not thirty.
    if (committed) {
      const dropped = this.history.record(this.points);
      if (dropped >= 2) this._showSnackbar(dropped);   // a bulk delete — offer a one-tap way back
    }
    // requestRender, not render: a drag emits pointermove faster than the display refreshes (a 125 Hz
    // mouse against a 60 Hz screen), and rendering per EVENT would draw frames nobody ever sees. This
    // coalesces to one render per frame. In node there is no requestAnimationFrame and it falls through to
    // a synchronous render, so the unit tier still observes the result immediately.
    this.map.requestRender();
    this.onCommit(this.coords(), committed);
    return this;
  }

  // ---- undo / redo ---------------------------------------------------------------------------------

  undo() { return this._replay(this.history.undo()); }
  redo() { return this._replay(this.history.redo()); }
  get canUndo() { return this.history.canUndo; }
  get canRedo() { return this.history.canRedo; }

  _replay(snapshot) {
    if (!snapshot) return false;
    this.history.applying = true;                      // so setPoints' own commit does not record itself
    try { this.setPoints(snapshot); } finally { this.history.applying = false; }
    this._hideSnackbar();
    return true;
  }

  // Replace the whole sketch (an undo/redo restore, and PLAN step 11's cleaned GPX import). Ids are
  // restored with the points so a replayed state is the SAME sketch, not a look-alike — the double-click
  // detector and the selection anchors both key on id.
  setPoints(list) {
    this.points.length = 0;                            // in place: the renderer holds this array
    for (const p of list) {
      this.points.push({ id: p.id, lat: p.lat, lon: p.lon });
      if (p.id > this._seq) this._seq = p.id;          // never hand out an id a restore could collide with
    }
    this._anchorA = null;
    this._anchorB = null;
    this._lastPress = null;
    this._syncSelection();
    this.commitEdit(true);
    return this;
  }

  _showSnackbar(n) {
    const s = this._snack;
    if (!s || !s.el) return;
    if (s.label) s.label.textContent = `Deleted ${n} · `;
    s.el.classList.remove('hidden');
    if (this._snackTimer) clearTimeout(this._snackTimer);
    this._snackTimer = setTimeout(() => this._hideSnackbar(), SNACKBAR_MS);
    if (this._snackTimer && this._snackTimer.unref) this._snackTimer.unref();   // never hold node open
  }

  _hideSnackbar() {
    if (this._snackTimer) { clearTimeout(this._snackTimer); this._snackTimer = null; }
    if (this._snack && this._snack.el) this._snack.el.classList.add('hidden');
  }

  // ---- CHOKEPOINT 1 — input ------------------------------------------------------------------------
  //
  // Screen-space and DOM-free so map.test.mjs can drive a whole gesture without a browser; `bind()` below
  // is the thin adapter that turns real pointer events into these three calls.

  // One press, two possible gestures — decided here and nowhere else:
  //   on a POINT or a SEGMENT → MOVE a point. Pressing a segment inserts one first and then moves the
  //     point it just made, which is why insert-and-position is one gesture: the sweep IS a drag whose
  //     point did not exist yet. `created` is the only thing that differs afterwards (see pointerUp).
  //   on the MAP → pan, or (if it never moves past the slop) a tap that appends.
  pointerDown(x, y, t, shift) {
    // Shift wins over everything under the cursor: a box-drag that started on the line would otherwise
    // insert a point instead of selecting. Desktop-only — there is no shift on a phone, which is why the
    // tap-first/tap-last range (E5) stays the primary model and this is a convenience on top.
    if (shift) {
      this._g = { kind: 'box', x0: x, y0: y, t0: t, x1: x, y1: y };
      this._drawBox();
      return;
    }
    const hit = this.hitTest(x, y);
    if (hit && hit.kind === 'segment') {
      const ll = this.map.unproject(x, y);
      this._g = { kind: 'move', x0: x, y0: y, t0: t, created: true, moved: false,
                  pt: this.insertAt(hit.index + 1, ll.lat, ll.lon) };
      return;
    }
    if (hit && hit.kind === 'point') {
      this._g = { kind: 'move', x0: x, y0: y, t0: t, created: false, moved: false, pt: this.points[hit.index] };
      return;
    }
    this._g = { kind: 'pan', x0: x, y0: y, t0: t, grab: this.map.unproject(x, y), panning: false };
  }

  pointerMove(x, y) {
    const g = this._g;
    if (!g) return;
    if (g.kind === 'box') { g.x1 = x; g.y1 = y; this._drawBox(); return; }
    // The same slop guards both gestures, for the same reason: a fingertip is never still, and neither a
    // tap nor a point-selection should turn into a drag because the hand wobbled two pixels.
    if (!g.moved && !g.panning && Math.hypot(x - g.x0, y - g.y0) <= PAN_SLOP_PX) return;
    if (g.kind === 'move') {
      g.moved = true;
      // The sketch line follows the finger EVERY frame — it is pure JS and costs nothing. The matched
      // route trails behind through the coalescer, which is DESIGN.md §1's two-tier feedback: distance is
      // instant, the route is lag-tolerant. A warm match is ~545 ms and moves arrive ~33×/s, so this is
      // the difference between a live preview and 36 seconds of queued matching for a 2-second drag.
      const ll = this.map.unproject(x, y);
      g.pt.lat = ll.lat; g.pt.lon = ll.lon;
      this.commitEdit(false);
      return;
    }
    g.panning = true;
    this.map.dragTo({ x, y }, g.grab);   // delegate: the camera is map.mjs's business, not the sketch's
  }

  pointerUp() {
    const g = this._g;
    if (!g) return;
    this._g = null;
    if (g.kind === 'box') {
      this._hideBox();
      // A stray shift-click is not an empty box: clearing the selection on it would make shift a way to
      // lose the range you just built.
      if (Math.abs(g.x1 - g.x0) >= BOX_MIN_PX || Math.abs(g.y1 - g.y0) >= BOX_MIN_PX) {
        this.selectBox(g.x0, g.y0, g.x1, g.y1);
      }
      return;
    }
    if (g.kind === 'move') {
      // ONE committed edit for the whole gesture. A press on an existing point that never moved is NOT an
      // edit — committing it would re-match for nothing and, from E6, push an undo step that undoes
      // nothing. Instead it selects the point, or DELETES it if this is the second such press on the same
      // point inside the window.
      if (g.created || g.moved) { this.commitEdit(true); return; }
      const id = g.pt.id;
      if (this._lastPress && this._lastPress.id === id && g.t0 - this._lastPress.t < DOUBLE_CLICK_MS) {
        this._lastPress = null;
        this.removeId(id);
        return;
      }
      this._lastPress = { id, t: g.t0 };
      this.select(id);
      return;
    }
    if (g.panning) return;                                        // P1: a pan is not an edit, and never commits
    this._tap(g.x0, g.y0);
  }

  // A cancelled gesture still leaves its point where the finger left it, so a real edit must still be
  // committed — dropping it would leave a change that undo could never take back.
  pointerCancel() {
    const g = this._g;
    this._g = null;
    if (g && g.kind === 'move' && (g.created || g.moved)) this.commitEdit(true);
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
      this.pointerDown(p.x, p.y, e.timeStamp, e.shiftKey);
      cv.style.cursor = 'grabbing';
      e.preventDefault();                                   // no text selection / native image drag
    });
    window.addEventListener('pointermove', (e) => { if (this._g) { const p = at(e); this.pointerMove(p.x, p.y); } });
    window.addEventListener('pointerup', () => { if (this._g) { this.pointerUp(); cv.style.cursor = ''; } });
    window.addEventListener('pointercancel', () => { this.pointerCancel(); cv.style.cursor = ''; });
    // Touch has no double-click and no keyboard, so a selected point gets an explicit Delete button. The
    // button is bound HERE rather than in the app for the same reason the canvas is: it is an input that
    // produces a sketch mutation, and those have one owner (PLAN-EDIT §4, chokepoint 1).
    if (this._deleteBtn) this._deleteBtn.addEventListener('click', () => this.deleteSelected());
    // The phone's undo surface: a bulk delete is the one risky op, so it offers a one-tap way back
    // (DESIGN.md §1). Single moves and inserts are self-correcting and get no chrome.
    if (this._snack && this._snack.button) this._snack.button.addEventListener('click', () => this.undo());
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', (e) => {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.ctrlKey || e.metaKey) {
          const k = (e.key || '').toLowerCase();
          if (k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
          else if (k === 'y') { e.preventDefault(); this.redo(); }
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (this._anchorA === null) return;
          e.preventDefault();
          this.deleteSelected();
        } else if (e.key === 'Escape') this.clearSelection();
      });
    }
    return this;
  }
}
