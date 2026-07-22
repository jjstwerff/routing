// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-PERF §6c — the render path's view of the layout store, WITHOUT copying it out.
//
// WHY THIS EXISTS. `viewFromStore` materialises a viewport into JS objects: `readLoftValue` turns every
// struct into an object and `degRing` explodes every vertex into a boxed `[lat, lon]` pair. Measured on
// the app's own viewport that is 239,135 objects and 33.3 MB of JS heap retained between frames, for
// geometry that is 1.64 MB flat — and projecting those boxed pairs costs 38 ms at CPU_THROTTLE=4, more
// than a whole frame. The bridge exists so JS can READ the store; re-materialising it gives that back.
//
// And the store already holds the ideal layout. loft-deliver stores struct vector elements INLINE at
// `storeBase + vRec*8 + 8` with stride `sizeOf(elem)`, and `Coord` is two 4-byte ints at 0 and 4 — so a
// `vector<Coord>` IS an interleaved Int32Array. `coordLayout()` asserts exactly that against loft's own
// reader, in `make test-map`, because a layout change here would read garbage COORDINATES silently.
//
// So this module builds a per-view INDEX and never touches a vertex again:
//   * per feature: the ring's record + length, its tile origin, and its bounds — all in typed arrays.
//     ~37 bytes/feature, so a whole viewport's index is under 1 MB and holds ZERO per-vertex objects.
//   * per frame: one `Int32Array(mem.buffer)` over wasm memory, and coordinates are read straight out
//     of the store at `i32[o + 2k]`. No copy, no allocation, nothing retained.
//
// ⚠ `memory.grow` DETACHES the ArrayBuffer, and the kernel grows memory while matching. So a typed-array
// view is valid only until the next kernel call: it must be re-derived per frame and NEVER cached across
// one. Record indices and offsets are stable (they are store-relative); only the JS view is not.
//
// The addressing is loft-deliver's own, restated for the nodes we walk — keep in step if loft's format
// moves (its `tests/deliver_wasm.rs` is the upstream gate):
//   value at (rec, pos)     -> byte  storeBase + rec*8 + pos
//   vector field at (r, p)  -> vRec = u32 there; len = u32 at (vRec, 4); elements inline at (vRec, 8 + stride*j)
//   text field at (r, p)    -> sRec = u32 there; len = u32 at (sRec, 4); bytes at (sRec, 8); 0 / >0x7fffffff = null
//   the exposed collection  -> dRec = desc.flat[`${rec}_${pos}`]; count at (dRec, 4); element i's rec at (dRec, 8 + 4i)

const NULL_STR = 0x7fffffff;

// Descriptor lookups. `sizeOf` is the element stride a vector packs by; `field` is a named member's
// byte offset within its record and the type id of its content.
const sizeOf = (d, id) => (d.sizes && d.sizes[id] != null ? +d.sizes[id] : 0);
function field(d, typeId, name) {
  const n = d.nodes[typeId];
  if (!n || !n.fields) throw new Error(`store-geom: type ${typeId} has no fields`);
  const f = n.fields.find((x) => x.name === name);
  if (!f) throw new Error(`store-geom: no field ${name} on type ${typeId}`);
  return { pos: Number(f.pos), content: f.content };
}

// The layout the render path is written against, derived from the descriptor ONCE per build so the hot
// loops below are pure integer arithmetic. Everything here is a fact about the store, not a guess:
// `descMap()` dumps it and `coordLayout()` gates the part that matters.
export function storeLayout(h) {
  const d = h.desc;
  const tile = d.nodes[h.typeId].elem;
  const kind = (name, geomField) => {
    const vec = field(d, tile, name);
    const elem = d.nodes[vec.content].elem;
    return { pos: vec.pos, elem, stride: sizeOf(d, elem), geom: field(d, elem, geomField) };
  };
  return {
    d,
    ox: field(d, tile, 'ox').pos, oy: field(d, tile, 'oy').pos,
    fcount: field(d, tile, 'fcount').pos,
    fmnla: field(d, tile, 'fmnla').pos, fmnlo: field(d, tile, 'fmnlo').pos,
    fmxla: field(d, tile, 'fmxla').pos, fmxlo: field(d, tile, 'fmxlo').pos,
    areas: { ...kind('areas', 'ring'), text: field(d, d.nodes[field(d, tile, 'areas').content].elem, 'cover') },
    buildings: { ...kind('buildings', 'ring'), text: field(d, d.nodes[field(d, tile, 'buildings').content].elem, 'name') },
    lines: { ...kind('lines', 'geom'), text: field(d, d.nodes[field(d, tile, 'lines').content].elem, 'kind'),
             text2: field(d, d.nodes[field(d, tile, 'lines').content].elem, 'name') },
    labels: { ...kind('labels', 'line'), text: field(d, d.nodes[field(d, tile, 'labels').content].elem, 'name'),
              text2: field(d, d.nodes[field(d, tile, 'labels').content].elem, 'kind'),
              rank: field(d, d.nodes[field(d, tile, 'labels').content].elem, 'rank') },
    pois: { pos: field(d, tile, 'pois').pos, elem: d.nodes[field(d, tile, 'pois').content].elem,
            stride: sizeOf(d, d.nodes[field(d, tile, 'pois').content].elem),
            at: field(d, d.nodes[field(d, tile, 'pois').content].elem, 'at'),
            text: field(d, d.nodes[field(d, tile, 'pois').content].elem, 'kind'),
            text2: field(d, d.nodes[field(d, tile, 'pois').content].elem, 'name') },
  };
}

// A growable column of features. Typed arrays, doubled on demand — one allocation per growth, never one
// per feature and never one per vertex.
class Column {
  constructor(cap = 1024) {
    this.n = 0;
    this.rec = new Uint32Array(cap);      // the geometry vector's record (0 = point feature / absent)
    this.len = new Uint32Array(cap);      // vertex count
    this.ox = new Int32Array(cap);        // tile origin, fixed point (deg * 1e7)
    this.oy = new Int32Array(cap);
    this.bb = new Int32Array(cap * 4);    // ABSOLUTE bounds, fixed point: mnla, mxla, mnlo, mxlo
    this.sRec = new Uint32Array(cap);     // primary text record (cover / name / kind) — decoded lazily
    this.sRec2 = new Uint32Array(cap);    // secondary text record (name, where a kind is primary)
    this.num = new Int32Array(cap);       // a per-feature scalar (label rank); 0 otherwise
  }
  grow() {
    const c = this.rec.length * 2, cp = (a, T, k = 1) => { const b = new T(c * k); b.set(a); return b; };
    this.rec = cp(this.rec, Uint32Array); this.len = cp(this.len, Uint32Array);
    this.ox = cp(this.ox, Int32Array); this.oy = cp(this.oy, Int32Array);
    this.bb = cp(this.bb, Int32Array, 4);
    this.sRec = cp(this.sRec, Uint32Array); this.sRec2 = cp(this.sRec2, Uint32Array);
    this.num = cp(this.num, Int32Array);
  }
  push(rec, len, ox, oy, mnla, mxla, mnlo, mxlo, sRec, sRec2, num) {
    if (this.n === this.rec.length) this.grow();
    const i = this.n++;
    this.rec[i] = rec; this.len[i] = len; this.ox[i] = ox; this.oy[i] = oy;
    this.bb[i * 4] = mnla; this.bb[i * 4 + 1] = mxla; this.bb[i * 4 + 2] = mnlo; this.bb[i * 4 + 3] = mxlo;
    this.sRec[i] = sRec; this.sRec2[i] = sRec2; this.num[i] = num;
  }
}

// Decode a loft text record. Cached by record so a `cover` value shared by 2000 areas is ONE string —
// the cardinality of these fields is tiny, and the cache is what keeps the index allocation-free in
// practice rather than only in principle.
export function decodeText(mem, sb, rec, cache) {
  if (!rec || rec > NULL_STR) return null;
  if (cache) { const hit = cache.get(rec); if (hit !== undefined) return hit; }
  const dv = new DataView(mem.buffer);
  const len = dv.getUint32(sb + rec * 8 + 4, true);
  const s = new TextDecoder().decode(new Uint8Array(mem.buffer, sb + rec * 8 + 8, len));
  if (cache) cache.set(rec, s);
  return s;
}

// Build the per-view index: walk the tiles the viewport touches and record, per feature, WHERE its
// geometry lives and what it spans. Never decodes a coordinate into a JS value.
//
// `fbox` is fixed-point {mnla, mnlo, mxla, mxlo}, the same space `parse_fbox` and `ring_hits` use, and
// the per-feature overlap test below is `ring_hits` restated on the flat view — same inclusive compare,
// so the same features survive.
export function buildIndex(mem, h, L, fbox, kinds) {
  const sb = Number(h.storeBase), d = h.desc;
  const dv = new DataView(mem.buffer);
  const i32 = new Int32Array(mem.buffer);
  const u32 = (a) => dv.getUint32(a, true);
  const i64 = (a) => Number(dv.getBigInt64(a, true));
  const dRec = Number((d.flat && d.flat[`${Number(h.rec)}_${Number(h.pos)}`]) || 0);
  const out = { tilesRead: 0, tilesTotal: 0 };
  for (const k of kinds) out[k] = new Column();
  if (!dRec) return out;
  const nTiles = u32(sb + dRec * 8 + 4);
  out.tilesTotal = nTiles;

  // One ring: bounds from the flat coords, then the ring_hits overlap test. Returns 0 when the ring
  // misses the box or is empty, so the caller can skip it without a second pass.
  const ringSpan = new Int32Array(4);
  const spanOf = (vRec, ox, oy) => {
    if (!vRec) return 0;
    const len = u32(sb + vRec * 8 + 4);
    if (!len) return 0;
    const o = (sb + vRec * 8 + 8) >> 2;                      // Int32 index of the first coord
    let mnla = 2147483647, mxla = -2147483648, mnlo = 2147483647, mxlo = -2147483648;
    for (let k = 0; k < len; k++) {
      const lo = ox + i32[o + 2 * k], la = oy + i32[o + 2 * k + 1];
      if (la < mnla) mnla = la; if (la > mxla) mxla = la;
      if (lo < mnlo) mnlo = lo; if (lo > mxlo) mxlo = lo;
    }
    if (mxla < fbox.mnla || mnla > fbox.mxla || mxlo < fbox.mnlo || mnlo > fbox.mxlo) return 0;
    ringSpan[0] = mnla; ringSpan[1] = mxla; ringSpan[2] = mnlo; ringSpan[3] = mxlo;
    return len;
  };

  for (let t = 0; t < nTiles; t++) {
    const tRec = u32(sb + dRec * 8 + 8 + 4 * t);
    if (!tRec) continue;
    const tAt = sb + tRec * 8 + 8;                            // element data starts at pos 8
    // §7g's sealed feature extent: five scalars decide the tile before any geometry is touched.
    const fcount = i64(tAt + L.fcount);
    if (fcount > 0) {
      if (i64(tAt + L.fmxla) < fbox.mnla || i64(tAt + L.fmnla) > fbox.mxla
       || i64(tAt + L.fmxlo) < fbox.mnlo || i64(tAt + L.fmnlo) > fbox.mxlo) continue;
    }
    out.tilesRead++;
    const ox = i64(tAt + L.ox), oy = i64(tAt + L.oy);

    for (const k of kinds) {
      const spec = L[k], col = out[k];
      const vRec = u32(tAt + spec.pos);
      if (!vRec) continue;
      const n = u32(sb + vRec * 8 + 4);
      const eBase = sb + vRec * 8 + 8;
      for (let j = 0; j < n; j++) {
        const eAt = eBase + spec.stride * j;
        if (k === 'pois') {
          // A poi's Coord is INLINE in the element (at@8), not a vector — one point, no ring.
          const lo = ox + i32[(eAt + spec.at.pos) >> 2], la = oy + i32[(eAt + spec.at.pos + 4) >> 2];
          if (la < fbox.mnla || la > fbox.mxla || lo < fbox.mnlo || lo > fbox.mxlo) continue;
          col.push(0, 1, ox, oy, la, la, lo, lo, u32(eAt + spec.text.pos), u32(eAt + spec.text2.pos), 0);
          continue;
        }
        const gRec = u32(eAt + spec.geom.pos);
        const len = spanOf(gRec, ox, oy);
        if (!len) continue;
        col.push(gRec, len, ox, oy, ringSpan[0], ringSpan[1], ringSpan[2], ringSpan[3],
                 spec.text ? u32(eAt + spec.text.pos) : 0,
                 spec.text2 ? u32(eAt + spec.text2.pos) : 0,
                 spec.rank ? i64(eAt + spec.rank.pos) : 0);
      }
    }
  }
  return out;
}
