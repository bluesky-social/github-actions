#!/usr/bin/env bash

rm -rf build/fingerprint-native build/fingerprint-native-worker
npx ncc build src/fingerprint-native/index.ts -o build/fingerprint-native
npx ncc build src/fingerprint-native/fingerprint.ts -o build/fingerprint-native-worker --minify
mv build/fingerprint-native-worker/index.js build/fingerprint-native/fingerprint.js
rm -rf build/fingerprint-native-worker
