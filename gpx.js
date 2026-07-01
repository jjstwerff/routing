// routing — GPX UI (PLAN steps 10 + 11). Export: ask the server for the matched route as GPX and
// download it. Import: read a .gpx file, parse its track points in JS (browsers parse XML natively),
// and hand them to the server for cleaning into a sparse editable rough route.

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  // Parse trkpt/rtept/wpt lat/lon out of a GPX document (DOMParser — no XML lib needed).
  function parseGpx(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const pts = [];
    doc.querySelectorAll("trkpt, rtept, wpt").forEach((n) => {
      const lat = parseFloat(n.getAttribute("lat"));
      const lon = parseFloat(n.getAttribute("lon"));
      if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lat, lon });
    });
    return pts;
  }

  function onReady() {
    const exportBtn = document.getElementById("gpx-export");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        if (NS.ws && NS.roughPoints && NS.roughPoints.length >= 2) NS.ws.requestExport(NS.roughPoints);
      });
    }

    const importInput = document.getElementById("gpx-import");
    if (importInput) {
      importInput.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const pts = parseGpx(String(reader.result));
          if (pts.length >= 2 && NS.ws) NS.ws.requestImport(pts); // server cleans → "9:" → rough layer
        };
        reader.readAsText(file);
        e.target.value = ""; // allow re-importing the same file
      });
    }
  }

  if (document.readyState !== "loading") onReady();
  else document.addEventListener("DOMContentLoaded", onReady);
})();
