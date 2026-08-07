<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# What a name search costs, and the word index that replaces the whole-store read

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-07 · **Owns:** the name store's read cost, the word-prefix index that bounds it, and the measurements behind both

`HANDOFF.md` §1 item 3 records that `coverage.names.store` "does not scale past this rung" and asks for
the cost to be settled in @51 phase E. This is that costing.

⚠ **THREE binaries in one day, and `--version` does not tell them apart.** Everything here was measured
on 2026-08-07, and `/usr/local/bin/loft` was reinstalled **twice while this document was being
written**. All three call themselves **2026.8.0**:

| | md5 | installed | what moved |
|---|---|---|---|
| A | `759a417227355415fd7bd6e94657ede4` | 2026-08-06 18:46 | — |
| B | `51e15f8a0bb3f93e3772e5d0e7f94b77` | 2026-08-07 13:35 | a text-keyed `spatial` RANGE is refused (§2a) |
| **C** | **`d83e8f5d1d8fbd300445d941bb155917`** | **2026-08-07 22:56** | **`trie<T[k]>` exists (§2c); loft#799 fixed** |

§1's numbers are properties of the *data and the host*, not of loft, and are unchanged throughout.
**§2 and §3 are properties of the compiler, and each re-probe changed a conclusion** — B corrected §2a,
C obsoleted §3d *twice over* and answered two of §7's open questions. This is the `CLAUDE.md` rule
*"anchor a finding to the binary you will report it against"* earning its place three times in one day:
every version of §3d was correct when written, and two of them were wrong within hours.

**The short form.** The ceiling is real but **3× smaller than recorded**, the store is already as small
as loft will make it, and a **word-prefix index of 7.2 MB replaces a 21.4 MB whole-store read with a
0.1–16 kB range read** while returning a byte-identical top-8 for 91.5% of queries and a *shorter* list
— never a wrong one — for the rest.

---

## 1. Three corrections to the premise

Each of these was believed before it was measured, and each would have sent the work at the wrong
target.

### 1a. ⚠ The store is 21.4 MB on the wire, not 63.5 MB

GitHub Pages gzips a whole-file GET. Measured in a real browser against the live site — first with a
throwaway probe (`encodedBodySize 21 397 927` against `decodedBodySize 63 468 112`), then reproduced by
the repaired `browser/cdp_names_cost.mjs`, which is the version that stays:

```
request    : coverage.names.store 200 gzip — 21.41 MB on the wire
wire       : 21.41 MB crossed the link as `gzip`, decoding to 63.47 MB (3.0x)
```

⚠ **The two numbers come from different CDP sources and agree** — Resource Timing's `encodedBodySize`
and `Network.loadingFinished.encodedDataLength` (21 409 918, the extra ~12 kB being headers). That
agreement is the check; a single source here would have been the third instrument bug in this file.

**3.0× compression, and none of it was visible to the instrument that produced the recorded number.**
`browser/cdp_names_cost.mjs` runs against `_site` behind `tools/range_server.py`, which sends no
`Content-Encoding` — so a `THROTTLE_KBPS` run carries the full 63.5 MB where the live host carries
21.4. The honest projections:

| link | recorded | measured/derived |
|---|---|---|
| localhost — decode only | 262 ms | 262 ms (unchanged — no transfer) |
| 82 Mbps / 45 ms | 7 199 ms | **~2 100 ms** |
| 10 Mbps / 80 ms — a phone | 49 893 ms | **~17 000 ms** |
| Western Europe (7.9×) on a phone | ~6.5 min | **~2.3 min** |

Still a wall at WE, so the index below is still the work. **But this rung is not on fire**, and the
phase-E decision should not be made against the 3× figure. Same family as `prefetch_gate`'s harness
(`HANDOFF` §2): *an emulator generous with one resource is not a slower reality, it is a different
question.* The probe is fixed (§6).

### 1b. The store is already compact — the slack is loft's, not the pipeline's

`cut-regions.sh` runs `store_compact_probe.loft` over every roads block it produces; the names store is
built by `gen-names.loft` from `refresh-region.sh` and passes through neither, so "it was never bound"
was the obvious hypothesis. It is wrong. Binding a **copy** with a `NameRec`-typed probe:

```
#N bind=true records=518804
#N text name=7092498 fold=7060988
#N bytes before=63468112 after=63468112
```

**Not one byte.** 518 804 records × 26 B + 14.15 MB of text ≈ 27.6 MB of content in a 63.5 MB file, and
**52.4% of the file is zero bytes** — which is exactly why it gzips 3× — but binding sheds none of it.
So there is no free 2.3× here, and the wire cost in §1a is the honest baseline.

### 1c. ⚠ A ranged read gets identity bytes — no gzip

This is the one that constrains the design: **an index that reads by RANGE competes against 21.4 MB
gzipped, not 63.5 MB raw.** Measured in Chrome against the live host:

```
content-range: bytes 1000000-1001023/16691480   content-encoding: null   bytes hash-identical to the identity fetch
```

⚠ **And a hazard for anything that is not a browser.** `curl` advertising gzip gets ranges over the
*compressed* stream: `content-range: bytes 0-65535/21397927` — the gzip total, not the store's — and a
body that will not gunzip (`curl --compressed` exits 61, `size_download=0`). Every live store behaves
this way: `belgium.roads` reports `/68001583` compressed against its real size, `overview.base`
`/13452351`, `coverage.pagesx` `/2345381`. **Chrome does not take that path, so the app is correct and
this is not a live defect** — but a native client, a CI check or a `curl`-based gate reading these
stores by range would silently read the wrong file. Same family as *"only a GET measures a range"*.

---

## 2. What loft offers today — measured, not read

The obvious structure for "hold something small in memory that says where to look further" is a radix
tree, and **loft has one**: `src/radix_tree.rs` is a fully-implemented store-backed binary PATRICIA tree
over an abstract bit-key oracle, with `src/radix_db.rs` as the DB↔tree bridge (`DATABASE.md` §*Spatial
Index*). What was not established is what the *language* exposes. Probed on both backends, on binary B:

| written | result |
|---|---|
| `radix<W[w]>` (text key) | ✗ `Subtype only allowed on structures` |
| `radix<W[x]>` (integer key) | ✗ same |
| `radix<W>` (no key) | ✗ same |
| `radix<W[w]>` as a struct field | ✗ same |
| `spatial<W[x,y]>` | ✓ compiles |
| `spatial<W[x]>` (1 axis) | ✓ compiles |
| `spatial<W[w]>` (TEXT key) — **declaration** | ✓ compiles on A/B — **and the key is not a key, §2a** · ✗ **refused on C** |
| `spatial<W[w]>` — `c["kerk".."kerl"]` | ✗ refused on B/C, silently wrong on A |
| **`sorted<W[w]>` + `c["kerk".."kerl"]`** | ✓ **works, both backends, all three binaries** |
| **`trie<W[w]>` + `c["kerk"..]`** | ✓ **C only — the kind this design wanted, see §2c** |

So `radix` is a reserved keyword with **no language surface on any of the three**; the tree is reachable
through `spatial` (Morton oracle) and, since C, through **`trie` (byte oracle)** — `DATABASE.md` is
explicit that these share `radix_tree.rs` and nothing above it, because *"a bounding box means nothing
for a word, and a prefix means nothing for a coordinate"*.

### 2c. `trie<T[k]>` — the kind this design was hand-rolling

Landed in binary C (2026-08-07 22:56). One **text** key, refused at the keyword if given more. Probed
on both backends with a `sorted` control in the same file (`tools/trie_probe.loft`), all identical:

| asked | answer |
|---|---|
| `t["kerklaan"]` | the record |
| `t["kerkl"]` — a strict PREFIX of real keys | **`null`, never a neighbour** |
| `for x in t` | `kerf kerk kerklaan kerkstraat kerkweg lonneker` — byte order |
| **`t["kerk"..]`** | **the four kerk-words — no successor string** |
| `t["kerk"..:2]` | the first two, in key order |
| `t["zzz"..]` | 0 — not the whole collection |
| `type_of(t)` | `kind=KeyedKind collection=KeyedTrie element=Word`, `key w @8 ascending=true` |

**`t[a..b]` is refused and names `sorted`** as the kind that answers an interval — the two kinds are
deliberately not interchangeable. And loft#799's fix (also in C) makes the old mistake un-writable:

```
error: a spatial index interleaves its axes into a Morton code, which needs numbers, and `w` is
       text — use `trie<Word[w]>`, which keys on text and answers a prefix
```

⚠ **What it does NOT do is page** — §3d has the measurement, and it is the reason this section does not
end the design question.

### 2a. ⚠ A text-keyed `spatial` — half fixed on B, and the remaining half is the quiet one

On binary A a text-keyed `spatial` compiled and silently did nothing. On B the **range** is refused at
compile time, with a message that teaches:

```
error: a `spatial` range is a COORDINATE slice, not a scalar one — write `s[(x1, y1)..(x2, y2)]`
       (the bounding box), or iterate the whole collection with `for x in s`
```

**The declaration is still accepted, and still silently wrong.** Same five words, B, both backends:

```
#X len=5                                               ← correct
#X point: NULL                                         ← for a key that IS present
#X order: kerkstraat kerklaan lonneker kerf kerkweg    ← INSERTION order, not key order
```

`len()` is right, so the records are there; the key is simply not a key. The loud symptom got a good
error and the quiet one did not — which is the worse half to leave, because a point lookup returning
NULL reads as "not found" rather than as a defect. This is the shape `DATABASE.md` warns about in
*"Adding or changing a collection kind"*: a per-kind dispatch omission that "does not read as a missing
feature", the way loft#720 was three at once. **Filed as
[loft#799](https://github.com/loft-lang/loft/issues/799)** (`docs/loft-feedback.md`, 2026-08-07): reject
a non-coordinate key field at declaration, the same way the range is now rejected. The reproducer is
`tools/loft_repro/spatial_text_key.loft` — self-contained, and it runs the `sorted` control beside the
broken kind.

### 2b. `sorted<T[text]>` is the primitive the index needs, and it works today

The control, same file, same run:

```
#S order: kerf kerklaan kerkstraat kerkweg lonneker    ← byte order ✅
#S range[kerk..kerl]: 3 -> kerklaan kerkstraat kerkweg ← exactly the kerk-prefixed words ✅
```

**A prefix is a contiguous key-range**, which is the whole trick: the index does not need a tree of its
own, because sorted order already puts every answer to `kerk*` next to every other one.

---

## 3. The index

### 3a. Shape

Three files' worth of structure, all of it derived from the store and none of it authoritative:

1. **A sorted, front-coded word list** — every distinct word of every folded name, once.
2. **A per-word offset table** into the postings.
3. **Postings** — for each word, the records whose fold contains it, delta-coded, each carrying the
   **cell, rank and kind** so that *ranking happens entirely in the index*. Only the top-8 `name`
   strings are then read from the store itself.

That last point is what makes it a two-stage read rather than a filter: `do_find` orders by score, then
`rank`, then squared distance, so it needs a position for every candidate before it can pick 8. Putting
the `NAME_CELL` (~5.5 km, and the store already keeps only one representative point per cell) in the
posting means a query never touches the store to *rank*, only to *display*.

### 3b. Sizing

⚠ **The vocabulary is now DERIVED FROM THE STORE, not recovered with `strings`** — §7's open question 1,
answered by `tools/trie_vocab.loft` walking all 518 804 records by index:

```
loaded 518804 records in 227 ms
scanned 518804 folds -> 220032 distinct words in 2239 ms
```

**220 032, not 211 748.** The `strings` recovery was **3.8% LOW**, and in the direction that flatters
the design — so every byte figure below derived from it is slightly under, not over.

| | from `strings` (±2% claimed) | **measured from the store** |
|---|---|---|
| records | 518 804 | 518 804 ✅ |
| distinct words | 211 748 | **220 032** (+3.9%) |
| postings | 817 321 | (not re-derived — see below) |
| front-coded word list | 1.39 MB | ~1.44 MB |
| postings (varint Δid + 3 B cell + 1 B rank/kind) | 4.99 MB | — |
| word → postings offsets | 0.85 MB | ~0.88 MB |
| **index total** | **7.2 MB** | **~7.3 MB** |

The total barely moves, so the design's conclusion survives its own bad input — but the *provenance*
was the defect, not the magnitude, and it is now fixed. **Re-derive the postings the same way before
building**; only the word list has been measured directly.

**The resident part is 13 kB.** Every 256th word as a sparse sample is 828 entries; one binary search
lands in a 256-word block, and the block plus its postings is one range read. If the memory is
affordable, holding the whole front-coded list resident (1.39 MB raw, ~0.6 MB gzipped, fetched once)
makes word→range resolution cost **zero** round trips and leaves only the postings on the wire.

### 3c. What a query fetches

⚠ **Re-measured on binary C against a real `trie` over the real vocabulary** — the earlier row was the
`strings` estimate, and it was low on the two large cases:

| typed | words (est.) | **words (real)** | postings (est.) | **postings (real)** | fetched |
|---|---|---|---|---|---|
| `lonn` | 15 | **15** ✅ | 22 | **22** ✅ | 0.1 kB |
| `amster` | 20 | **20** ✅ | 93 | **93** ✅ | 0.5 kB |
| `stra` | 240 | **247** | 1 406 | **1 462** | 7.2 kB |
| `kerk` | 455 | **459** | 3 301 | **3 330** | 16.3 kB |
| `a` | 7 547 | **7 955** | 31 483 | **36 991** | 181 kB |

The two short prefixes were exact and the two broad ones were under by 4–17%. A single typed letter is
the worst realistic case at **181 kB** (was estimated at 154 kB), against **21.4 MB today** — so the
conclusion holds by two orders of magnitude and the estimate was never load-bearing.

Query time on the real trie is not the constraint: **14 µs** for `amster`, **145 µs** for `kerk`,
**2.1 ms** for `a` — the worst case being 7 955 words walked in key order.

### 3d. `trie<T[k]>` is the right kind for the WORD LIST — and it does not remove the download

**This section has been written three times in one day, once per binary, and each version was correct
when written.** The history is kept because it is the finding: A said "a sorted array until `radix`
lands"; B refuted that from loft's own taxonomy (`radix` is Morton-order, so a text prefix is never
contiguous in it) and concluded `sorted` was the right kind; **C shipped `trie<T[k]>`, which is a
better answer than either.** Every one of those was a defensible read of the evidence available.

**What `trie` gives, measured on both backends (§2c):** exact lookup, byte-order iteration, a prefix
slice `t["kerk"..]` that needs **no successor string**, and a capped `t["kerk"..:8]` — which is
precisely what a search box issues. The `sorted` design required the caller to construct `"kerl"`, and
**getting that construction wrong is a silently wrong answer, not an error.** That alone justifies the
swap: it deletes a class of bug rather than a line of code.

⚠ **But a trie CANNOT PAGE, and that is the load-bearing negative result.** The whole reason §3a
hand-rolls a sparse sample is so a query reads a *range* instead of a file. A store-backed trie looked
like it would make that unnecessary. It does not — measured, not read:

```
store_bind_lazy   -> true                     <- reports success
  lookup kerkstraat -> NULL after 1 ms
  resident len      -> 0                      <- nothing paged in
  ["kerk"..] over a lazily-bound trie -> 0 words
store loader: refusing … — its bound store roots `trie<Word[w]>`, not a hash
store_load(local) -> true, 220032 words in 24 ms      <- whole image is fine
store_load_url    -> true, 220032 words in 28 ms
```

`store_load_key` wants an integer-keyed hash, `store_bind_lazy` wants a hash, `store_lazy_range` wants
`sorted`/`index`. **A trie is a whole-image structure.** So:

| | bytes on the wire | per query |
|---|---|---|
| today | 21.4 MB gzipped, whole | 0 (resident after the first) |
| **trie over the vocabulary** | **5.9 MB gzipped, whole** | 14 µs – 2.1 ms, no fetch |
| §3a hand-rolled + range reads | ~0 resident (13 kB sample) | **0.1 – 181 kB** |

**The trie is a 3.6× cut for almost no work; it is not the two-orders-of-magnitude cut.** These are
different points on the curve, not competing versions of one design — and the honest reading is that
the trie is the *cheap* win to take now, while §3a remains the thing that actually removes the
download. Take the trie for the word list, keep the range-read postings, and the two compose: the
vocabulary is small enough to ship whole, the postings are not.

---

## 4. The tier question, and why this is not a trade-off

`name_score` (`lib/map_kernel/src/map_kernel.loft`) has four tiers: **3** the query IS the name, **2**
the name starts with it, **1** a WORD in the name starts with it, **0** it merely appears somewhere. A
word index answers **3/2/1 exactly and completely**; only tier 0 — an interior-of-a-word substring — is
outside it.

The code's own comment says an ordered index cannot help "because the query people actually type is a
SUBSTRING (`kerk` for Kerkstraat, `lonn` for Lonneker)". That is *nearly* right and it overstates the
case: **both of its examples are prefixes.** `kerk` against folded `kerkstraat` scores tier 2.

Measured — 400 realistic typed prefixes (3–8 chars, sampled from the real vocabulary) against all
270 571 distinct folds:

| | |
|---|---|
| top-8 byte-identical to the full scan | **91.5%** |
| top-8 contains an interior-only hit | 8.5% |
| index returns a **wrong** result | **0%** |

In the 8.5% there are fewer than 8 tier≥1 matches, so the index returns a **shorter** list. That makes
the fallback trivial and lossless: **show the index results immediately, and only when fewer than
`limit` came back, fall back to today's whole-store scan.** The current answer is preserved exactly, and
the 21.4 MB download happens for 8.5% of searches instead of 100%.

⚠ **At Western Europe that 8.5% is a ~169 MB download**, so C4 needs a real tier-0 answer — a trigram
index over the residue is the obvious candidate (14 894 distinct trigrams over this corpus, so it is
small). Not costed here; it is a C4 question, not a C3 one.

---

## 5. Rejected: the suffix index

The variant that would close the gap outright — index every word-**suffix**, so any interior substring
becomes a prefix again — was sized rather than argued about:

| | word index | suffix index |
|---|---|---|
| distinct keys | 211 748 | 718 286 |
| postings | 817 321 | 6 182 029 (11.68/record) |
| front-coded list | 1.39 MB | 4.46 MB |
| postings | 4.99 MB | 35.19 MB |
| **total** | **7.2 MB** | **42.5 MB** |

**42.5 MB is twice the gzipped store.** Full substring coverage costs more than shipping the whole thing
and scanning it, so it is not a smaller index — it is a bigger one that also needs a reader. Rejected by
measurement.

---

## 6. The instrument

`browser/cdp_names_cost.mjs` reported a harness property as the product's ceiling for the reason in
§1a, and nothing in its output said so. It now reads `Network.responseReceived` /
`Network.loadingFinished` and prints **wire bytes against decoded bytes with the `content-encoding`
that produced them, per request** — and when a run is throttled against a host that does not compress,
it says in one line that the number describes the harness and not the live site. Verified both ways:

```
live   : request coverage.names.store 200 gzip     — 21.41 MB on the wire → 63.47 MB (3.0x)
harness: request coverage.names.store 200 identity — 63.47 MB on the wire → 63.47 MB (1.0x) + the ⚠
```

Three things it now gets right that each looked fine while being wrong:

* **CDP events, not Resource Timing.** `encodedBodySize` is zeroed for a cross-origin resource without
  `Timing-Allow-Origin` — exactly the localhost-app / Pages-data case.
* ⚠ **Key by `requestId`.** Neither `loadingFinished` nor `dataReceived` carries a url, so a url filter
  drops precisely the events that hold the byte counts. A debug script written to diagnose this bug had
  the bug itself, and reported that `loadingFinished` never fires.
* ⚠ **Wait for `loadingFinished`; never sum `dataReceived`.** The first `find` can return before the
  body is fully accounted, and reading the counters there printed `0.00 MB … (264450.5x)`. Summing
  `dataReceived.encodedDataLength` is the obvious repair and is worse: Chrome charges the first ~20
  chunks and then reports **`encodedDataLength: 0`** while `dataLength` keeps climbing in 2 MB steps,
  under-counting 21.4 MB by ~10×. An unfinished request now **fails loudly** rather than summing to zero.

It stays a **probe, not a gate** (`HANDOFF` §3) — it answers a question rather than defending an
invariant — so the fix is to make its output impossible to misread, not to make it exit non-zero.

---

## 7. Open before building

1. ~~**Re-derive §3b from the store directly**, not from a `strings` recovery.~~ **ANSWERED
   2026-08-07** — `tools/trie_vocab.loft`: **220 032** distinct words, not 211 748. The recovery was
   3.8% low. §3b and §3c carry the measured numbers; **the postings are still estimated** and want the
   same treatment before the format is fixed.
2. ~~**Does a key-range scan page under `store_load_keys`?**~~ **ANSWERED — NO, and it is not close**
   (`tools/trie_paging.loft`, §3d). `store_load_key` requires an integer-keyed hash, `store_bind_lazy`
   a hash, `store_lazy_range` a `sorted`/`index`. A `trie` is a **whole-image** structure. So the
   fallback this question named is now the plan of record: **the index is a flat file the app reads by
   range itself**, which is exactly what `coverage.pagesx` already is — known, cheap, and already
   proven in this app.
3. **Where does the index live** — beside the store, or inside it as a second collection? A second
   collection shares the store's schema hash, which loft#705 gates `store_load` on, so regenerating one
   means regenerating both. ⚠ **Sharpened by C**: the `.dschema` now records the collection *kind*
   (`trie<Word[w]> size=4 trie<Word[0]>`), so adding a trie beside the names hash changes the schema
   hash and forces a regeneration of every published block.
4. **One store or a covering set.** The index does not remove the reason the names store is one file
   (`NAMES` resolved once at boot, `store_load_url_trusted` ADOPTS, every store numbers records from 0
   — `gen-names.loft`). It makes that far cheaper to live with, which may be enough.
5. ⚠ **NEW — a refused lazy binding is invisible to the program.** `store_bind_lazy` answered `true`
   for a trie it can never serve; the refusal went to **stderr**, `store_lazy_error` returned `""` (its
   documented meaning: *reachable, genuinely no such key*) and `store_lazy_faults` stayed **0**. A
   caller therefore cannot tell "no such word" from "this source was never readable" — which is the one
   distinction that API exists to make — proven against a **hash + unreachable URL control in the same
   run**, which reports the connection error and a fault count of 1. Filed as
   [loft#802](https://github.com/loft-lang/loft/issues/802); repro `tools/trie_paging.loft`. It costs
   us nothing today (we load whole images) but it would silently empty a search box the day we do not.
