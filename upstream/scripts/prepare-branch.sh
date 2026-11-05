#!/usr/bin/env bash
# Assembles the upstream contribution in a checkout of x402-foundation/x402
# (nothing is committed or pushed):
#   upstream/scripts/prepare-branch.sh <path to an x402 checkout>
# The checkout should be at BASE_COMMIT (or a later commit the patch applies to).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:?usage: prepare-branch.sh <x402 checkout>}"
cd "$dest"
git diff --quiet || { echo "the checkout has local changes" >&2; exit 1; }
rsync -a --delete --exclude node_modules \
  "$here/typescript/packages/mechanisms/obyte/" typescript/packages/mechanisms/obyte/
cp "$here/specs/schemes/exact/scheme_exact_obyte.md" specs/schemes/exact/
cp "$here/e2e/config/mechanisms_obyte.json" e2e/config/
cp "$here/typescript/.changeset/obyte-exact.md" typescript/.changeset/
git apply "$here/e2e-registration.patch"
echo "Ready in $dest (base $(cat "$here/BASE_COMMIT")). Review with: git status"
