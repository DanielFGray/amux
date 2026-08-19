#!/usr/bin/env bash
# Restores what a fresh amux worktree lacks: the vendored native artifacts and
# the installed dependencies. A git worktree has neither.
#
# Each step guards on what it produces, so re-running is safe.

set -euo pipefail

main_checkout="$(git rev-parse --git-common-dir)"
main_checkout="${main_checkout%/.git}"

# build:shim needs vendor/libghostty-vt, which is never committed. Share the
# main checkout's vendor directory instead of rebuilding it.
if [ ! -e vendor ] && [ ! -L vendor ]; then
  ln -s "$main_checkout/vendor" vendor
fi

# bun install's prepare step (effect-tsgo patch) fails on a missing oxlint
# native binary, but the dependency install itself succeeds. Treat that as
# acceptable: verify node_modules landed, not the install exit code.
if [ ! -d node_modules ]; then
  if ! bun install; then
    [ -d node_modules ] || {
      echo "bun install left no node_modules" >&2
      exit 1
    }
  fi
fi
