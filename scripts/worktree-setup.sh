#!/usr/bin/env bash

set -euo pipefail

ghostty_commit="c5a21edfcbc2d5b46540ad91b7980aca31f5f1f3"
ghostty_sha256="84123887f93254387a333831cb544cbb23fb1f63eb9980db4ca94463f929c376"
ghostty_url="https://github.com/ghostty-org/ghostty/archive/${ghostty_commit}.tar.gz"
zig_version="0.15.2"

download() {
  local url="$1"
  local destination="$2"
  local sha256="$3"

  curl --fail --location --retry 3 --output "$destination" "$url"
  printf '%s  %s\n' "$sha256" "$destination" | sha256sum --check --status
}

install_zig() {
  local platform
  local sha256

  case "$(uname -s):$(uname -m)" in
    Linux:x86_64)
      platform="x86_64-linux"
      sha256="02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239"
      ;;
    Linux:aarch64)
      platform="aarch64-linux"
      sha256="958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f"
      ;;
    Darwin:x86_64)
      platform="x86_64-macos"
      sha256="375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f"
      ;;
    Darwin:arm64)
      platform="aarch64-macos"
      sha256="3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b"
      ;;
    *)
      echo "unsupported platform for Zig ${zig_version}: $(uname -s) $(uname -m)" >&2
      exit 1
      ;;
  esac

  local archive=".cache/zig-${platform}-${zig_version}.tar.xz"
  local directory=".cache/zig-${platform}-${zig_version}"
  if [[ ! -x "${directory}/zig" ]]; then
    mkdir -p .cache
    download "https://ziglang.org/download/${zig_version}/zig-${platform}-${zig_version}.tar.xz" "$archive" "$sha256"
    tar --extract --file "$archive" --directory .cache
  fi
  printf '%s\n' "${directory}/zig"
}

if [[ ! -f vendor/libghostty-vt/zig-out/lib/libghostty-vt.so.0.1.0 ]]; then
  if [[ ! -f vendor/libghostty-vt/build.zig ]]; then
    archive=".cache/ghostty-${ghostty_commit}.tar.gz"
    mkdir -p .cache vendor/libghostty-vt
    download "$ghostty_url" "$archive" "$ghostty_sha256"
    tar --extract --gzip --file "$archive" --directory vendor/libghostty-vt --strip-components=1
  fi
  zig="$(pwd)/$(install_zig)"
  (cd vendor/libghostty-vt && "$zig" build -Demit-lib-vt -Doptimize=ReleaseFast)
fi

if [[ ! -d node_modules ]]; then
  bun install
elif [[ ! -f vendor/libamux-shim.so ]]; then
  bun run build:shim
fi
