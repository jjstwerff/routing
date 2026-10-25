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
//     element i     = at storeBase + dRec*8 + 8 + stride*i — stride 4: a rec, data at pos 8;
//                     stride 8 (a hash, loft #842): a (rec, pos) pair. `flatSlot` below is the one copy.
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

// Where element `i` of a flattened keyed collection lives: `{ rec, pos }`, the record and the byte
// position of its payload inside it — so a field at descriptor offset `f.pos` is at `rec*8 + pos + f.pos`.
//
// THE ONE PLACE routing computes this; loft-deliver's `flatarray` case is the rule it copies (keep the two
// in step when re-vendoring). It changed in loft @PLN135 arc H (#842): a HASH's entries are slots in a
// chunked arena with no record of their own, so its element is a `(record, offset)` PAIR, stride 8. A
// radix / trie / index element is still a record number whose payload starts at byte 8, stride 4 — and a
// descriptor with no `stride` is one written before the field existed, which means 4. Reading a hash
// with the old stride-4 rule takes every other word for a record number, which is how the layout store
// (a `hash<PTile[tkey]>`) would read garbage under a new runtime with an old reader.
export function flatSlot(view, storeBase, desc, typeId, dRec, i) {
  const stride = Number(desc.nodes[typeId] && desc.nodes[typeId].stride) || 4;
  const at = Number(storeBase) + Number(dRec) * 8 + 8 + stride * i;
  const rec = view.getUint32(at, true);
  return { rec, pos: stride === 8 ? view.getUint32(at + 4, true) : 8 };
}

// How many elements the exposed keyed collection holds. 0 for an empty (or unflattened) collection.
export function flatCount(mem, h) {
  const dRec = flatRecord(h);
  if (!dRec) return 0;
  return new DataView(mem.buffer).getUint32(addr(h, dRec, 4), true);
}

// Where element `i` is — `{ rec, pos }` (see `flatSlot`) — cheap, two u32 reads at most, so a caller can
// screen elements before paying to materialise one. `null` when out of range or empty.
export function flatElementAt(mem, h, i) {
  const dRec = flatRecord(h);
  if (!dRec) return null;
  const view = new DataView(mem.buffer);
  const n = view.getUint32(addr(h, dRec, 4), true);
  if (i < 0 || i >= n) return null;
  const at = flatSlot(view, h.storeBase, h.desc, h.typeId, dRec, i);
  return at.rec ? at : null;
}

// Materialise element `i` in full, through loft's reader. This is the expensive call — for a PTile it
// decodes every nested ring — so steps 11-13 should screen on the cheap scalars first (see `scalar`).
export function flatElement(mem, h, i) {
  const at = flatElementAt(mem, h, i);
  if (!at) return null;
  const node = h.desc.nodes[h.typeId];
  if (!node || node.elem == null) throw new Error(`loft-store: type ${h.typeId} is not a flattened collection`);
  return readLoftValue(mem, Number(h.storeBase), h.desc, node.elem, at.rec, at.pos);
}

// Read ONE named field of element `i` without materialising the rest of the element. This is the
// selectivity the bridge exists for, in two ways: a scalar screen (`ox`/`oy` — all `ring_hits` consults,
// so paying to decode a tile's ~200 rings just to reject it would defeat the point), and a per-KIND read
// (`areas` alone, not buildings+lines+labels+pois too — which is how steps 11-13 land one kind at a
// time). Works for any field the descriptor knows: `content` carries its type id, scalar or collection.
export function flatField(mem, h, i, fieldName) {
  const at = flatElementAt(mem, h, i);
  if (!at) return null;
  const node = h.desc.nodes[h.typeId];
  const elem = h.desc.nodes[node.elem];
  if (!elem || !elem.fields) throw new Error(`loft-store: element type ${node.elem} has no fields`);
  const f = elem.fields.find((x) => x.name === fieldName);
  if (!f) throw new Error(`loft-store: no field ${fieldName} on type ${node.elem}`);
  // `content` is the field's type id (LayoutDesc::fields_json emits {name,pos,content}); `pos` is its
  // byte offset WITHIN the element, whose payload starts at `at.pos` (8 for a record of its own).
  return readLoftValue(mem, Number(h.storeBase), h.desc, f.content, at.rec, at.pos + Number(f.pos));
}

// The element type's field list, as the descriptor sees it — for probes and for wiring the render path.
export function flatFields(h) {
  const node = h.desc.nodes[h.typeId];
  const elem = node ? h.desc.nodes[node.elem] : null;
  return elem && elem.fields ? elem.fields.map((f) => ({ name: f.name, type: f.content, pos: f.pos })) : [];
}
