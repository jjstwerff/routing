<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Hosting the blocks — what it costs, and what the bill is actually made of

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-04 · **Owns:** what each hosting option costs — read before any hosting decision

**Answers `PLAN-SCALE` §9 item 6 (*R2 vs B2: Range + CORS behaviour and egress cost*) and prices §6h
breakage 2 (*one Pages repo per region does not scale to ~58 repos*).** Prices checked 2026-08-04
against the vendors' own pages; re-check before committing money, because this is the one input here
that is not ours to control.

---

## 0. The finding, in one line

**GitHub Pages caps us at roughly a thousand sessions a month, and no amount of splitting repositories
changes that** — the limit is bandwidth, which scales with *users*, not with data. Everything else in
this document is about which paid host to move to and what its bill is made of.

⚠ **The bill is NOT made of bytes.** R2 charges per *request*, and this app is unusually
request-heavy because paging is its whole design. That inverts the optimisation we have been tuning
for (§4).

---

## 1. The measured inputs — ours, not projections

Every number below comes from a gate in this repo, not from a model.

| | measured | source |
|---|---|---|
| a realistic paged session | **1 772 range requests, 105.19 MB across 13 viewports** | `base_paged_gate` phase 1 |
| ⇒ per viewport | **136 requests, 8.1 MB** | ⌃ derived |
| a route match on a country block | **271 range reads, 17.7 MB of a 222.4 MB block** | `nl_live_gate` |
| worst case: 6 viewports hundreds of km apart | 13 159 requests, 821.3 MB | `base_paged_gate` phase 2 — *deliberately* worst case; every prefetched cell is thrown away |
| a dense metro viewport | Amsterdam z14 = **21.8 MB** geometry, 68.4 MB one zoom out | `PLAN-SCALE` §6f |

⚠ **`PLAN-SCALE` §9 row 2 still says a viewport is "75–190 kB, independent of the store's total
size". That was retracted by §6f** — *"A viewport is not 75–190 kB. It is 10 MB, and at one zoom out,
68 MB"* — because the old figure multiplied a store-wide average tile by an unpadded cell count. The
retraction is 400 lines further down the same file than the claim. **Use the numbers above.**

**The session model used throughout:** ten viewports plus one match ⇒ **~1 600 requests, ~100 MB**.
That is a user who opens the app, pans a bit, and asks for one route.

---

## 2. Why Pages stops working, and it is not the repo count

| GitHub Pages limit | value | what it means here |
|---|---|---|
| published site size | **1 GB** | why `be-mid` moved out, and why Belgium's 1202.5 MB base map must be *cut in two* for hosting reasons alone |
| **monthly bandwidth** | **100 GB, soft** | **~1 000 sessions/month** at 100 MB each |
| builds/hour | 10, soft | not binding — a custom Actions workflow is exempt |

**~1 000 sessions a month is the real ceiling, and it binds at Benelux, not at Western Europe.** It is
a *soft* limit — GitHub emails rather than cutting you off — but it is the number that decides whether
the app can be used, and it cannot be engineered around by adding repositories.

Two further points, both from GitHub's own documentation:

* Pages is **"not intended for or allowed to be used as a free web-hosting service to run your online
  business"**, and GitHub's stated remedy for a site straining their resources is *to put a CDN in
  front of it*. Six repositories that exist only to serve binary blobs — heading for ~58 — is not a
  rule we are breaking so much as a tool we have outgrown.
* Paid GitHub plans **do not raise these limits**. Pages is free for public repos on the Free plan, so
  an existing GitHub subscription buys this project nothing and does not offset a storage bill.

---

## 3. The two candidates, priced against our own numbers

Dataset at WE scale: ~30.0 GB base (40.5 GB with the 0.10° margin) + 3.5 GB roads + 0.5 GB names ⇒
**~44.5 GB**, of which the first 10 GB is free on both.

### Cloudflare R2 — pays for storage and REQUESTS, egress is free

`$0.015/GB-month` · Class A (writes) `$4.50/M` · Class B (reads, incl. `GetObject`) `$0.36/M` ·
**egress `$0`** · free tier `10 GB` + `1M` Class A + `10M` Class B per month.

### Backblaze B2 — pays for storage and BYTES, API calls are free

`$6.95/TB-month` (= `$0.00695/GB`) · Class A/B/C API calls **free** · **free egress up to 3× monthly
storage**, then `$0.01/GB` · first 10 GB storage free.

### The bill, at our measured 1 600 requests / 100 MB per session

| sessions/month | egress | R2 | B2 |
|---|---|---|---|
| 1 000 *(Pages' ceiling)* | 100 GB | **$0.52** (ops inside free tier) | **$0.24** (egress inside free tier) |
| 10 000 | 1 TB | **$2.68** | $8.91 |
| 100 000 | 10 TB | **$54.52** | $98.91 |
| 1 000 000 | 100 TB | **$573** | $998 |

**R2 wins from roughly ten thousand sessions a month upward**, and by ~2× at a hundred thousand.
Below that both are rounding errors and the choice does not matter financially.

**The shape of the two bills is opposite**, and that is the part worth remembering: B2's grows with
*bytes*, R2's with *requests*. We are a byte-light, request-heavy workload — 8.1 MB in 136 requests
per viewport — which is why R2 wins despite B2's cheaper storage.

---

## 4. ⚠ The design consequence: our optimisation inverts

Everything in `PLAN-SCALE` that makes paging cheap — the tier floor, the exact viewport filter, the
0.10° margin debate — minimises **bytes fetched**. That is the correct target on GitHub Pages, where
bandwidth is the limit, and on B2, where egress is the bill.

**On R2 it is the wrong target.** Bytes are free; requests are the bill. The cheaper design there is
**fewer, larger reads** — a bigger page granularity, coarser cell keys, more prefetch per request —
which is close to the opposite of what step 7g and the tier floor were tuned to do.

This is not an argument against R2. It is a note that **choosing the host chooses the optimisation**,
and phase E should decide both together rather than discover the second one later. The lever is real:
halving the request count halves the bill at every row of the table above, and our worst-case corpus
already shows a 16× spread in requests-per-viewport between a pan and a teleport.

---

## 5. ⚠ Unresolved, and it swings the answer by up to 10×

**Does a Cloudflare cache hit avoid the R2 Class B charge?**

A map has enormous locality — Amsterdam's cells are requested by every visitor — so if cache hits do
not bill, §3's R2 column collapses towards the storage line. If they do bill, §3 stands as written.

What the sources actually say:

* Cloudflare's docs confirm a custom domain **enables caching** ("allows you to use Cloudflare Cache
  to accelerate access to your R2 bucket"), that only certain file types cache by default so a *cache
  everything* rule is needed, and they recommend Smart Tiered Cache. **They do not say whether a hit
  is billed.**
* **Multiple community reports say Class B operations are still counted on requests returning
  `cf-cache-status: HIT`** through an R2 custom domain, and that R2 public buckets on a zone do not
  use Cache Reserve.

⚠ **I told the maintainer the opposite in conversation on 2026-08-04 — that "caching collapses it".
That was unverified and the community evidence contradicts it.** Treat the pessimistic column in §3 as
the planning number until this is settled.

**A second, smaller unknown:** neither vendor documents whether a ranged `GetObject` returning `206`
bills as one Class B operation. Standard S3-compatible behaviour says one request is one operation
regardless of bytes returned, and §3 assumes that. If a range read ever bills per range *segment*, the
R2 column is wrong upward.

**Both are cheap to settle and neither needs a migration:** put ~1 GB in a bucket, drive
`cors_host_gate`'s corpus at it, and read the operations counter in the Cloudflare dashboard against
`kernelStats().rangeReads`. An afternoon answers both, and the answers are worth more than the rest of
this document.

---

## 6. Recommendation

**Move to R2, but measure first, and treat the move as a phase-E decision rather than a prerequisite.**

1. **Do not pay yet.** At current traffic both hosts cost under a dollar, and the free tiers cover
   ~6 000 sessions/month on R2 and ~1 300 on B2 — already above what Pages permits.
2. **Settle §5 before committing**, with the 1 GB experiment above. It is the only input that changes
   the recommendation, and it changes it by an order of magnitude.
3. **Then move for the reason that actually binds** — bandwidth and fitness-for-purpose, *not* repo
   tidiness. The ~58-repo problem is real but it is an annoyance; the 100 GB/month ceiling is a
   product limit.
4. **Re-tune paging for requests once hosted there** (§4), and re-run `base_paged_gate` — its
   request counter is already the instrument, and its phase-2 worst case is already the stress corpus.

**The code is done.** `tools/publish-bucket.sh` exists, `data/bucket-cors.json` is the policy, and
`cors_host_gate.sh` proves the browser reads paged blocks cross-origin. What is missing is an account
and the measurement in §5.

---

## Sources

* [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [R2 public buckets & caching](https://developers.cloudflare.com/r2/buckets/public-buckets/)
* [Backblaze B2 cloud storage pricing](https://www.backblaze.com/cloud-storage/pricing)
* [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
* Community reports on R2 cache hits billing Class B: [cache hits counted](https://community.cloudflare.com/t/hit-on-r2-class-b-with-caching/861466) · [Class B calculation](https://community.cloudflare.com/t/questions-about-the-calculation-of-b-class-requests-for-cloudflare-r2/609909)
