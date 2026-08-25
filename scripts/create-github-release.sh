#!/bin/bash

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
repository_root=$(cd "$script_directory/.." && pwd)
changelog_path="$repository_root/CHANGELOG.md"
dry_run=false

if [[ ${1:-} == "--dry-run" ]]; then
  dry_run=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

for command in awk gh git; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

release_header=$(awk '/^## \[[^]]+\] - / { print; exit }' "$changelog_path")
if [[ ! $release_header =~ ^##\ \[([^]]+)\]\ -\ (.+)$ ]]; then
  echo "Could not find a release heading like '## [0.8.4] - 2026-08-25' in CHANGELOG.md." >&2
  exit 1
fi

version=${BASH_REMATCH[1]}
tag="v$version"
notes_file=$(mktemp "${TMPDIR:-/tmp}/gdms-release-notes.XXXXXX")
trap 'rm -f "$notes_file"' EXIT

awk -v header="$release_header" '
  $0 == header { found = 1; next }
  found && /^## \[[^]]+\] - / { exit }
  found { print }
' "$changelog_path" > "$notes_file"

if ! grep -q '[^[:space:]]' "$notes_file"; then
  echo "The $version changelog section has no release notes." >&2
  exit 1
fi

if $dry_run; then
  echo "Release: $tag"
  echo
  sed -e '/./,$!d' "$notes_file"
  exit 0
fi

if ! git -C "$repository_root" diff --quiet ||
  ! git -C "$repository_root" diff --cached --quiet; then
  echo "Commit the release changes before creating $tag." >&2
  exit 1
fi

if gh release view "$tag" --repo rsheyd/google-docs-markdown-sync >/dev/null 2>&1; then
  echo "GitHub release $tag already exists." >&2
  exit 1
fi

target=$(git -C "$repository_root" rev-parse HEAD)
gh release create "$tag" \
  --repo rsheyd/google-docs-markdown-sync \
  --target "$target" \
  --title "$tag" \
  --notes-file "$notes_file"
