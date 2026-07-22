import {restoreCache} from '@actions/cache'
import {getInput, setFailed, setOutput} from '@actions/core'
import {exec, getExecOutput} from '@actions/exec'
import {context} from '@actions/github'
import {diffFingerprints, Fingerprint} from '@expo/fingerprint'
import {createHash} from 'crypto'
import {promises} from 'fs'

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

/*
 * Derive a stable hash over only the native-autolinking-relevant sources of a
 * fingerprint. Two commits with the same native-hash share an identical native
 * surface, so an OTA update between them is safe; a different hash means a
 * rebuild is required.
 *
 * The filePath/id is folded in alongside each source hash so that adding or
 * removing a native module (not just editing one) changes the result. Sorting
 * makes the hash order-independent.
 *
 * Entries are JSON-encoded as [key, hash] tuples rather than joined with
 * delimiters: a source path can itself contain any delimiter char, so a
 * delimiter-joined preimage would not be injective (two different source sets
 * could serialize identically and collide). JSON keeps entry and field
 * boundaries unambiguous, which matters because this hash gates the
 * OTA-vs-native-rebuild decision.
 *
 * This lets a caller persist a single 40-char hash - well under the 48 KB
 * Actions-variable limit that the full ~140 KB fingerprint would blow past - and
 * lets this action skip recomputing the baseline commit's fingerprint entirely.
 */
const nativeHash = (fp: Fingerprint): string => {
  const parts = fp.sources
    .filter(s => s.reasons.some(r => AUTOLINKING_REASONS.includes(r as string)))
    .map(s => [('filePath' in s ? s.filePath : s.id) ?? '', s.hash] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex')
}

const {readFile, stat} = promises

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
/*
 * The native-hash (see nativeHash) of the last commit successfully deployed to
 * testflight, sourced from a repo variable the caller advances after each deploy.
 * When present, the testflight path diffs against this hash directly and skips
 * checking out and reinstalling the baseline commit entirely. Empty on the first
 * run (before the variable is seeded), in which case we fall back to the legacy
 * cache-based baseline commit.
 */
const baselineNativeHash = getInput('baseline-native-hash').trim()
const currentCommit = context.sha

let mostRecentTestflightCommit: string | null = null

const run = async () => {
  const step1 = await addToIgnore()
  const step2 = step1 && (await restoreDb())
  const step3 = step2 && (await getCurrentFP())
  step3 && (await createDiff())

  return true
}

// Step 1
const addToIgnore = async () => {
  await exec('echo "most-recent-testflight-commit.txt" >> .gitignore')
  return true
}

/*
 * Step 2: restore the legacy cache-based baseline commit. Only used as a fallback
 * for the testflight profile when no baseline-native-hash input is provided (e.g.
 * the very first run before the repo variable is seeded). Skipped otherwise.
 */
const restoreDb = async () => {
  if (profile !== 'testflight' || baselineNativeHash) {
    return true
  }

  await restoreCache(
    ['most-recent-testflight-commit.txt'],
    `most-recent-testflight-commit`,
  )

  // See if the file exists
  try {
    await stat('most-recent-testflight-commit.txt')
  } catch (e) {
    return true
  }

  const commit = await readFile('most-recent-testflight-commit.txt', 'utf8')

  if (commit && commit.trim().length > 0) {
    mostRecentTestflightCommit = commit.trim()
  }

  return true
}

// Step 3
const getCurrentFP = async () => {
  info.currentCommit = currentCommit

  await checkoutCommit(currentCommit)
  await exec('rm -rf node_modules')
  const pm = await detectPackageManager()
  await runInstall(pm)

  const {stdout} = await getExecOutput(fingerprintCommand(pm))

  info.currentFingerprint = JSON.parse(stdout.trim())
  return true
}

/*
 * Compute the previous fingerprint by checking out the baseline commit and
 * recomputing it. Used for the pull-request and production profiles, and for
 * testflight only when falling back to the legacy cache baseline (no
 * baseline-native-hash provided).
 */
const getPrevFP = async (): Promise<boolean> => {
  if (profile === 'pull-request') {
    const {stdout} = await getExecOutput('git rev-parse main')

    info.previousCommit = stdout.trim()
  } else if (profile === 'testflight') {
    if (mostRecentTestflightCommit) {
      info.previousCommit = mostRecentTestflightCommit
    } else {
      const {stdout} = await getExecOutput(`git rev-parse @~`)
      info.previousCommit = stdout.trim()
    }
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
  await exec('rm -rf node_modules')
  const pm = await detectPackageManager()
  await runInstall(pm)

  const {stdout} = await getExecOutput(fingerprintCommand(pm))

  info.previousFingerprint = JSON.parse(stdout.trim())
  return true
}

// Step 4
const createDiff = async () => {
  if (!info.currentFingerprint) {
    setFailed('Current fingerprint not found. Aborting.')
    return false
  }

  /*
   * Fast path: when the caller supplies the baseline's native-hash we don't need
   * the previous fingerprint at all - comparing the current commit's native-hash
   * to the stored one tells us whether the native surface changed. This is the
   * whole point of the hash-based baseline: no baseline checkout or reinstall.
   */
  if (profile === 'testflight' && baselineNativeHash) {
    const currentNativeHash = nativeHash(info.currentFingerprint)
    const includesChanges = currentNativeHash !== baselineNativeHash

    console.log(`Baseline native-hash: ${baselineNativeHash}`)
    console.log(`Current native-hash:  ${currentNativeHash}`)

    setOutput('current-native-hash', currentNativeHash)
    if (includesChanges) {
      setOutput('includes-changes', 'true')
    }
    return true
  }

  // Slow path: recompute the baseline fingerprint and produce a full diff.
  if (!(await getPrevFP()) || !info.previousFingerprint) {
    setFailed('Previous fingerprint not found. Aborting.')
    return false
  }

  const diff = diffFingerprints(
    info.currentFingerprint,
    info.previousFingerprint,
  )

  const includesChanges = diff.some(s =>
    s.reasons.some(r => AUTOLINKING_REASONS.includes(r)),
  )

  // Expose the current native-hash so testflight callers can persist it as the
  // new baseline after a successful deploy, even on the legacy fallback path.
  setOutput('current-native-hash', nativeHash(info.currentFingerprint))

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

const checkoutCommit = async (commit: string) => {
  await exec(`git checkout ${commit}`)
}

run()
