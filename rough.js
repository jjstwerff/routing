// routing — the ROUGH layer (DESIGN.md §1, §2).
//
// The shape you sketch: an ordered list of points, consecutive points joined by STRAIGHT lines.
// First point = start, last = finish — a distinct point type from the intermediates. The rough
// line is ALWAYS open; there is no "close the loop" action (round-trip closure is inferred later,
// on the *detailed* layer, in step 9). JS owns these pixels; loft never sees the rough markers.
//
// The tiny primitive set this exposes (kept deliberately small, DESIGN.md binding 1):
//   • tap empty map            → append a point (extends the route; new point becomes the finish)
//   • tap a segment            → insert a point there, between that segment's two endpoints
//   • drag a point             → move it (line follows live)
//   • double-click a point     → delete it (mouse)
//   • tap-select + Delete btn  → delete it (touch); Delete/Backspace key also works; Esc deselects

"use strict";

(function () {
  const NS = (window.routing = window.routing || {});

  const HIT_WEIGHT = 18;     // fat transparent line = a finger-friendly tap target for insert
  const DOUBLE_TAP_MS = 250; // collapse the 2nd click of a same-spot double-click (avoid double-add)
  const DOUBLE_TAP_PX = 12;
  const TOUCH_BOX = 30;      // generous square touch target around each (smaller) visible dot

  let _seq = 0;
  const nextId = () => (++_seq);

  // A point's marker icon depends only on its role (start / finish / mid) and whether it's selected.
  function pointIcon(role, selected) {
    const dot = role === "mid" ? 14 : 18;
    const cls = ["rough-pt", "rough-pt--" + role];
    if (selected) cls.push("is-selected");
    return L.divIcon({
      className: "rough-pt-wrap",            // custom class → drops Leaflet's default white box
      html: '<span class="' + cls.join(" ") + '" style="--dot:' + dot + 'px"></span>',
      iconSize: [TOUCH_BOX, TOUCH_BOX],
      iconAnchor: [TOUCH_BOX / 2, TOUCH_BOX / 2],
    });
  }

  class RoughLayer {
    constructor(map, opts) {
      opts = opts || {};
      this.map = map;
      this.onChange = opts.onChange || function () {};
      this._pts = [];            // ordered [{ id, marker }]
      this._selectedId = null;
      this._lastMapClick = null; // { t, p } for double-tap dedupe

      // Two stacked polylines: a fat transparent hit target (catches insert taps) and, on top of
      // it, the visible dashed sketch line (non-interactive, so taps fall through to the hit line).
      this._hitLine = L.polyline([], {
        opacity: 0, weight: HIT_WEIGHT, interactive: true,
        lineCap: "round", lineJoin: "round",
      }).addTo(map);
      this._line = L.polyline([], {
        className: "rough-line", interactive: false,
        color: "#2b6cff", weight: 3, opacity: 0.9, dashArray: "6 7",
        lineCap: "round", lineJoin: "round",
      }).addTo(map);

      this._hitLine.on("click", (e) => this._onLineClick(e));
      map.on("click", (e) => this._onMapClick(e));
      document.addEventListener("keydown", (e) => this._onKey(e));

      this._deleteBtn = document.getElementById("rough-delete");
      if (this._deleteBtn) {
        this._deleteBtn.addEventListener("click", () => this.deleteSelected());
      }
    }

    // ---- public read-out -------------------------------------------------

    // Current rough shape as plain {lat, lon} (DESIGN.md §9). first = start, last = finish.
    getPoints() {
      return this._pts.map(({ marker }) => {
        const ll = marker.getLatLng();
        return { lat: ll.lat, lon: ll.lng };
      });
    }

    // ---- mutations -------------------------------------------------------

    append(latlng) {
      this._insertAt(this._pts.length, latlng);
    }

    // Create a draggable point marker (no refresh/emit — callers batch that).
    _makeMarker(latlng) {
      const id = nextId();
      const marker = L.marker(latlng, {
        draggable: true,
        keyboard: false,
        icon: pointIcon("mid", false), // role fixed up by _refresh()
      });
      marker.on("click", () => this._toggleSelect(id));
      marker.on("dblclick", () => this._removeId(id));   // mouse delete
      // Line AND length follow the finger live, every frame (DESIGN.md §1: length is instant).
      marker.on("drag", () => { this._redrawLines(); this._emit(); });
      marker.on("dragend", () => this._emit());
      marker.addTo(this.map);
      return { id, marker };
    }

    _insertAt(index, latlng) {
      this._pts.splice(index, 0, this._makeMarker(latlng));
      this._refresh();
      this._emit();
    }

    // Replace the whole rough route (PLAN step 11 — a cleaned imported GPX track).
    setPoints(points) {
      for (const pt of this._pts) this.map.removeLayer(pt.marker);
      this._pts = [];
      this._selectedId = null;
      for (const p of points) this._pts.push(this._makeMarker(L.latLng(p.lat, p.lon)));
      this._refresh();
      this._emit();
    }

    deleteSelected() {
      if (this._selectedId !== null) this._removeId(this._selectedId);
    }

    _removeId(id) {
      const i = this._pts.findIndex((p) => p.id === id);
      if (i < 0) return;
      this.map.removeLayer(this._pts[i].marker);
      this._pts.splice(i, 1);
      if (this._selectedId === id) this._selectedId = null;
      this._refresh();
      this._emit();
    }

    // ---- input handlers --------------------------------------------------

    _onMapClick(e) {
      // Empty-map tap extends the route. Collapse the 2nd click of a same-spot double-click so a
      // double-tap doesn't drop two stacked points (doubleClickZoom is off — see app.js).
      const now = (e.originalEvent && e.originalEvent.timeStamp) || performance.now();
      const p = this.map.latLngToContainerPoint(e.latlng);
      if (this._lastMapClick) {
        const dt = now - this._lastMapClick.t;
        const dpx = p.distanceTo(this._lastMapClick.p);
        if (dt < DOUBLE_TAP_MS && dpx < DOUBLE_TAP_PX) { this._lastMapClick = null; return; }
      }
      this._lastMapClick = { t: now, p };
      this._clearSelection();
      this.append(e.latlng);
    }

    _onLineClick(e) {
      // Tap a segment → insert a point there, between that segment's endpoints.
      const seg = this._nearestSegment(e.latlng);
      this._insertAt(seg + 1, e.latlng);
    }

    _onKey(e) {
      if (this._selectedId === null) return;
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key === "Escape") {
        this._clearSelection();
      }
    }

    // ---- selection -------------------------------------------------------

    _toggleSelect(id) {
      this._selectedId = (this._selectedId === id) ? null : id;
      this._refresh();
    }

    _clearSelection() {
      if (this._selectedId !== null) {
        this._selectedId = null;
        this._refresh();
      }
    }

    // ---- geometry helpers ------------------------------------------------

    // Index i of the segment (points[i] → points[i+1]) closest to `latlng`, in screen pixels so it
    // matches what the user visually tapped. Insert goes at i+1.
    _nearestSegment(latlng) {
      const click = this.map.latLngToLayerPoint(latlng);
      let best = 0, bestD = Infinity;
      for (let i = 0; i < this._pts.length - 1; i++) {
        const a = this.map.latLngToLayerPoint(this._pts[i].marker.getLatLng());
        const b = this.map.latLngToLayerPoint(this._pts[i + 1].marker.getLatLng());
        const near = L.LineUtil.closestPointOnSegment(click, a, b);
        const d = click.distanceTo(near);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    // ---- rendering -------------------------------------------------------

    _refresh() {
      const n = this._pts.length;
      this._pts.forEach((pt, i) => {
        const role = (i === 0) ? "start" : (i === n - 1 ? "finish" : "mid");
        pt.marker.setIcon(pointIcon(role, pt.id === this._selectedId));
      });
      this._redrawLines();
      if (this._deleteBtn) {
        this._deleteBtn.classList.toggle("hidden", this._selectedId === null);
      }
    }

    _redrawLines() {
      const lls = this._pts.map((p) => p.marker.getLatLng());
      this._line.setLatLngs(lls);
      this._hitLine.setLatLngs(lls);
    }

    _emit() {
      this.onChange(this.getPoints());
    }
  }

  NS.RoughLayer = RoughLayer;
})();
