#!/usr/bin/env bash
set -Eeuo pipefail

# Retitle the changesets "Version Packages" PR to list the package it bumps + the new version:
#
#   Release: co-canvas@0.2.0
#
# co-canvas versions one package (`co-canvas`), so this is normally a single entry, but the
# set is discovered from the PR's own changed files rather than hardcoded — `changeset version`
# only edits a bumped package's `package.json`, so any changed `<packages|apps>/<pkg>/package.json`
# is a release in this PR.
#
# Why retitle at all: changesets/action's `title` input is a STATIC string evaluated before
# `changeset version` runs, so it cannot carry the bumped version. This runs AFTER the action
# (which has already pushed the bumped package.json to the PR head) and edits the title via the
# API. The PR body is left alone — the action fills it with the changelog.
#
# The title doubles as the squash-merge commit message. Idempotent — recomputed on every push.
# CI-only (release.yml).
#
# Usage: title-version-pr.sh <pr-number>

PR="$1"
REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
branch="$(gh pr view "$PR" --json headRefName -q .headRefName)"

# Versions are read from the GitHub Contents API at the branch ref — under actions/checkout
# the narrow fetch refspec leaves origin/<branch> stale after the action force-pushes the
# bump, so a local `git show origin/<branch>:...` would read the OLD version ("no change").
parts=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  parts+="$(gh api "repos/$REPO/contents/$path?ref=$branch" -H "Accept: application/vnd.github.raw" \
    | jq -r '"\(.name)@\(.version)"')"$'\n'
done < <(
  gh pr view "$PR" --json files -q '.files[].path' \
    | grep -E '^(packages|apps)/[^/]+/package\.json$'
)

parts="$(printf '%s' "$parts" | sed '/^$/d' | sort)"
if [ -z "$parts" ]; then
  echo "No package bumped; leaving title unchanged."
  exit 0
fi

title="Release:"
sep=" "
while IFS= read -r p; do
  title+="$sep$p"
  sep=", "
done <<<"$parts"

echo "Setting PR #$PR title: $title"
gh pr edit "$PR" --title "$title"
