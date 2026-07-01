// routing — undo (PLAN step 13, DESIGN §1). One per-session, ephemeral, LOCAL edit history over
// snapshots of the rough route, exposed via whatever is frictionless per device:
//   • Desktop: Ctrl/Cmd+Z multi-level undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redo.
//   • Phone: a brief "Deleted N · Undo" snackbar after a bulk delete (the one risky op); single
//     moves/inserts are self-correcting, so they get no chrome.
// Because the history is per-session + local, undo only ever takes back YOUR own recent actions.

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const MAX = 200;
  const stack = [];   // point-array snapshots; stack[idx] is the current state
  let idx = -1;
  let applying = false;

  const snap = (points) => points.map((p) => ({ lat: p.lat, lon: p.lon }));

  function apply(points) {
    applying = true;
    if (NS.rough && NS.rough.setPoints) NS.rough.setPoints(points);
    applying = false;
  }

  // Record a committed edit. Called from app.js onChange (committed only). No-op while applying an
  // undo/redo (so restoring a state doesn't spawn a new history entry).
  function record(points) {
    if (applying) return;
    const prev = idx >= 0 ? stack[idx] : [];
    const dropped = prev.length - points.length;
    stack.splice(idx + 1);           // a fresh edit truncates the redo tail
    stack.push(snap(points));
    idx = stack.length - 1;
    if (stack.length > MAX) { stack.shift(); idx--; }
    if (dropped >= 2) showSnackbar(dropped);   // a bulk delete — offer a one-tap undo
  }

  function undo() {
    if (idx <= 0) return false;
    idx--;
    apply(stack[idx]);
    return true;
  }
  function redo() {
    if (idx >= stack.length - 1) return false;
    idx++;
    apply(stack[idx]);
    return true;
  }

  // --- phone snackbar ---
  let snackEl = null;
  let snackTimer = null;
  function showSnackbar(n) {
    if (!snackEl) {
      snackEl = document.createElement("div");
      snackEl.id = "undo-snackbar";
      snackEl.className = "snackbar hidden";
      document.body.appendChild(snackEl);
    }
    snackEl.textContent = "";
    const label = document.createElement("span");
    label.textContent = `Deleted ${n} · `;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Undo";
    btn.addEventListener("click", () => { undo(); hideSnackbar(); });
    snackEl.appendChild(label);
    snackEl.appendChild(btn);
    snackEl.classList.remove("hidden");
    clearTimeout(snackTimer);
    snackTimer = setTimeout(hideSnackbar, 6000);
  }
  function hideSnackbar() {
    if (snackEl) snackEl.classList.add("hidden");
  }

  NS.undo = {
    record, undo, redo,
    get canUndo() { return idx > 0; },
    get canRedo() { return idx < stack.length - 1; },
  };

  // Desktop keyboard.
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (k === "y") { e.preventDefault(); redo(); }
  });

  // Seed the history with the initial (empty) state so the first edit is undoable back to empty.
  record(NS.rough ? NS.rough.getPoints() : []);
})();
