rm -rf build/fingerprint-native/index.js
npx ncc build src/fingerprint-native/index.ts -o build/fingerprint-native
