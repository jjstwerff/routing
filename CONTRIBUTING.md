# Contributing

Thanks for helping. This project is open in the same shape as [loft](https://github.com/loft-lang/loft):
LGPL-3.0 code, ODbL data, public issues, plan-docs as the plan of record.

## Licensing of contributions

- **Code** contributions are under **LGPL-3.0-or-later** (see [`LICENSE`](LICENSE)). New source files
  should carry the SPDX header:
  ```
  // Copyright (c) <year> <you>
  // SPDX-License-Identifier: LGPL-3.0-or-later
  ```
- **Data** (tile blocks) is **ODbL-1.0** (see [`LICENSE.data`](LICENSE.data)) — it derives from
  OpenStreetMap and cannot be relicensed.
- Sign off commits (**DCO**): `git commit -s` (certifies you may submit the change under the above).

## Build & test

Prerequisites: a sibling **[loft](https://github.com/loft-lang/loft)** checkout, built
(`../loft/target/release/loft`); Rust (for the native compile); macOS needs the SDK path exported.

```sh
export SDKROOT=$(xcrun --show-sdk-path)      # macOS only
make build      # compile the optimized native server
make test       # offline kernel suites + server harnesses
make run        # build + start locally, open the browser
```

Override the toolchain location with `LOFT=/path/to/loft` (or `LOFT_BIN=…`).

## Layout

- `lib/routing_kernel/` — pure-loft compute (matcher, tiles, GPX, elevation); the shared kernel.
- `server/server.loft` — the native server (HTTP + WebSocket).
- `client/`, `*.js`, `index.html` — the thin browser client.
- `lib/{web,server,imaging}/` — **vendored** loft-libs (LGPL); don't edit here, upstream is
  [loft-libs-net](https://github.com/loft-lang/loft-libs-net).
- `PLAN-*.md` — design + plan of record (`PLAN`, `PLAN-BROWSER`, `PLAN-TILES`, `PLAN-MATCH`,
  `PLAN-ROUTING`, `PLAN-APP`); `DESIGN.md` — the north-star design.

## Coding style

- Match the surrounding code: comment density, naming, and loft idioms already in the file.
- Kernel changes must keep the test suites green (`make test`) — and, since the kernel targets both
  native and wasm, avoid native-only assumptions in `lib/routing_kernel`.
- Keep the matcher deterministic (same input → same match) — see `DESIGN.md` §5 / `PLAN-MATCH`.

## Filing issues & proposing work

- Bugs / features / data-quality: open a GitHub issue (templates under `.github/ISSUE_TEMPLATE/`).
- Larger changes: sketch them against the relevant `PLAN-*.md` first, so the plan of record stays
  accurate. Toolchain/library gaps belong upstream (loft, loft-libs-net).
