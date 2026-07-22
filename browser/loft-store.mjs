// Copyright (c) 2026 Jurjen Stellingwerff
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// PLAN-PERF §0 step 10 — routing's side of the @PLN105 bridge: element-level access to an EXPOSED
// keyed collection, built on loft's own `readLoftValue` (vendored verbatim in `loft-deliver.js`).
//
// WHY THIS EXISTS. `readLoftValue(mem, base, desc, typeId, rec, pos)` is all-or-nothing: handed the
// layout's root type it materialises the whole `hash<PTile[tkey]>` — 1089 tiles and ~230k nested
// features — into JS objects. That is the opposite of what steps 11-13 want, which is to touch ONLY the
// tiles a viewport overlaps. So this module walks the one level `readLoftValue` cannot enter partially
// (the FlatArray of elements) and then calls it PER ELEMENT.
//
// The addressing is `readLoftValue`'s own, restated for the one node kind we index into — keep the two
// in step if loft's format moves (its `tests/deliver_wasm.rs` is the upstream gate):
//
//   a keyed collection (`hash`/`sorted`/`index`) is pre-flattened at expose time into a data record,
//   found NOT in the node but in the `flat` redirect map keyed by the collection's own `(rec, pos)`:
//     dRec          = desc.flat[`${rec}_${pos}`]        (0 ⇒ empty collection)
//     count         = u32 at storeBase + dRec*8 + 4
//     element i rec = u32 at storeBase + dRec*8 + 8 + 4*i     (its data starts at pos 8)
//
// Every read re-derives its view from `mem.buffer`: `memory.grow` DETACHES the old ArrayBuffer, and the
// kernel grows memory while matching, so a cached DataView goes stale mid-session.
import { readLoftValue } from './loft-deliver.js';

// A handle is what `kernel.exposedValue(tag)` returns: { storeBase, rec, pos, typeId, desc }.
// wasm hands these across as i32/i64, so coerce — mixing a BigInt into the address arithmetic throws.
const addr = (h, rec, pos) => Number(h.storeBase) + Number(rec) * 8 + Number(pos);

function flatRecord(h) {
  const key = `${Number(h.rec)}_${Number(h.pos)}`;
  return Number((h.desc.flat && h.desc.flat[key]) || 0);
}

// How many elements the exposed keyed collection holds. 0 for an empty (or unflattened) collection.
export function flatCount(mem, h) {
  const dRec = flatRecord(h);
  if (!dRec) return 0;
  return new DataView(mem.buffer).getUint32(addr(h, dRec, 4), true);
}

// The record index of element `i` — cheap (one u32), so a caller can screen elements before paying to
// materialise one. Returns 0 when out of range.
export function flatElementRec(mem, h, i) {
  const dRec = flatRecord(h);
  if (!dRec) return 0;
  const view = new DataView(mem.buffer);
  const n = view.getUint32(addr(h, dRec, 4), true);
  if (i < 0 || i >= n) return 0;
  return view.getUint32(addr(h, dRec, 8 + 4 * i), true);
}

// Materialise element `i` in full, through loft's reader. This is the expensive call — for a PTile it
// decodes every nested ring — so steps 11-13 should screen on the cheap scalars first (see `scalar`).
export function flatElement(mem, h, i) {
  const rec = flatElementRec(mem, h, i);
  if (!rec) return null;
  const node = h.desc.nodes[h.typeId];
  if (!node || node.elem == null) throw new Error(`loft-store: type ${h.typeId} is not a flattened collection`);
  return readLoftValue(mem, Number(h.storeBase), h.desc, node.elem, rec, 8);
}

// Read ONE named scalar field of element `i` without materialising the element. This is the screening
// primitive the viewport filter needs: `ring_hits` only ever consults a tile's `ox`/`oy`, so paying to
// decode its ~200 rings just to reject it would defeat the whole point of the bridge.
export function flatScalar(mem, h, i, fieldName) {
  const rec = flatElementRec(mem, h, i);
  if (!rec) return null;
  const node = h.desc.nodes[h.typeId];
  const elem = h.desc.nodes[node.elem];
  if (!elem || !elem.fields) throw new Error(`loft-store: element type ${node.elem} has no fields`);
  const f = elem.fields.find((x) => x.name === fieldName);
  if (!f) throw new Error(`loft-store: no field ${fieldName} on type ${node.elem}`);
  // `content` is the field's type id (LayoutDesc::fields_json emits {name,pos,content}); `pos` is its
  // byte offset WITHIN the record, and element data starts at pos 8.
  return readLoftValue(mem, Number(h.storeBase), h.desc, f.content, rec, 8 + Number(f.pos));
}

// The element type's field list, as the descriptor sees it — for probes and for wiring the render path.
export function flatFields(h) {
  const node = h.desc.nodes[h.typeId];
  const elem = node ? h.desc.nodes[node.elem] : null;
  return elem && elem.fields ? elem.fields.map((f) => ({ name: f.name, type: f.content, pos: f.pos })) : [];
}
