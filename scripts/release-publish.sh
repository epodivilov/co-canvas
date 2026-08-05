#!/usr/bin/env bash
set -Eeuo pipefail

# Custom publish step for changesets/action (CC-25). Runs AFTER a "Version Packages" PR is
# merged, when no changesets are left on main. co-canvas ships as ONE product: the sole
# versioned package `co-canvas` (apps/cli) drives everything here — the npm version, the
# GitHub Release tag, and the three standalone `co-canvas-hub` binary names.
#
# Two artifacts per release, each made idempotent independently so a re-run of an already-
# published version is a no-op:
#
#   1. npm — `co-canvas@<ver>` is published to the public registry via npm trusted publishing
#      (OIDC). The workflow grants `id-token: write` and stores no npm token; npm exchanges the
#      GitHub OIDC token for a short-lived credential and attaches a provenance attestation
#      automatically. Skipped when the version is already on npm.
#
#   2. GitHub Release — `co-canvas@<ver>`, carrying the `co-canvas-hub` binary for linux-x64,
#      darwin-arm64 and windows-x64, all cross-compiled from this one Linux runner by
#      `apps/hub-cli/scripts/build-binary.mjs` (bun `--compile --target=…`). Assembled as a
#      DRAFT (tag + draft together), the assets uploaded, then un-drafted in one final step —
#      the only moment it goes live. Any failure in between deletes the draft AND its tag
#      (gh --cleanup-tag), so an interrupted publish leaves the previous release as "latest".
#      Skipped when a non-draft release already exists for the version.
#
# The first `co-canvas` publish and the npmjs.com trusted-publisher setup are the maintainer's
# one-time manual steps (out of scope, see CC-25); this runs every automated release after.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA="${GITHUB_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"

CLI_DIR="$REPO_ROOT/apps/cli"
HUBCLI_DIR="$REPO_ROOT/apps/hub-cli"
OUT="$REPO_ROOT/dist-release"

# The bun cross-compile targets, in the order the binaries are attached.
BUN_TARGETS=(bun-linux-x64 bun-darwin-arm64 bun-windows-x64)

read_version() { node -e 'process.stdout.write(require(process.argv[1]).version)' "$1"; }

# Where build-binary.mjs writes a compiled target (its filename embeds the raw bun target).
built_path() {
  local target="$1" ext=""
  [[ "$target" == bun-windows-* ]] && ext=".exe"
  echo "$HUBCLI_DIR/binaries/co-canvas-hub-$target$ext"
}

# The version-stamped, human-platform release asset name for a target.
asset_name() {
  local target="$1"
  case "$target" in
    bun-linux-x64)    echo "co-canvas-hub-$VER-linux-x64" ;;
    bun-darwin-arm64) echo "co-canvas-hub-$VER-darwin-arm64" ;;
    bun-windows-x64)  echo "co-canvas-hub-$VER-windows-x64.exe" ;;
    *) return 1 ;;
  esac
}

# Print the release-notes section for $ver from a changesets CHANGELOG ($file): the lines
# between the "## <ver>" heading and the next "## " heading.
extract_notes() {
  local file="$1" ver="$2"
  [ -f "$file" ] || return 0
  awk -v ver="$ver" '
    $0 == "## " ver { capture = 1; next }
    capture && /^## / { exit }
    capture { print }
  ' "$file"
}

VER="$(read_version "$CLI_DIR/package.json")"
TAG="co-canvas@$VER"

# What still needs doing (each artifact checked on its own so a partial prior run is repaired).
npm_needed=true
if npm view "co-canvas@$VER" version >/dev/null 2>&1; then
  npm_needed=false
  echo "npm already has co-canvas@$VER."
fi

gh_needed=true
if gh release view "$TAG" >/dev/null 2>&1 \
  && [ "$(gh release view "$TAG" --json isDraft -q .isDraft)" = "false" ]; then
  gh_needed=false
  echo "GitHub Release $TAG already exists."
fi

if ! $npm_needed && ! $gh_needed; then
  echo "Nothing to release: $TAG is fully published."
  exit 0
fi

echo "To release: $TAG (npm: $npm_needed, github: $gh_needed)"

# Build the frontend, then cross-compile all three hub binaries from this runner. The web
# build has to precede the compile — build-binary.mjs embeds apps/web/dist into each binary.
echo "==> Building frontend + cross-compiling hub binaries (${BUN_TARGETS[*]})..."
pnpm -C "$REPO_ROOT" --filter @co-canvas/web build
node "$HUBCLI_DIR/scripts/build-binary.mjs" "${BUN_TARGETS[@]}"

# Stage the built binaries under version-stamped names for upload.
rm -rf "$OUT"
mkdir -p "$OUT"
assets=()
for target in "${BUN_TARGETS[@]}"; do
  src="$(built_path "$target")"
  [ -f "$src" ] || { echo "Binary not built: $src" >&2; exit 1; }
  dst="$OUT/$(asset_name "$target")"
  cp "$src" "$dst"
  chmod +x "$dst" 2>/dev/null || true
  assets+=("$dst")
done

# npm — trusted publishing (OIDC): no token, provenance attached automatically. The package's
# `prepublishOnly` builds its dist (bundling the workspace sources + staging the hub) on the
# way out, so publishing straight from apps/cli ships a complete tarball.
if $npm_needed; then
  echo "==> Publishing co-canvas@$VER to npm (trusted publishing / OIDC)..."
  ( cd "$CLI_DIR" && npm publish --access public )
  echo "Published co-canvas@$VER to npm."
else
  echo "Skipping npm publish — already present."
fi

# GitHub Release — draft, upload, un-draft; roll the tag + draft back on any failure between.
if $gh_needed; then
  echo "==> Cutting GitHub Release $TAG with ${#assets[@]} binaries..."
  notes="$(mktemp)"
  extract_notes "$CLI_DIR/CHANGELOG.md" "$VER" >"$notes"
  [ -s "$notes" ] || echo "Release $TAG" >"$notes"

  # shellcheck disable=SC2317
  cleanup() { gh release delete "$TAG" --cleanup-tag --yes >/dev/null 2>&1 || true; }
  trap cleanup ERR

  # Clear a stale draft from a prior failed run (we only reach here if not yet published).
  gh release delete "$TAG" --cleanup-tag --yes >/dev/null 2>&1 || true

  gh release create "$TAG" --draft --title "$TAG" --notes-file "$notes" --target "$SHA"
  for asset in "${assets[@]}"; do
    gh release upload "$TAG" "$asset" --clobber
  done
  gh release edit "$TAG" --draft=false

  trap - ERR
  echo "Released $TAG"
  # changesets/action parses "New tag:" lines to populate its published-packages output.
  echo "New tag: $TAG"
else
  echo "Skipping GitHub Release — already exists."
fi
