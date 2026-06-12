import {restoreCache} from '@actions/cache'
import {getInput, setFailed, setOutput} from '@actions/core'
import {exec, getExecOutput} from '@actions/exec'
import {context} from '@actions/github'
import {diffFingerprints, Fingerprint} from '@expo/fingerprint'
import {promises} from 'fs'

const {readFile, stat} = promises

type PackageManager = 'yarn' | 'pnpm' | 'npm'

const packageManagerName = (field: unknown): string | undefined => {
  if (typeof field === 'string') return field
  if (Array.isArray(field)) return packageManagerName(field[0])
  if (typeof field === 'object' && field !== null) {
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
    await exec('npm install -g pnpm@11.5.3') // > 10.21.0 will defer to `packageMananger` version.
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
const currentCommit = context.sha

let mostRecentTestflightCommit: string | null = null

const run = async () => {
  // Try to restore the DB first
  const step1 = await addToIgnore()
  const step2 = step1 && (await restoreDb())
  const step3 = step2 && (await getPrevFP())
  const step4 = step3 && (await getCurrentFP())
  step4 && (await createDiff())

  return true
}

// Step 1
const addToIgnore = async () => {
  await exec('echo "most-recent-testflight-commit.txt" >> .gitignore')
  return true
}

// Step 2
const restoreDb = async () => {
  const restoreRes = await restoreCache(
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

  const {stdout} = await getExecOutput(`npx @expo/fingerprint .`)

  info.currentFingerprint = JSON.parse(stdout.trim())
  return true
}

// Step 4
const getPrevFP = async () => {
  if (profile === 'pull-request') {
    const {stdout} = await getExecOutput('git rev-parse main')

    info.previousCommit = stdout.trim()
  } else if (profile === 'testflight') {
    if (mostRecentTestflightCommit) {
      info.previousCommit = mostRecentTestflightCommit
    } else {
      // const {stdout: lastTag} = await getExecOutput(
      //   'git describe --tags --abbrev=0',
      // )
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
  const pm = await detectPackageManager()
  await runInstall(pm)

  const {stdout} = await getExecOutput(fingerprintCommand(pm))

  info.previousFingerprint = JSON.parse(stdout.trim())
  return true
}

// Step 5
const createDiff = async () => {
  if (!info.currentFingerprint || !info.previousFingerprint) {
    setFailed('Fingerprints not found. Aborting.')
    return false
  }

  const diff = diffFingerprints(
    info.currentFingerprint,
    info.previousFingerprint,
  )

  const hasBareRncliAutolinking = diff.some(s =>
    s.reasons.includes('bareRncliAutolinking'),
  )
  const hasExpoAutolinkingAndroid = diff.some(s =>
    s.reasons.includes('expoAutolinkingAndroid'),
  )
  const hasExpoAutolinkingIos = diff.some(s =>
    s.reasons.includes('expoAutolinkingIos'),
  )

  const includesChanges =
    hasBareRncliAutolinking ||
    hasExpoAutolinkingAndroid ||
    hasExpoAutolinkingIos

  if (includesChanges) {
    setOutput('diff', diff)
    setOutput('includes-changes', includesChanges ? 'true' : 'false')

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
