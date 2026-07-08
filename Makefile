# Makefile — build + install a fully optimized, stable local copy of the routing app,
# and run every offline test gate.
#
# WHY A PREBUILT BINARY IS "STABLE":
#   `loft --native-release` compiles server/server.loft (plus the vendored loft
#   libraries under lib/) through rustc into ONE optimized native executable.
#   Once built, that binary runs machine code directly — it does NOT invoke rustc
#   and does NOT re-resolve any loft library at runtime. So a future rustc release
#   or upstream loft/library churn cannot break an already-installed copy; they can
#   only ever affect the next `make build`. That is exactly the insulation we want.
#
# LAYOUT (self-contained, because the server reads its client + writes its route/
# tile state relative to the launch dir):
#   $(APPDIR)/routing-server-bin   the optimized native server
#   $(APPDIR)/*.{html,css,js}, vendor/   the static client
#   $(APPDIR)/routes, scratch/tiles      writable state (survive uninstall)
#   $(BINDIR)/routing        start-if-needed + open primary browser
#   $(BINDIR)/routing-stop   stop the server
#
# COMMON USE:
#   make install     build optimized + install to ~/.local (no sudo)
#   routing          start (if needed) and open the browser
#   routing-stop     stop the server
#   make run / make stop   same, but straight from this repo (dev, no install)
#
# TEST GATES:
#   make test         everything OFFLINE: interpreter kernel suites + server harnesses
#   make test-native  the kernel suites again on the --native backend (slow, thorough)
#   make test-wasm    kernel geodesic parity on wasip2 via wasmtime
#   make test-client  the headless-Chromium harnesses (routes / elevation / two-tab sync)
#
# Defaults to the installed loft on PATH — it carries a stable, self-contained
# native runtime (/usr/local/share/loft/deps), so --native builds don't depend on
# the ../loft dev tree's in-progress target/deps. Override with LOFT_BIN=... to test
# an unreleased build, e.g. LOFT_BIN=$(CURDIR)/../loft/target/release/loft.

LOFT   ?= $(or $(LOFT_BIN),$(shell command -v loft))
PORT   ?= 18080
PREFIX ?= $(HOME)/.local
APPDIR := $(PREFIX)/lib/routing
BINDIR := $(PREFIX)/bin
URL    := http://127.0.0.1:$(PORT)/

KERNEL_TESTS = geodesic corridor gpx import loop matcher profiles roundtrip elevation

.PHONY: help build check check-rustc install uninstall run stop clean \
        test test-native test-wasm test-client

help:
	@echo "routing — targets:"
	@echo "  make check-rustc verify your rustc corresponds to loft (else hint to refresh loft)"
	@echo "  make build      compile the optimized native server -> dist/routing-server-bin"
	@echo "  make install    build + install a stable copy to $(PREFIX) (no sudo)"
	@echo "  make uninstall  remove the installed copy (keeps saved routes)"
	@echo "  make run        build + start from this repo and open the browser (dev)"
	@echo "  make stop       stop a repo-local server"
	@echo "  make clean      remove dist/ and the native build cache"
	@echo ""
	@echo "test gates:"
	@echo "  make test        offline: interpreter kernel suites + server harnesses"
	@echo "  make test-native the kernel suites on the --native backend (slow, thorough)"
	@echo "  make test-wasm   wasip2 parity via wasmtime: kernel geodesic + full matcher (app_kernel)"
	@echo "  make test-client headless-Chromium harnesses (routes / elevation / sync)"
	@echo ""
	@echo "after 'make install' (ensure $(BINDIR) is on PATH):"
	@echo "  routing         start (if not already up) + open primary browser"
	@echo "  routing-stop    stop the server"
	@echo ""
	@echo "vars: LOFT=$(LOFT)  PORT=$(PORT)  PREFIX=$(PREFIX)"

# --- rustc <-> loft correspondence check ----------------------------------------
# We deliberately DON'T pin rustc: loft floats to latest stable (see ../loft's
# rust-toolchain.toml). But loft compiles the generated Rust with the AMBIENT
# rustc and links it against loft's prebuilt rlibs, whose metadata is locked to
# the rustc that built loft. If the two drift apart (e.g. `rustup update` moved
# rustc past the loft build), native compilation fails. This probe catches that
# up front and points at the real fix — rebuild/redownload loft, NOT downgrade
# rustc. A trivial native compile is the authoritative test (it links the rlibs).
check-rustc:
	@[ -x "$(LOFT)" ] || { echo "ERROR: loft not found at $(LOFT) (set LOFT=/path/to/loft)"; exit 1; }
	@probe="$$(mktemp -d)"; printf 'fn main() { println("ok") }\n' > "$$probe/p.loft"; \
	 if $(LOFT) --native --check "$$probe/p.loft" >"$$probe/log" 2>&1; then \
	   rm -rf "$$probe"; \
	 else \
	   have="$$(rustc --version 2>/dev/null)"; \
	   want="$$(strings -a "$(LOFT)" 2>/dev/null | grep -oE 'rustc 1\.[0-9]+\.[0-9]+ \([0-9a-f]+ [0-9-]+\)' | sort -u | head -1)"; \
	   echo "ERROR: loft ($(LOFT)) cannot build native code with your rustc."; \
	   echo "  your rustc : $${have:-unknown}"; \
	   [ -n "$$want" ] && echo "  loft built : $$want"; \
	   echo ""; \
	   echo "  loft links generated code against rlibs built by its own rustc, so the two"; \
	   echo "  must match. rustc floats to latest stable; the fix is to refresh loft, not"; \
	   echo "  to change rustc:"; \
	   echo "    rebuild : (cd $(CURDIR)/../loft && SDKROOT=\$$(xcrun --show-sdk-path) make install)"; \
	   echo "    or fetch a loft prebuilt matching $${have:-your rustc}"; \
	   echo ""; \
	   echo "  --- native probe output ---"; sed 's/^/  /' "$$probe/log"; \
	   rm -rf "$$probe"; exit 1; \
	 fi

# Lightweight presence check for the test gates that don't need the native probe.
check:
	@[ -x "$(LOFT)" ] || { echo "ERROR: loft not found at $(LOFT) (set LOFT=/path/to/loft or LOFT_BIN=...)"; exit 1; }
	@command -v rustc >/dev/null 2>&1 || { echo "ERROR: rustc not found — install via https://rustup.rs"; exit 1; }

# --- build the optimized binary -------------------------------------------------
# `--native-release --check` compiles (optimized) and exits WITHOUT running the
# server, so nothing binds the port. loft content-addresses the artifact in
# server/.loft/cache/; we lift the freshest one out into dist/.
build: check-rustc
	@mkdir -p dist
	@echo "==> compiling optimized native server (loft --native-release)…"
	@$(LOFT) --native-release --check server/server.loft --lib lib
	@bin="$$(ls -t server/.loft/cache/server-* 2>/dev/null | head -1)"; \
	 [ -x "$$bin" ] || { echo "ERROR: no compiled binary in server/.loft/cache"; exit 1; }; \
	 install -m 755 "$$bin" dist/routing-server-bin; \
	 { echo "built  : $$(date '+%Y-%m-%d %H:%M:%S')"; \
	   echo "loft   : $$($(LOFT) --version)"; \
	   echo "rustc  : $$(rustc --version)"; } > dist/VERSION
	@echo "==> dist/routing-server-bin ready"; sed 's/^/    /' dist/VERSION

# --- install a stable local copy ------------------------------------------------
install: build
	@echo "==> installing to $(APPDIR)"
	@mkdir -p "$(APPDIR)/vendor" "$(APPDIR)/routes" "$(APPDIR)/scratch/tiles" "$(BINDIR)"
	@install -m 755 dist/routing-server-bin "$(APPDIR)/routing-server-bin"
	@install -m 644 dist/VERSION "$(APPDIR)/VERSION"
	@install -m 644 index.html styles.css *.js "$(APPDIR)/"
	@cp -R vendor/. "$(APPDIR)/vendor/"
	@sed -e 's#@APPDIR@#$(APPDIR)#g' -e 's#@PORT@#$(PORT)#g' tools/routing.in      > "$(BINDIR)/routing"
	@sed -e 's#@APPDIR@#$(APPDIR)#g' -e 's#@PORT@#$(PORT)#g' tools/routing-stop.in > "$(BINDIR)/routing-stop"
	@chmod 755 "$(BINDIR)/routing" "$(BINDIR)/routing-stop"
	@echo "==> smoke test (installed binary serves installed client)…"
	@pids="$$(lsof -ti tcp:$(PORT) -sTCP:LISTEN 2>/dev/null)"; [ -n "$$pids" ] && kill $$pids 2>/dev/null || true; \
	 cd "$(APPDIR)" && ( nohup ./routing-server-bin >routing.log 2>&1 & echo $$! >routing.pid ); \
	 ok=0; for _ in $$(seq 1 40); do \
	   curl -fsS -m3 "$(URL)" 2>/dev/null | grep -q "<!DOCTYPE html>" && { ok=1; break; }; sleep 0.5; done; \
	 pid="$$(cat "$(APPDIR)/routing.pid" 2>/dev/null)"; [ -n "$$pid" ] && kill "$$pid" 2>/dev/null || true; \
	 rm -f "$(APPDIR)/routing.pid"; \
	 [ "$$ok" = 1 ] || { echo "   SMOKE FAILED — see $(APPDIR)/routing.log"; exit 1; }
	@echo "   smoke OK"
	@echo ""
	@echo "installed. ensure $(BINDIR) is on your PATH, then:"
	@echo "  routing        start + open browser"
	@echo "  routing-stop   stop"

uninstall:
	@"$(BINDIR)/routing-stop" 2>/dev/null || true
	@rm -f "$(BINDIR)/routing" "$(BINDIR)/routing-stop"
	@rm -f "$(APPDIR)"/*.html "$(APPDIR)"/*.css "$(APPDIR)"/*.js \
	       "$(APPDIR)/routing-server-bin" "$(APPDIR)/VERSION" "$(APPDIR)/routing.log"
	@rm -rf "$(APPDIR)/vendor" "$(APPDIR)/scratch"
	@echo "note: saved routes kept at $(APPDIR)/routes"
	@rmdir "$(APPDIR)" 2>/dev/null || true
	@echo "uninstalled from $(PREFIX)"

# --- repo-local start/stop (dev; no install) ------------------------------------
run: build
	@if curl -fsS -o /dev/null -m1 "$(URL)" 2>/dev/null; then \
	   echo "routing: already running at $(URL)"; \
	 else \
	   echo "routing: starting from repo…"; mkdir -p scratch; \
	   ( nohup dist/routing-server-bin >scratch/routing.log 2>&1 & echo $$! >scratch/routing.pid ); \
	   for _ in $$(seq 1 60); do curl -fsS -o /dev/null -m1 "$(URL)" 2>/dev/null && break; sleep 0.5; done; \
	   curl -fsS -o /dev/null -m1 "$(URL)" 2>/dev/null || { echo "failed; see scratch/routing.log"; tail -20 scratch/routing.log; exit 1; }; \
	   echo "routing: up at $(URL)"; \
	 fi; \
	 open "$(URL)" 2>/dev/null || xdg-open "$(URL)" >/dev/null 2>&1 || echo "open $(URL)"

stop:
	@pid="$$(cat scratch/routing.pid 2>/dev/null || true)"; \
	 if [ -n "$$pid" ] && kill "$$pid" 2>/dev/null; then echo "routing: stopped (pid $$pid)"; fi; \
	 rm -f scratch/routing.pid; \
	 pids="$$(lsof -ti tcp:$(PORT) -sTCP:LISTEN 2>/dev/null)"; \
	 if [ -n "$$pids" ] && kill $$pids 2>/dev/null; then echo "routing: freed port $(PORT)"; fi; \
	 true

clean:
	@rm -rf dist server/.loft/cache
	@echo "cleaned dist/ and native build cache"

# --- test gates -----------------------------------------------------------------
# The shell harnesses honor LOFT_BIN; pass ours through so an overridden LOFT wins.
test: check
	@mkdir -p scratch scratch/tiles
	@for t in $(KERNEL_TESTS); do \
	    "$(LOFT)" --tests lib/routing_kernel/tests/$$t.loft --lib lib || exit 1; \
	done
	@LOFT_BIN="$(LOFT)" ./tools/server_test.sh
	@LOFT_BIN="$(LOFT)" ./tools/elevation_test.sh
	@LOFT_BIN="$(LOFT)" ./tools/routes_test.sh
	@LOFT_BIN="$(LOFT)" ./tools/sync_test.sh
	@echo "  ALL OFFLINE GATES PASS"

test-native: check-rustc
	@for t in $(KERNEL_TESTS); do \
	    "$(LOFT)" --tests lib/routing_kernel/tests/$$t.loft --lib lib --native || exit 1; \
	done
	@echo "  NATIVE KERNEL SUITE PASSES"

test-wasm: check
	@LOFT_BIN="$(LOFT)" ./tools/kernel_headless_test.sh
	@LOFT_BIN="$(LOFT)" ./tools/app_headless_test.sh

test-client: check
	@LOFT_BIN="$(LOFT)" ./tools/client_routes_test.sh
	@LOFT_BIN="$(LOFT)" ./tools/client_elev_test.sh
	@LOFT_BIN="$(LOFT)" ./tools/client_sync_test.sh
	@echo "  ALL CLIENT (CHROMIUM) GATES PASS"
