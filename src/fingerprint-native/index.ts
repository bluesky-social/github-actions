import {getInput, setFailed, setOutput} from '@actions/core'
import {exec, getExecOutput} from '@actions/exec'
import {context} from '@actions/github'
import {Fingerprint, FingerprintSource} from '@expo/fingerprint'
import {promises} from 'fs'
import {join} from 'path'

/*
 * Fingerprint sources are flagged with one or more "reasons" describing why they
 * contribute to the fingerprint. Only these three concern native autolinking -
 * the surface that determines whether an OTA update is safe or a native rebuild
 * is required. A change anywhere else (JS, assets) can ship over the air.
 */
const AUTOLINKING_REASONS = [
  'bareRncliAutolinking',
  'expoAutolinkingAndroid',
  'expoAutolinkingIos',
]

const {readFile, rm, stat, writeFile} = promises

type PackageManager = 'yarn' | 'pnpm' | 'npm'

const packageManagerName = (field: unknown): string | undefined => {
  if (typeof field === 'string') return field
  if (Array.isArray(field)) return packageManagerName(field[0])
  if (typeof field === 'object' && field != null) {
    return (field as {name?: string}).name
  }
  return undefined
}

const detectPackageManager = async (): Promise<PackageManager> => {
  try {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    const name =
      packageManagerName(pkg.packageManager) ??
      packageManagerName(pkg.devEngines?.packageManager)
    if (name?.startsWith('pnpm')) return 'pnpm'
    if (name?.startsWith('npm')) return 'npm'
    if (name?.startsWith('yarn')) return 'yarn'
  } catch {
    // fall through
  }
  // Fall back to lockfile presence
  try {
    await stat('pnpm-lock.yaml')
    return 'pnpm'
  } catch {
    // fall through
  }
  try {
    await stat('package-lock.json')
    return 'npm'
  } catch {
    // fall through
  }
  return 'yarn'
}

const runInstall = async (pm: PackageManager) => {
  if (pm === 'pnpm') {
    await exec('npm install -g pnpm@11.5.3') // > 10.21.0 will defer to `packageManager` version.
    await exec('pnpm install --frozen-lockfile')
  } else if (pm === 'npm') {
    await exec('npm ci')
  } else {
    await exec('yarn install --frozen-lockfile')
  }
}

const cleanInstall = async (): Promise<PackageManager> => {
  await rm('node_modules', {recursive: true, force: true})
  const pm = await detectPackageManager()
  await runInstall(pm)
  return pm
}

const fingerprintCommand = (pm: PackageManager): string => {
  if (pm === 'pnpm') return 'pnpm dlx @expo/fingerprint .'
  return 'npx @expo/fingerprint .'
}

type Info = {
  currentCommit?: string
  previousCommit?: string
  currentFingerprint?: Fingerprint
  previousFingerprint?: Fingerprint
}
let info: Info = {
  currentCommit: undefined,
  previousCommit: undefined,
  currentFingerprint: undefined,
  previousFingerprint: undefined,
}

const profile = getInput('profile') as
  | 'production'
  | 'testflight'
  | 'pull-request'
const previousCommitTag = getInput('previous-commit-tag')
const baselineFingerprintPath = getInput('baseline-fingerprint-path').trim()
const currentFingerprintPath = join(
  process.env.RUNNER_TEMP ?? '.',
  'native-fingerprint.json',
)
const currentCommit = context.sha

const run = async () => {
  const hasBaselineFingerprint = await getBaselineFP()
  if (!hasBaselineFingerprint) return false

  const hasCurrentFingerprint = await getCurrentFP()
  hasCurrentFingerprint && (await createDiff())

  return true
}

const getBaselineFP = async (): Promise<boolean> => {
  if (profile !== 'testflight' || !baselineFingerprintPath) return true

  try {
    info.previousFingerprint = JSON.parse(
      await readFile(baselineFingerprintPath, 'utf8'),
    )
  } catch {
    setFailed('Could not read the baseline fingerprint. Aborting.')
    return false
  }

  return true
}

const getCurrentFP = async () => {
  info.currentCommit = currentCommit

  await checkoutCommit(currentCommit)
  const pm = await cleanInstall()

  const {stdout} = await getExecOutput(fingerprintCommand(pm))

  info.currentFingerprint = JSON.parse(stdout.trim())
  await writeFile(
    currentFingerprintPath,
    JSON.stringify(info.currentFingerprint),
    'utf8',
  )
  setOutput('current-fingerprint-path', currentFingerprintPath)
  return true
}

/*
 * Compute the previous fingerprint by checking out the baseline commit and
 * recomputing it. Used for the pull-request and production profiles; testflight
 * reads its deployed baseline directly from an artifact.
 */
const getPrevFP = async (): Promise<boolean> => {
  if (profile === 'pull-request') {
    const {stdout} = await getExecOutput('git rev-parse main')

    info.previousCommit = stdout.trim()
  } else if (profile === 'production') {
    const {stdout, exitCode} = await getExecOutput(
      `git rev-parse ${previousCommitTag}`,
    )

    if (exitCode !== 0) {
      setFailed('Tag not found. Aborting.')
      return false
    }

    info.previousCommit = stdout.trim()
  }

  if (!info.previousCommit) {
    setFailed('Previous commit not found. Aborting.')
    return false
  }
  await checkoutCommit(info.previousCommit)
  /*
   * getCurrentFP already installed the current commit's dependencies into
   * node_modules, and `git checkout` leaves that (gitignored) directory in
   * place. Remove it before reinstalling so the baseline fingerprint is
   * computed against the baseline's dependency tree, not a mix - a stale
   * native module left behind could otherwise hide a real native change.
   */
  const pm = await cleanInstall()

  const {stdout} = await getExecOutput(fingerprintCommand(pm))

  info.previousFingerprint = JSON.parse(stdout.trim())

  /*
   * getPrevFP checks out and installs the baseline commit's dependency tree to
   * fingerprint it. Restore the current commit and its deps before returning so
   * any consumer step running after this action (e.g. the bundle export) operates
   * on context.sha, not the baseline commit.
   */
  await checkoutCommit(currentCommit)
  await cleanInstall()
  return true
}

// Step 4
const createDiff = async () => {
  if (!info.currentFingerprint) {
    setFailed('Current fingerprint not found. Aborting.')
    return false
  }

  /*
   * Without a known deployed baseline, an OTA update cannot be proven safe.
   * Force native builds; their successful completion will seed the artifact.
   */
  if (profile === 'testflight' && !baselineFingerprintPath) {
    setOutput('includes-changes', 'true')
    return true
  }

  if (
    !info.previousFingerprint &&
    (!(await getPrevFP()) || !info.previousFingerprint)
  ) {
    setFailed('Previous fingerprint not found. Aborting.')
    return false
  }

  const changedSources = (before: Fingerprint, after: Fingerprint) =>
    after.sources.filter(afterSource => {
      const beforeSource = before.sources.find(
        source =>
          source.type === afterSource.type &&
          sourceId(source) === sourceId(afterSource),
      )
      return !beforeSource || beforeSource.hash !== afterSource.hash
    })

  const diff = [
    ...changedSources(info.previousFingerprint, info.currentFingerprint),
    ...changedSources(info.currentFingerprint, info.previousFingerprint),
  ]

  const includesChanges = diff.some(s =>
    s.reasons.some(r => AUTOLINKING_REASONS.includes(r)),
  )

  if (includesChanges) {
    setOutput('diff', diff)
    setOutput('includes-changes', 'true')

    if (profile === 'production') {
      setFailed('Fingerprint changes detected. Aborting.')
    }
  }
  return true
}

// -- Helpers

const sourceId = (source: FingerprintSource): string =>
  source.type === 'contents' ? source.id : source.filePath

const checkoutCommit = async (commit: string) => {
  await exec(`git checkout ${commit}`)
}

run()
