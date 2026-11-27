#!/usr/bin/env bash
# Create or update the repository's labels from .github/labels.yml with the GitHub CLI.
# Existing labels with the same name are updated (--force); labels not in the file are left alone.
#
#   scripts/sync-labels.sh                     # current repository (gh repo view)
#   scripts/sync-labels.sh owner/repo          # another repository
#
# Needs: gh (authenticated, with write access) and node. No other dependencies.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

# Minimal parser for the flat list format used by .github/labels.yml; prints name<TAB>color<TAB>description.
labels="$(node -e '
const fs = require("fs")
const unquote = (v) => { v = v.trim(); return /^".*"$/.test(v) || /^\x27.*\x27$/.test(v) ? v.slice(1, -1) : v }
const out = []
let cur = null
for (const raw of fs.readFileSync(".github/labels.yml", "utf8").split(/\r?\n/)) {
  const line = raw.replace(/\s+#.*$/, "")
  if (!line.trim() || line.trim().startsWith("#")) continue
  const m = /^(- |  )(name|color|description):\s*(.*)$/.exec(line)
  if (!m) { console.error("labels.yml: cannot parse line: " + raw); process.exit(1) }
  if (m[1] === "- ") { cur = {}; out.push(cur) }
  cur[m[2]] = unquote(m[3])
}
for (const l of out) {
  if (!l.name || !/^[0-9a-fA-F]{6}$/.test(l.color || "") || (l.description || "").length > 100) {
    console.error("labels.yml: invalid entry " + JSON.stringify(l)); process.exit(1)
  }
  console.log([l.name, l.color, l.description || ""].join("\t"))
}
')"

count=0
while IFS=$'\t' read -r name color description; do
  gh label create "$name" --repo "$repo" --color "$color" --description "$description" --force >/dev/null
  echo "ok  $name"
  count=$((count + 1))
done <<<"$labels"
echo "Synced $count labels to $repo."
