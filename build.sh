set -euo pipefail

npx ncc build src/fingerprint-native/index.ts -o build/fingerprint-native
npx ncc build src/fingerprint-runtime/index.ts -o build/fingerprint-runtime
