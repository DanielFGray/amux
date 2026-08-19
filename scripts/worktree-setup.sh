#!/usr/bin/env bash
# Prepares an isolated amux worktree. A git worktree shares the repository's
# objects but none of its build state: no node_modules, no vendor/, no native
# artifacts.
#
# The expensive parts — the pinned Ghostty source, the pinned Zig toolchain and
# the compiled libghostty-vt — are shared across every worktree of this
# repository, not re-downloaded or recompiled per worktree. A worktree finds the
# operator's checkout through git's common dir and keeps the cache there, under
# a gitignored directory, so the download and the compile happen once per
# machine and every worktree borrows the result. Sharing is safe only because
# each download is verified against a pinned sha256; the shared build is then
# keyed by that pin, the platform and the Zig version.
#
# The steps that stay local are the cheap ones: `bun install` (bun hardlinks
# from its own global cache) and the ~21 KB native shim.
#
# Each step guards on what it produces, so re-running is safe.

set -euo pipefail

ghostty_commit="c5a21edfcbc2d5b46540ad91b7980aca31f5f1f3"
ghostty_sha256="84123887f93254387a333831cb544cbb23fb1f63eb9980db4ca94463f929c376"
ghostty_url="https://github.com/ghostty-org/ghostty/archive/${ghostty_commit}.tar.gz"
zig_version="0.15.2"

git_common_dir="$(git rev-parse --git-common-dir)"
parent="$(cd "$git_common_dir" && cd .. && pwd -P)"
cache="$parent/.cache/amux-vendor"

platform=""
zig_sha256=""
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    platform="x86_64-linux"
    zig_sha256="02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239"
    ;;
  Linux:aarch64)
    platform="aarch64-linux"
    zig_sha256="958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f"
    ;;
  Darwin:x86_64)
    platform="x86_64-macos"
    zig_sha256="375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f"
    ;;
  Darwin:arm64)
    platform="aarch64-macos"
    zig_sha256="3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b"
    ;;
  *)
    echo "unsupported platform for Zig ${zig_version}: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

zig_dir="$cache/zig-${platform}-${zig_version}"
ghostty_src="$cache/ghostty-${ghostty_commit}"
ghostty_build="$cache/ghostty-${ghostty_commit}-${platform}-${zig_version}/zig-out"

download() {
  local url="$1"
  local destination="$2"
  local sha256="$3"

  curl --fail --location --retry 3 --output "$destination" "$url"
  printf '%s  %s\n' "$sha256" "$destination" | sha256sum --check --status
}

# Two setups must never download into or compile the same cache at once. A
# directory is the lock; an interrupted run drops it via the EXIT trap.
mkdir -p "$cache"
lock="$cache/.lock"
locked=false
for _ in {1..120}; do
  if mkdir "$lock" 2>/dev/null; then
    trap 'rmdir "$lock" 2>/dev/null || true' EXIT
    locked=true
    break
  fi
  sleep 2
done
if [[ "$locked" != true ]]; then
  echo "timed out waiting for the shared vendor cache at $cache" >&2
  exit 1
fi

if [[ ! -x "$zig_dir/zig" ]]; then
  archive="$cache/zig-${platform}-${zig_version}.tar.xz"
  download "https://ziglang.org/download/${zig_version}/zig-${platform}-${zig_version}.tar.xz" "$archive" "$zig_sha256"
  tar --extract --file "$archive" --directory "$cache"
fi

if [[ ! -f "$ghostty_src/build.zig" ]]; then
  archive="$cache/ghostty-${ghostty_commit}.tar.gz"
  download "$ghostty_url" "$archive" "$ghostty_sha256"
  mkdir -p "$ghostty_src"
  tar --extract --gzip --file "$archive" --directory "$ghostty_src" --strip-components=1
fi

if [[ ! -f "$ghostty_build/lib/libghostty-vt.so.0.1.0" ]]; then
  (cd "$ghostty_src" && "$zig_dir/zig" build -Demit-lib-vt -Doptimize=ReleaseFast)
  mkdir -p "$(dirname "$ghostty_build")"
  mv "$ghostty_src/zig-out" "$ghostty_build"
fi

# Point this worktree's vendor tree at the shared build rather than copying it.
mkdir -p vendor/libghostty-vt
if [[ "$(readlink vendor/libghostty-vt/zig-out 2>/dev/null)" != "$ghostty_build" ]]; then
  rm -rf vendor/libghostty-vt/zig-out
  ln -s "$ghostty_build" vendor/libghostty-vt/zig-out
fi

if [[ ! -d node_modules ]]; then
  bun install --ignore-scripts
fi

if [[ ! -f vendor/libamux-shim.so ]]; then
  bun run build:shim
fi

./node_modules/.bin/effect-tsgo patch --typescript
