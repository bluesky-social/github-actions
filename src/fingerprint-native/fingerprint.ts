type FingerprintModule = typeof import('@expo/fingerprint')

const loadFingerprintModule = (): FingerprintModule => {
  /*
   * ExpoConfigLoader can also run as a CLI and detects that mode by comparing
   * require.main.filename with __filename. ncc gives embedded modules the
   * worker bundle's filename, so distinguish the entrypoint while loading the
   * bundled module to prevent its CLI path from running.
   */
  const mainFilename = require.main?.filename
  if (require.main && mainFilename) {
    require.main.filename = `${mainFilename}.dependency`
  }
  try {
    return require('@expo/fingerprint')
  } finally {
    if (require.main && mainFilename) require.main.filename = mainFilename
  }
}

const run = async () => {
  const {createFingerprintAsync} = loadFingerprintModule()
  const fingerprint = await createFingerprintAsync(process.argv[2] ?? '.', {
    silent: true,
  })
  process.stdout.write(JSON.stringify(fingerprint))
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
