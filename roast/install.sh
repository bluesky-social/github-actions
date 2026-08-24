#!/usr/bin/env bash

set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_CACHE_DIR:?RELEASE_CACHE_DIR is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required to install Roast" >&2
  exit 1
fi

if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "release-tag must look like v1.2.3 (received: $RELEASE_TAG)" >&2
  exit 1
fi

case "${RUNNER_OS:-}" in
  Linux) roast_os=linux ;;
  macOS) roast_os=darwin ;;
  *)
    echo "Roast supports Linux and macOS runners (received: ${RUNNER_OS:-unknown})" >&2
    exit 1
    ;;
esac

case "${RUNNER_ARCH:-}" in
  X64) roast_arch=amd64 ;;
  ARM64) roast_arch=arm64 ;;
  *)
    echo "Roast supports X64 and ARM64 runners (received: ${RUNNER_ARCH:-unknown})" >&2
    exit 1
    ;;
esac

version="${RELEASE_TAG#v}"
asset="roast_${version}_${roast_os}_${roast_arch}.tar.gz"
download_dir="$RELEASE_CACHE_DIR"
bin_dir="${RUNNER_TEMP}/roast-bin"
mkdir -p "$download_dir" "$bin_dir"

if [[ -s "$download_dir/$asset" && -s "$download_dir/checksums.txt" ]]; then
  echo "Using cached Roast release $RELEASE_TAG for $roast_os/$roast_arch"
else
  : "${GH_TOKEN:?GH_TOKEN is required when the Roast release is not cached}"
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh is required to download Roast" >&2
    exit 1
  fi

  gh release download "$RELEASE_TAG" \
    --repo bluesky-social/roast \
    --pattern "$asset" \
    --pattern checksums.txt \
    --dir "$download_dir"
fi

checksum_line="$(awk -v asset="$asset" '$2 == asset { print; exit }' "$download_dir/checksums.txt")"
if [[ -z "$checksum_line" ]]; then
  echo "checksums.txt did not contain an entry for $asset" >&2
  exit 1
fi

(
  cd "$download_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "$checksum_line" | sha256sum -c -
  else
    printf '%s\n' "$checksum_line" | shasum -a 256 -c -
  fi
)

tar -xzf "$download_dir/$asset" -C "$bin_dir" roast
chmod +x "$bin_dir/roast"
echo "$bin_dir" >>"$GITHUB_PATH"

installed_version="$("$bin_dir/roast" --version)"
echo "$installed_version"
if [[ ! "$installed_version" =~ ^roast[[:space:]]version[[:space:]]([^[:space:]]+) ]]; then
  echo "Could not parse the installed Roast version: $installed_version" >&2
  exit 1
fi
reported_version="${BASH_REMATCH[1]#v}"
if [[ "$reported_version" != "$version" ]]; then
  echo "Installed Roast reports $reported_version, expected $version" >&2
  exit 1
fi
echo "version=$version" >>"$GITHUB_OUTPUT"
