#!/usr/bin/env bash
# Links the runtime dependencies of upstream/…/mechanisms/obyte to the copies
# already installed in this workspace (no download, no install scripts), so
# the package can be type-checked and tested here before it goes upstream.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
pkg="$root/upstream/typescript/packages/mechanisms/obyte"
store="$root/node_modules/.pnpm"
link() { # <name> <store dir glob>
  local target
  target="$(ls -d "$store"/$2/node_modules/"$1" | head -1)"
  mkdir -p "$pkg/node_modules/$(dirname "$1")"
  ln -sfn "$target" "$pkg/node_modules/$1"
}
link @x402/core '@x402+core@2.29.0'
link obyte 'obyte@0.2.1'
link zod 'zod@4.6.7'
link @noble/hashes '@noble+hashes@1.8.0'
link @types/node '@types+node@24.*'
echo "linked into $pkg/node_modules"
