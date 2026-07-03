// routing — named route store client (PLAN step 16). Save / list / open / delete named routes,
// stored server-side (write-through to disk — the close-the-browser-safe headline). The working
// sketch autosaves on every match; on a fresh page with an empty sketch it is restored silently,
// so closing the tab never loses work. The panel is closed by default (low floor).

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const toggle = document.getElementById("routes-toggle");
  const panel = document.getElementById("routes-panel");
  const listEl = document.getElementById("routes-list");
  const nameInput = document.getElementById("route-name");
  const saveBtn = document.getElementById("route-save");

  let open = false;
  let names = [];
  let proposed = "";     // the last auto-proposed name — typed text always wins (step 17)
  let proposedFor = "";  // sketch encoding the proposal was asked for (dedupe)

  function setOpen(want) {
    open = want;
    panel.classList.toggle("hidden", !open);
    toggle.classList.toggle("is-active", open);
    if (open && NS.ws) {
      NS.ws.requestRoutesList();
      maybePropose();
    }
  }

  // Step 17: prefill the name input with "area · length · type" — only while the field is empty
  // (or still holding an earlier proposal), so editing the name sticks. Lag-tolerant by nature.
  function maybePropose() {
    const pts = NS.roughPoints || [];
    if (pts.length < 2) return;
    if (nameInput.value !== "" && nameInput.value !== proposed) return;
    const spec = pts.map((p) => p.lat + "," + p.lon).join(";");
    if (spec === proposedFor) return;
    proposedFor = spec;
    if (NS.ws) NS.ws.requestName();
  }

  // "21:" payload — the proposed name (from ws.js).
  function applyName(name) {
    if (!name) return;
    if (nameInput.value === "" || nameInput.value === proposed) nameInput.value = name;
    proposed = name;
  }

  function renderList() {
    listEl.innerHTML = "";
    if (names.length === 0) {
      const li = document.createElement("li");
      li.className = "routes-empty";
      li.textContent = "no saved routes yet";
      listEl.appendChild(li);
      return;
    }
    for (const nm of names) {
      const li = document.createElement("li");
      const openBtn = document.createElement("button");
      openBtn.className = "route-open";
      openBtn.textContent = nm;
      openBtn.addEventListener("click", () => { if (NS.ws) NS.ws.openRoute(nm); });
      const delBtn = document.createElement("button");
      delBtn.className = "route-del";
      delBtn.setAttribute("aria-label", `Delete ${nm}`);
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", () => { if (NS.ws) NS.ws.deleteRoute(nm); });
      li.append(openBtn, delBtn);
      listEl.appendChild(li);
    }
  }

  // "13:" payload — newline-separated names (from ws.js).
  function applyList(payload) {
    names = payload ? payload.split("\n").filter(Boolean) : [];
    renderList();
  }

  const decodePts = (spec) =>
    spec
      .split(";")
      .filter(Boolean)
      .map((pair) => {
        const c = pair.split(",");
        return { lat: parseFloat(c[0]), lon: parseFloat(c[1]) };
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  // "17:" payload — "<name>|<profile>|<points>|<history>" ("" when unknown; history only for
  // `_working` — the persisted undo stack, "#"-separated snapshots) (from ws.js).
  function applyRoute(payload) {
    if (!payload) {
      // Nothing to restore — a genuinely fresh map: locate it coarsely by the timezone's city.
      if (NS.ws && NS.ws.requestLocate) NS.ws.requestLocate();
      return;
    }
    const bar = payload.indexOf("|");
    const bar2 = payload.indexOf("|", bar + 1);
    if (bar < 0 || bar2 < 0) return;
    const nm = payload.slice(0, bar);
    const profile = payload.slice(bar + 1, bar2);
    const bar3 = payload.indexOf("|", bar2 + 1);
    const pts = decodePts(bar3 >= 0 ? payload.slice(bar2 + 1, bar3) : payload.slice(bar2 + 1));
    const hist = bar3 >= 0 ? payload.slice(bar3 + 1) : "";
    // The silent working-route restore must never clobber a sketch the user already started.
    if (nm === "_working" && NS.roughPoints && NS.roughPoints.length > 0) return;
    if (pts.length < 2) return;
    if (NS.setProfile) NS.setProfile(profile);
    if (NS.rough && NS.rough.setPoints) NS.rough.setPoints(pts);
    // Draft save: the working sketch resumes WITH its undo stack (imported after setPoints so the
    // restore itself doesn't append a duplicate entry).
    if (nm === "_working" && hist && NS.undo && NS.undo.importHistory) {
      NS.undo.importHistory(hist.split("#").map(decodePts));
    }
    if (NS.map && pts.length) NS.map.fitBounds(pts.map((p) => [p.lat, p.lon]), { padding: [40, 40] });
    if (nm !== "_working") {
      nameInput.value = nm;
      setOpen(false);
    }
  }

  // First WS connect (from ws.js): restore the autosaved working sketch onto an empty page.
  function onConnect() {
    if (!NS.roughPoints || NS.roughPoints.length === 0) NS.ws.openRoute("_working");
  }

  saveBtn.addEventListener("click", () => {
    const nm = (nameInput.value || "").trim();
    if (!NS.ws || !NS.roughPoints || NS.roughPoints.length < 2) return;
    NS.ws.saveRoute(nm || "route");
  });
  toggle.addEventListener("click", () => setOpen(!open));

  NS.routes = { applyList, applyRoute, applyName, onConnect };
})();
