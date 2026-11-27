#!/usr/bin/env bash
# Publish docs/wiki/*.md to the repository's GitHub wiki.
#
#   scripts/sync-wiki.sh                 # current repository (from the origin remote)
#   scripts/sync-wiki.sh owner/repo      # another repository
#   DRY_RUN=1 scripts/sync-wiki.sh       # show what would change, push nothing
#
# The wiki is a separate git repository (<repo>.wiki.git). GitHub only creates it after the FIRST page has been saved
# once in the web UI: open the repository's Wiki tab, click "Create the first page", save anything, then run this.
# Pages in the wiki that are not in docs/wiki/ are left alone; pages that are in docs/wiki/ are overwritten.
# Commits use your current git identity (git config user.name / user.email).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
src="docs/wiki"
[ -d "$src" ] || { echo "Missing $src" >&2; exit 1; }

if [ $# -ge 1 ]; then
  repo="$1"
else
  origin="$(git remote get-url origin)"
  repo="$(printf '%s' "$origin" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
fi
case "$repo" in
  */*) ;;
  *) echo "Could not work out owner/repo (got '$repo'). Pass it as an argument." >&2; exit 1 ;;
esac

wiki_url="https://github.com/${repo}.wiki.git"
work="$(mktemp -d "${TMPDIR:-/tmp}/sserp-wiki.XXXXXX")"
trap 'rm -rf "$work"' EXIT

echo "Cloning $wiki_url ..."
if ! git clone --quiet --depth 1 "$wiki_url" "$work/wiki" 2>"$work/clone.err"; then
  cat "$work/clone.err" >&2
  cat >&2 <<EOF

The wiki repository for $repo could not be cloned.
- If the wiki has never been used: GitHub creates ${repo}.wiki.git only after the first page is saved in the web UI.
  Open https://github.com/${repo}/wiki, click "Create the first page", save it, then run this script again.
- Check that the wiki is enabled (Settings > General > Features > Wikis) and that you are authenticated with write
  access (for example: gh auth login && gh auth setup-git).
EOF
  exit 1
fi

name="$(git config user.name || true)"
email="$(git config user.email || true)"
if [ -z "$name" ] || [ -z "$email" ]; then
  echo "Set your git identity first (git config user.name / user.email)." >&2
  exit 1
fi

cp "$src"/*.md "$work/wiki/"
cd "$work/wiki"
git add -A
if git diff --cached --quiet; then
  echo "Wiki is already up to date."
  exit 0
fi
git status --short
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1: not committing or pushing."
  exit 0
fi
source_rev="$(git -C "$OLDPWD" rev-parse --short HEAD)"
git -c user.name="$name" -c user.email="$email" commit --quiet -m "Sync wiki from docs/wiki at ${source_rev}"
git push --quiet origin HEAD
echo "Wiki updated: https://github.com/${repo}/wiki"
