#!/bin/bash

set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 VERSION" >&2
  exit 2
fi

version=$1
tag="v$version"
archive_url="https://github.com/rsheyd/google-docs-markdown-sync/archive/refs/tags/$tag.tar.gz"
work_directory=$(mktemp -d "${TMPDIR:-/tmp}/gdms-homebrew-formula.XXXXXX")
archive_path="$work_directory/$tag.tar.gz"
tap_directory="$work_directory/homebrew-tap"
trap 'rm -rf "$work_directory"' EXIT

for command in awk brew curl gh git perl shasum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

gh release view "$tag" --repo rsheyd/google-docs-markdown-sync >/dev/null
curl --fail --location --silent --show-error "$archive_url" --output "$archive_path"
sha256=$(shasum -a 256 "$archive_path" | awk '{ print $1 }')

gh repo clone rsheyd/homebrew-tap "$tap_directory" -- --quiet
formula_path="$tap_directory/Formula/gdms.rb"
perl -0pi -e 's{archive/refs/tags/v[^/]+\.tar\.gz}{archive/refs/tags/v'"$version"'.tar.gz}; s{sha256 "[0-9a-f]+"}{sha256 "'"$sha256"'"}' "$formula_path"

if git -C "$tap_directory" diff --quiet -- "$formula_path"; then
  echo "Homebrew formula already points to $tag."
  exit 0
fi

brew style "$formula_path"
git -C "$tap_directory" add Formula/gdms.rb
git -C "$tap_directory" commit -m "Update GDMS to $version"
git -C "$tap_directory" push origin main
echo "Updated rsheyd/homebrew-tap to GDMS $version."
