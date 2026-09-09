#!/usr/bin/env bash

set -euo pipefail

mkdir -p build
build_tmp=$(mktemp -d build/.fingerprint-native.XXXXXX)
trap 'rm -rf "$build_tmp"' EXIT

./node_modules/.bin/ncc build src/fingerprint-native/index.ts -o "$build_tmp/action"
./node_modules/.bin/ncc build src/fingerprint-native/fingerprint.ts -o "$build_tmp/worker" --minify
# Expo launches this helper in a separate process to load project config/plugins.
./node_modules/.bin/ncc build node_modules/@expo/fingerprint/build/ExpoConfigLoader.js -o "$build_tmp/loader" --minify
mv "$build_tmp/worker/index.js" "$build_tmp/action/fingerprint.js"
mv "$build_tmp/loader/index.js" "$build_tmp/action/ExpoConfigLoader.js"

rm -rf build/fingerprint-native
mv "$build_tmp/action" build/fingerprint-native
