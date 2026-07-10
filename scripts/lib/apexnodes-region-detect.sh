#!/usr/bin/env bash
# ============================================================================
# scripts/lib/apexnodes-region-detect.sh
# ----------------------------------------------------------------------------
# Sourceable ApexNodes overlay: COS-first artifact sourcing + CN mirror env.
#
# hc-474 (default-to-COS): the COS download helpers below are **region-
# independent** — every install with HERMES_RUNTIME_COS_BASE configured tries
# our public-read COS bucket FIRST and falls back to the official foreign
# source (github/astral) only when COS fails. Region detection no longer sits
# on any make-or-break install path; it only tunes which third-party package
# mirrors (pypi/npm/node/electron/playwright) get injected, where a wrong
# guess costs download speed, never install success. This removes the F2
# root-cause class: a misdetected/stale region can no longer strand a mainland
# machine on a blocked github clone.
#
# This file remains the SINGLE SOURCE OF TRUTH for the region decision and the
# mirror env values. It is an ApexNodes overlay seam (see apex_overlay/README.md):
# the file lives in OUR namespace under scripts/lib/, which upstream Hermes
# never creates, so it has a zero-conflict merge surface. The upstream installer
# (scripts/install.sh) stays byte-for-byte upstream apart from one self-locating
# `source` of this lib plus a handful of tiny call sites.
#
# Mirrors scripts/lib/apexnodes-region-detect.ps1 for Windows. Keep the two in
# step: the probe, precedence rules, env-var names, and COS layout are
# identical by design.
#
# Usage (from install.sh, which sources this only when the file is present):
#   source scripts/lib/apexnodes-region-detect.sh
#   apexnodes_resolve_region          # sets HERMES_CN_MIRRORS from region
#   apexnodes_apply_cn_mirror_env     # exports CN mirror env iff CN
# Then the COS download helpers (also defined here) are available:
#   apexnodes_install_uv_from_cos     # sets UV_CMD on success (COS-first)
#   apexnodes_download_runtime_tarball# populates INSTALL_DIR (COS-first)
#
# Upstream parity: with HERMES_RUNTIME_COS_BASE unset AND HERMES_CN_MIRRORS
# unset/0, every function here is a no-op and the installer behaves
# byte-for-byte like upstream (curl|bash, CI, etc). Only our own channels
# (desktop bundle, cloud image, ops) set the COS base.
#
# Inputs read from the environment (set before sourcing / before calling):
#   HERMES_CN_MIRRORS         authoritative override (rule 1): 1=on, 0=off
#   APEXNODES_REGION          explicit region knob (rule 2): cn|global
#   HERMES_RUNTIME_COS_BASE   public-read COS base for runtime tarball + uv;
#                             setting it turns on COS-first for every region
#   HERMES_HOME               install root (default $HOME/.hermes)
#   OS / INSTALL_COMMIT / BRANCH / INSTALL_DIR / UV_CMD / UV_VERSION
#                             provided by install.sh; the COS helpers read/write
#                             them so behavior matches the previous in-line code.
#
# The installer provides log_info / log_warn / log_success. When this lib is
# sourced standalone (e.g. a unit test) those may be absent, so we define
# no-op-safe fallbacks below — never let a missing logger break detection.
# ============================================================================

# Logger fallbacks: only define if the installer has not already provided them.
# `command -v` keeps these from clobbering install.sh's real loggers.
if ! command -v log_info >/dev/null 2>&1;    then log_info()    { echo "$*"; }      fi
if ! command -v log_warn >/dev/null 2>&1;    then log_warn()    { echo "$*" >&2; }  fi
if ! command -v log_success >/dev/null 2>&1; then log_success() { echo "$*"; }      fi

# ============================================================================
# ApexNodes region detection (decides whether CN mirror env gets injected)
# ============================================================================
# hc-474 demoted this block from install-path gatekeeper to mirror tuner: the
# COS download helpers below no longer consult the region at all, so the ONLY
# thing decided here is whether the third-party CN package mirrors (pypi/npm/
# node/electron/playwright) get exported by apexnodes_apply_cn_mirror_env. A
# wrong answer costs download speed, never install success.
#
# Precedence (highest first):
#   1. HERMES_CN_MIRRORS already set in the env  -> respect it verbatim, skip
#      detection entirely (ops/CI escape hatch; packaged desktop forwards it).
#   2. APEXNODES_REGION=cn|global                -> explicit operator/user knob.
#   3. neither set                              -> fresh decisive probe below;
#      default to "global" (upstream sources) on any doubt.
#
# hc-474 heuristic diet: the old timezone gate + npmmirror-vs-npmjs race and
# the $HERMES_HOME/.apexnodes-region cache READ (plus its stale-'global'
# self-heal) are deleted. The cache made a one-shot misdetection permanent —
# exactly the F2 failure — and only existed to amortize probe cost across
# stage processes back when the probe gated the fatal runtime-clone path.
# Now every resolve probes fresh (bounded: one ≤6s HEAD when github answers,
# +≤5s domestic HEAD when it doesn't) and the file is WRITE-ONLY telemetry:
# the runtime side (apex_overlay/region.py rule 3, node-bootstrap belt) still
# reads it as a region *signal*, but no install-time decision ever does.

# Lowercase helper that works on bash 3.2 (macOS /bin/bash lacks ${var,,}).
_an_lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Region diagnostics go to STDERR, never stdout. stdout is the structured
# channel the bootstrap runner parses for --manifest / --stage --json frames;
# the runner forwards stderr as ordinary log lines, so the user still sees this.
_an_log() { echo "$1" >&2; }

# Probe github.com itself — it is THE canonical GFW block (hc-463). Returns 0
# (true) when github is UNREACHABLE; a conservative 1 when we cannot probe
# (no curl), so absence of proof never biases toward CN.
_an_github_unreachable() {
    command -v curl >/dev/null 2>&1 || return 1
    curl -fsS -I --max-time 6 "https://github.com/" >/dev/null 2>&1 && return 1
    return 0
}

# Domestic-reachability guard: only pair the github-unreachable signal with a
# confirmed-up domestic mirror, so a fully-offline box is never classified as CN.
# Returns 0 (true) when the domestic mirror is REACHABLE.
_an_domestic_reachable() {
    command -v curl >/dev/null 2>&1 || return 1
    curl -fsS -I --max-time 5 "https://registry.npmmirror.com/" >/dev/null 2>&1 && return 0
    return 1
}

# Resolve the region into HERMES_CN_MIRRORS. No-op when HERMES_CN_MIRRORS is
# already set (precedence rule 1). Never reads the cache file (hc-474); writes
# it as telemetry + runtime region signal.
apexnodes_resolve_region() {
    # Rule 1: explicit HERMES_CN_MIRRORS wins; do not touch it, do not probe.
    if [ -n "${HERMES_CN_MIRRORS:-}" ]; then
        return 0
    fi

    # Rule 2: explicit region knob.
    local region
    region="$(_an_lower "${APEXNODES_REGION:-}")"
    case "$region" in
        cn|china|mainland)
            export HERMES_CN_MIRRORS=1
            _an_log "→ ApexNodes region: cn (from APEXNODES_REGION) — using China mirrors"
            return 0 ;;
        global|intl|international|foreign|row)
            export HERMES_CN_MIRRORS=0
            _an_log "→ ApexNodes region: global (from APEXNODES_REGION) — using default sources"
            return 0 ;;
        "") : ;;  # fall through to auto-detect
        *)
            _an_log "⚠ Unknown APEXNODES_REGION='${APEXNODES_REGION}' (expected cn|global) — auto-detecting" ;;
    esac

    # Rule 3: fresh decisive probe. github.com unreachable WHILE a domestic
    # mirror is up = a network that blocks github but not domestic = CN.
    # Requiring domestic-reachable keeps a fully-offline box on "global".
    # Everything ambiguous (github reachable, or nothing reachable) = global:
    # upstream sources work there, and since hc-474 the COS-first artifact
    # path no longer depends on this answer, so we no longer need the old
    # timezone/npmjs heuristics to rescue edge cases.
    local detected="global"
    if _an_github_unreachable && _an_domestic_reachable; then
        detected="cn"
    fi

    # Telemetry write (best-effort; never fail the install). Install-time code
    # never reads this back — the runtime region signal (apex_overlay/region.py)
    # does. Delete the file or set APEXNODES_REGION to steer runtime behavior.
    mkdir -p "${HERMES_HOME:-$HOME/.hermes}" 2>/dev/null || true
    printf '%s\n' "$detected" > "${HERMES_HOME:-$HOME/.hermes}/.apexnodes-region" 2>/dev/null || true

    if [ "$detected" = "cn" ]; then
        export HERMES_CN_MIRRORS=1
        _an_log "→ ApexNodes region: cn (auto-detected) — using China mirrors"
        _an_log "  (override with APEXNODES_REGION=global if this is wrong)"
    else
        export HERMES_CN_MIRRORS=0
        # Quiet on the global path to keep upstream/CI output byte-clean.
    fi
}

# ============================================================================
# ApexNodes China mirror mode (opt-in via HERMES_CN_MIRRORS=1)
# ============================================================================
# OFF by default: with the flag unset apexnodes_apply_cn_mirror_env does nothing
# and the third-party package sources stay byte-for-byte upstream (curl|bash
# one-liner, CI, etc). Since hc-474 this flag governs ONLY the third-party
# mirror env below — the COS artifact helpers are region-independent and keyed
# solely on HERMES_RUNTIME_COS_BASE (see apexnodes_cos_configured).
#
# The split is deliberate:
#   * Our runtime source + uv come from our own public-read COS bucket for
#     EVERY region (COS-first, foreign fallback) — see
#     apexnodes_download_runtime_tarball / apexnodes_install_uv_from_cos.
#   * Public third-party dependencies use an established CN mirror below,
#     but only on CN deployments — TUNA (pypi) has no global CDN and pointing
#     the world at CN mirrors would degrade non-CN installs.
# Each value uses ${VAR:-default} so an operator can override any single mirror
# via the real environment without editing this script.
apexnodes_cn_enabled() { [ "${HERMES_CN_MIRRORS:-0}" = "1" ]; }

# hc-474: "is COS-first configured for this install channel?" — true whenever
# the public-read COS base is present (desktop bundle / cloud image / ops set
# it; the upstream curl|bash path never does). This — not the region — gates
# every COS artifact path, including install.sh's interrupted-install reuse
# branch for a COS-populated (git-less) checkout.
apexnodes_cos_configured() { [ -n "${HERMES_RUNTIME_COS_BASE:-}" ]; }

# Export the CN mirror env (no-op unless CN mode is on). Idempotent: every value
# uses ${VAR:-default} so a pre-set operator override is preserved.
apexnodes_apply_cn_mirror_env() {
    apexnodes_cn_enabled || return 0
    # Python package index → Tsinghua TUNA (PyPI mirror).
    export UV_DEFAULT_INDEX="${UV_DEFAULT_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
    export UV_INDEX_URL="${UV_INDEX_URL:-$UV_DEFAULT_INDEX}"
    export PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
    # uv-managed CPython (astral python-build-standalone) → npmmirror binary mirror.
    export UV_PYTHON_INSTALL_MIRROR="${UV_PYTHON_INSTALL_MIRROR:-https://registry.npmmirror.com/-/binary/python-build-standalone}"
    # npm registry + Electron binaries → npmmirror.
    export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"
    export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
    # Node.js dist tarballs → npmmirror binary mirror (consumed by install_node).
    export HERMES_NODE_DIST_BASE="${HERMES_NODE_DIST_BASE:-https://registry.npmmirror.com/-/binary/node}"
    # hc-476: Playwright's Chromium download (~170MB, no CN CDN) → npmmirror's
    # official binary-mirror-config value (cnpm/binary-mirror-config "china"
    # ENVS). Read natively by `playwright install` itself, so this covers every
    # call site (install.sh/.ps1 AND the runtime autoinstall in browser_tool.py).
    export PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.npmmirror.com/binaries/playwright}"
}

# ============================================================================
# CN-mode COS download helpers
# ============================================================================

# Map the current OS/arch to an astral uv release target triple (the names uv
# publishes its tarballs under, e.g. uv-aarch64-apple-darwin.tar.gz). Used to
# build the COS mirror download URL in CN mode. Returns non-zero (no output)
# for unsupported platforms so the caller falls back to the astral installer.
_uv_target_triple() {
    local arch
    arch="$(uname -m)"
    case "$OS" in
        macos)
            case "$arch" in
                arm64|aarch64) echo "aarch64-apple-darwin" ;;
                x86_64) echo "x86_64-apple-darwin" ;;
                *) return 1 ;;
            esac
            ;;
        linux)
            case "$arch" in
                x86_64) echo "x86_64-unknown-linux-gnu" ;;
                aarch64|arm64) echo "aarch64-unknown-linux-gnu" ;;
                *) return 1 ;;
            esac
            ;;
        *) return 1 ;;
    esac
}

# COS-first (hc-474: every region): fetch a prebuilt uv from our public-read
# COS bucket before the astral.sh installer, which downloads the binary from
# github.com (blocked in mainland China, rate-limited elsewhere). The publish
# script (scripts/publish-runtime-tarball.sh) mirrors uv-<triple>.tar.gz next
# to the runtime tarball. On any failure we return non-zero so install_uv
# falls through to the astral path. Sets UV_CMD.
apexnodes_install_uv_from_cos() {
    apexnodes_cos_configured || return 1
    command -v curl >/dev/null 2>&1 || return 1

    local triple
    triple="$(_uv_target_triple)" || return 1
    [ -n "$triple" ] || return 1

    local url="${HERMES_RUNTIME_COS_BASE%/}/uv-${triple}.tar.gz"
    local tmp
    tmp="$(mktemp -d 2>/dev/null || echo "/tmp/hermes-uv.$$")"
    mkdir -p "$tmp" "$HERMES_HOME/bin"

    log_info "Fetching uv from COS mirror: $url"
    if ! curl -fsSL --max-time 120 "$url" -o "$tmp/uv.tar.gz"; then
        log_warn "COS uv download failed ($url) — will try the astral.sh installer"
        rm -rf "$tmp"
        return 1
    fi
    if ! tar xzf "$tmp/uv.tar.gz" -C "$tmp" 2>/dev/null; then
        log_warn "COS uv tarball could not be extracted — will try the astral.sh installer"
        rm -rf "$tmp"
        return 1
    fi

    # uv tarballs unpack into uv-<triple>/{uv,uvx}; locate the binaries by name.
    local found foundx
    found="$(find "$tmp" -type f -name uv 2>/dev/null | head -1)"
    if [ -z "$found" ]; then
        log_warn "uv binary not found inside COS tarball — will try the astral.sh installer"
        rm -rf "$tmp"
        return 1
    fi
    cp "$found" "$HERMES_HOME/bin/uv"
    chmod +x "$HERMES_HOME/bin/uv"
    foundx="$(find "$tmp" -type f -name uvx 2>/dev/null | head -1)"
    if [ -n "$foundx" ]; then
        cp "$foundx" "$HERMES_HOME/bin/uvx"
        chmod +x "$HERMES_HOME/bin/uvx"
    fi
    rm -rf "$tmp"

    if [ ! -x "$HERMES_HOME/bin/uv" ]; then
        return 1
    fi
    UV_CMD="$HERMES_HOME/bin/uv"
    UV_VERSION=$($UV_CMD --version 2>/dev/null)
    log_success "Managed uv installed from COS mirror ($UV_VERSION)"
    return 0
}

# COS-first (hc-474: every region): download the pinned runtime source as a
# tarball from our public-read COS bucket before any git clone of github.com
# (blocked/slow in mainland China). The tarball is `git archive
# --prefix=hermes-agent/` of the pinned upstream commit — a clean source tree
# with NO .git directory. Keyed by the pinned commit (preferred) or branch so
# the COS object matches the build stamp. Returns 0 with INSTALL_DIR populated
# on success; non-zero (and INSTALL_DIR removed) on any failure so clone_repo
# falls back to a normal git clone.
apexnodes_download_runtime_tarball() {
    apexnodes_cos_configured || return 1
    command -v curl >/dev/null 2>&1 || return 1

    local key="${INSTALL_COMMIT:-$BRANCH}"
    [ -n "$key" ] || return 1

    local url="${HERMES_RUNTIME_COS_BASE%/}/hermes-agent-${key}.tar.gz"
    local tmp
    tmp="$(mktemp -d 2>/dev/null || echo "/tmp/hermes-src.$$")"
    mkdir -p "$tmp"

    log_info "Downloading runtime source from COS mirror: $url"
    if ! curl -fsSL --max-time 300 "$url" -o "$tmp/runtime.tar.gz"; then
        log_warn "COS runtime download failed ($url) — falling back to git clone"
        rm -rf "$tmp"
        return 1
    fi

    mkdir -p "$INSTALL_DIR"
    # Archive is built with --prefix=hermes-agent/, so strip the leading dir.
    if ! tar xzf "$tmp/runtime.tar.gz" -C "$INSTALL_DIR" --strip-components=1; then
        log_warn "COS runtime tarball could not be extracted — falling back to git clone"
        rm -rf "$tmp" "$INSTALL_DIR"
        return 1
    fi
    rm -rf "$tmp"

    if [ ! -f "$INSTALL_DIR/pyproject.toml" ]; then
        log_warn "COS runtime tarball missing pyproject.toml — falling back to git clone"
        rm -rf "$INSTALL_DIR"
        return 1
    fi

    log_success "Runtime source ready from COS mirror ($key)"
    return 0
}
