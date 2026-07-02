// routing — activity × sub-mode controls (PLAN step 8, DESIGN §6). Two selectors build the match
// profile ("<activity>_<submode>") sent with each match request, and switch the Waymarkedtrails
// overlay. Changing either re-matches immediately — the "lock in fast" win: a good first match from
// the activity choice, with no point edits.

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  // Order matters — it drives the dropdowns. [label, submode-id]; overlay is the WMT layer.
  const ACT = {
    Running: { subs: [["Fast", "fast"], ["Trail", "trail"]], overlay: "hiking" },
    Walking: { subs: [["Paved", "paved"], ["Trail", "trail"]], overlay: "hiking" },
    Cycling: { subs: [["Road", "road"], ["Gravel", "gravel"], ["MTB", "mtb"]], overlay: "cycling" },
    Driving: { subs: [["Fastest", "fastest"], ["Avoid motorways", "avoid"]], overlay: null },
  };
  const KEY = { Running: "running", Walking: "walking", Cycling: "cycling", Driving: "driving" };

  let activity = "Walking";
  let subId = "paved";

  NS.getProfile = () => KEY[activity] + "_" + subId;

  // Step 16: restore a stored "<activity>_<submode>" (opening a saved/working route). Updates the
  // selectors + overlay but does NOT re-match — the caller applies the points, which re-matches.
  NS.setProfile = (profile) => {
    const us = profile.indexOf("_");
    const actKey = profile.slice(0, us);
    const sub = profile.slice(us + 1);
    const name = Object.keys(KEY).find((k) => KEY[k] === actKey);
    if (!name || !ACT[name].subs.some(([, id]) => id === sub)) return;
    activity = name;
    subId = sub;
    const aSel = document.getElementById("activity");
    const sSel = document.getElementById("submode");
    if (aSel && sSel) {
      aSel.value = name;
      sSel.innerHTML = ACT[name].subs
        .map(([label, id]) => `<option value="${id}"${id === sub ? " selected" : ""}>${label}</option>`)
        .join("");
    }
    syncOverlay();
  };

  // --- Waymarkedtrails overlay (MTB sub-mode → the mtb layer; else the activity's overlay) ---
  const layers = {};
  let currentOverlay = null;
  function wantedOverlay() {
    if (activity === "Cycling" && subId === "mtb") return "mtb";
    return ACT[activity].overlay;
  }
  function layer(name) {
    if (!name) return null;
    if (!layers[name]) {
      layers[name] = L.tileLayer(`https://tile.waymarkedtrails.org/${name}/{z}/{x}/{y}.png`, {
        maxZoom: 19, opacity: 0.7,
        attribution: '&copy; <a href="https://waymarkedtrails.org">Waymarkedtrails</a>',
      });
    }
    return layers[name];
  }
  function syncOverlay() {
    const map = NS.map;
    if (!map) return;
    const want = wantedOverlay();
    if (currentOverlay && currentOverlay !== want) {
      const l = layer(currentOverlay);
      if (l) map.removeLayer(l);
    }
    if (want) {
      const l = layer(want);
      if (l && !map.hasLayer(l)) l.addTo(map);
    }
    currentOverlay = want;
  }

  function rematch() {
    if (NS.ws && NS.roughPoints) NS.ws.sendPoints(NS.roughPoints);
  }

  function build() {
    const aSel = document.getElementById("activity");
    const sSel = document.getElementById("submode");
    if (!aSel || !sSel) return;

    aSel.innerHTML = Object.keys(ACT)
      .map((a) => `<option${a === activity ? " selected" : ""}>${a}</option>`).join("");
    const fillSubs = () => {
      sSel.innerHTML = ACT[activity].subs
        .map(([label, id]) => `<option value="${id}"${id === subId ? " selected" : ""}>${label}</option>`)
        .join("");
    };
    fillSubs();

    aSel.addEventListener("change", () => {
      activity = aSel.value;
      subId = ACT[activity].subs[0][1]; // reset sub-mode to the first for the new activity
      fillSubs();
      syncOverlay();
      rematch();
    });
    sSel.addEventListener("change", () => {
      subId = sSel.value;
      syncOverlay();
      rematch();
    });
    syncOverlay();
  }

  if (document.readyState !== "loading") build();
  else document.addEventListener("DOMContentLoaded", build);
})();
