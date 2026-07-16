# CLAUDE.md — working notes for agents on this repo

`routing` is a bicycle/pedestrian route-matcher written in **loft** (a bespoke Rust-like language).
It doubles as the **consumer test-bed** for loft, which is being given a formal language definition.
Start with **`HANDOFF.md`** (resume state) and the **`PLAN-*.md`** / `DESIGN.md` docs (plan of record).

These notes carry context that isn't obvious from the code, so it survives across machines. (They
mirror the maintainer's agent memory — keep both in sync when one changes.)

## Working agreements

- **Always push committed work to its branch; only open PRs when explicitly asked.** Pushing is a safety
  net (work isn't lost) and lets the maintainer switch machines/environments and pick the work up
  elsewhere — so push promptly after committing. But do **not** open a PR or run a
  verify-CI-till-green-then-merge loop for everything: only when told in those words, or for genuinely
  PR-worthy work.
- **`main` is protected — never push to it directly.** The repo is public and `main` requires a PR whose
  `build-test` CI check passes (enforced for admins too); direct pushes/merges are rejected. Do work on a
  branch, push the branch, and land it via PR when the maintainer says it's ready.
- End loft commit messages and PR bodies per the repo/CLI conventions already in use.

## The loft toolchain

- Build/test/run routing with the **installed `loft` on `PATH`** (`/usr/local/bin/loft`). It ships a
  stable, self-contained native runtime at `/usr/local/share/loft/deps`, so `--native` builds are
  reproducible. The `Makefile` defaults to `$(shell command -v loft)`; override with `LOFT_BIN=...`.
- Reach for the **sibling checkout's binary** (`../loft/target/release/loft`, via `LOFT_BIN=...`) **only
  when that dev build is ahead on a fix you specifically need.** Its `target/release/deps` is the other
  agent's *live, mid-build* tree — the binary can be byte-identical to the installed one yet the runtime
  is inconsistent. (2026-07-08: it held two `loft_ffi` rlibs and every routing `--native`/server build
  failed with rustc `found crates (loft_ffi and loft_ffi) with colliding StableCrateId`, exposed by loft
  #498's FFI-crate split; the installed loft built the same sources fine.)
- **`../loft` AND `../loft2` are other agents' workspaces** — each has its own agent, and both rebuild
  `target/release/loft` frequently. Treat both as **read-only**: never build, edit, `cargo build`, delete
  from their `target/`, or reinstall from them. Reading their git log / plan docs is fine and often the
  fastest way to learn what landed and how a routing finding was triaged.
- The loft binary is a **moving target — including mid-session.** When *every* loft run fails oddly (even
  hello-world), probe a trivial program first — and outside the Claude Code command sandbox — before
  believing any specific failure. (Past example: a build panicked at startup only inside the sandbox.)
  It is not just the sibling trees that move: **`/usr/local/bin/loft` gets reinstalled under you.**
  (2026-07-16: three distinct binaries existed within one session — `loft2` 16:50, installed 16:58,
  `loft` 17:47 — and both the installed binary and `../loft`'s dev build changed *while work was in
  flight*; a matrix probed at 16:00 described a binary that no longer existed by 17:00.) So: **anchor a
  finding to the binary you will report it against** — probe with `--version` + `ls -la` on the binary,
  and if it matters, re-run the probe on the *installed* loft before writing it down. A conclusion drawn
  from `../loft/target/release/loft` can be stale within the hour.

## loft's formal-definition goal

- The maintainer is driving a **formal language definition of loft**; routing is the dogfooding
  consumer that validates each formalized rule (nullable `v[i]`, fallible `as`-parse, the @PLN25/DN1
  non-null-by-default model) is ergonomically bearable.
- **So:** read loft-HEAD breakage here as a *data point against the formal model* (which rule landed,
  what the discharge idiom costs), not just a bug. Definition-relevant findings go in
  `docs/loft-feedback.md`. loft store/engine feature requests are filed as issues on **`loft-lang/loft`**
  (this repo's own remote is `jjstwerff/routing`).

## Accepted design decisions

- **Chord corridor** (`server/server.loft`, `match_for`): for a round-trip sketch, the Overpass
  corridor is queried around `sketch + finish→start chord` so the closing leg's region is downloaded.
  It was reverted once (2026-07-03) and then **explicitly re-requested** by the maintainer the same day
  — treat it as accepted design, not contested. Details in `PLAN.md` under "Bounded deviation-free
  closure".

## Environment / Claude Code notes

- **`gh` must run outside the command sandbox** (network to github.com is blocked inside it). Inside the
  sandbox, `gh auth status` falsely reports an invalid token — that's the sandbox network block, not a
  real auth failure; the token is fine. Run `gh` with the sandbox disabled.
- The browser shell (`browser/`) is **loft-native**: the wasm comes from `loft --html` and talks to JS
  over loft's own `host_input()`/`println` byte channel (no jco, no WASI, no npm deps). It needs `node`
  + a browser (headless Chromium for the gate). loft#521 (the wasm-runtime boot abort) is fixed.
