import {promises} from 'node:fs'
import {isAbsolute, join, resolve} from 'node:path'

import {getInput, setFailed, setOutput} from '@actions/core'
import {exec, getExecOutput} from '@actions/exec'

const {mkdir, readFile} = promises

type Platform = 'ios' | 'android'
type Profile = 'production' | 'testflight'

type FingerprintSource = Record<string, unknown> & {hash: string | null}

type RuntimeReport = {
  schemaVersion: 1
  platform: Platform
  nativeProfile: Profile
  sourceCommit: string
  runtimeVersion: string
  fingerprintPolicyVersion: 1
  fingerprintToolVersion: string
  toolVersions: {
    expo: string
    expoUpdates: string
    node: string
    packageManager: string
  }
  fingerprintSources: FingerprintSource[]
}

const SHA = /^[0-9a-f]{40}$/
const RUNTIME = /^[0-9a-f]{40}$/

const assertChoice = <T extends string>(
  value: string,
  name: string,
  choices: readonly T[],
): T => {
  if (!choices.includes(value as T)) {
    throw new Error(`${name} must be one of: ${choices.join(', ')}`)
  }
  return value as T
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

const sourceIdentity = (source: FingerprintSource): string => {
  const identity = {...source}
  delete identity.hash
  if (Object.keys(identity).length === 0) throw new Error('Fingerprint source has no identity fields')
  return JSON.stringify(canonicalize(identity))
}

const validateReport = (
  value: unknown,
  expected: {platform: Platform; profile: Profile; sourceCommit?: string},
): RuntimeReport => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runtime report must be a JSON object')
  }
  const report = value as Partial<RuntimeReport>
  if (report.schemaVersion !== 1) throw new Error('Unsupported runtime report schemaVersion')
  if (report.platform !== expected.platform) throw new Error('Runtime report platform does not match the requested platform')
  if (report.nativeProfile !== expected.profile) throw new Error('Runtime report nativeProfile does not match the requested profile')
  if (expected.sourceCommit && report.sourceCommit !== expected.sourceCommit) {
    throw new Error('Runtime report sourceCommit does not match the requested source commit')
  }
  if (typeof report.sourceCommit !== 'string' || !SHA.test(report.sourceCommit)) {
    throw new Error('Runtime report sourceCommit must be a lowercase 40-character SHA')
  }
  if (typeof report.runtimeVersion !== 'string' || !RUNTIME.test(report.runtimeVersion)) {
    throw new Error('Runtime report runtimeVersion must be a lowercase 40-character fingerprint')
  }
  if (report.fingerprintPolicyVersion !== 1) throw new Error('Unsupported fingerprintPolicyVersion')
  if (typeof report.fingerprintToolVersion !== 'string' || report.fingerprintToolVersion.trim() === '') {
    throw new Error('Runtime report fingerprintToolVersion is required')
  }
  if (!report.toolVersions || typeof report.toolVersions !== 'object') throw new Error('Runtime report toolVersions is required')
  for (const key of ['expo', 'expoUpdates', 'node', 'packageManager'] as const) {
    if (typeof report.toolVersions[key] !== 'string' || report.toolVersions[key].trim() === '') {
      throw new Error(`Runtime report toolVersions.${key} is required`)
    }
  }
  if (!Array.isArray(report.fingerprintSources) || report.fingerprintSources.length === 0) {
    throw new Error('Runtime report fingerprintSources must be a non-empty array')
  }
  const identities = new Set<string>()
  for (const source of report.fingerprintSources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid fingerprint source')
    if (!Object.prototype.hasOwnProperty.call(source, 'hash')) {
      throw new Error('Fingerprint source hash is required')
    }
    if (source.hash !== null && (typeof source.hash !== 'string' || !RUNTIME.test(source.hash))) {
      throw new Error('Fingerprint source hash must be null or a lowercase 40-character SHA-1')
    }
    const identity = sourceIdentity(source)
    if (identities.has(identity)) throw new Error(`Duplicate fingerprint source identity: ${identity}`)
    identities.add(identity)
  }
  return report as RuntimeReport
}

const compareSources = (baseline: RuntimeReport, current: RuntimeReport) => {
  const before = new Map(baseline.fingerprintSources.map(source => [sourceIdentity(source), source]))
  const after = new Map(current.fingerprintSources.map(source => [sourceIdentity(source), source]))
  const identities = Array.from(
    new Set([...Array.from(before.keys()), ...Array.from(after.keys())]),
  ).sort()
  const diff: Array<{
    kind: 'added' | 'removed' | 'changed'
    identity: unknown
    before?: FingerprintSource
    after?: FingerprintSource
  }> = []
  for (const identity of identities) {
    const previous = before.get(identity)
    const next = after.get(identity)
    if (!previous) diff.push({kind: 'added', identity: JSON.parse(identity), after: next})
    else if (!next) diff.push({kind: 'removed', identity: JSON.parse(identity), before: previous})
    else if (previous.hash !== next.hash) {
      diff.push({kind: 'changed', identity: JSON.parse(identity), before: previous, after: next})
    }
  }
  return diff
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))

const run = async () => {
  const platform = assertChoice(getInput('platform', {required: true}), 'platform', ['ios', 'android'] as const)
  const profile = assertChoice(getInput('profile', {required: true}), 'profile', ['production', 'testflight'] as const)
  const sourceCommit = getInput('source-commit', {required: true})
  if (!SHA.test(sourceCommit)) throw new Error('source-commit must be a lowercase 40-character SHA')

  const workingDirectory = resolve(getInput('working-directory') || '.')
  const head = await getExecOutput('git', ['rev-parse', 'HEAD'], {
    cwd: workingDirectory,
    silent: true,
  })
  if (head.exitCode !== 0 || head.stdout.trim() !== sourceCommit) {
    throw new Error('source-commit does not match the prepared checkout HEAD')
  }
  const reportDirectory = join(process.env.RUNNER_TEMP || workingDirectory, 'fingerprint-runtime')
  const reportPath = join(reportDirectory, `${platform}-${profile}-${sourceCommit}.json`)
  await mkdir(reportDirectory, {recursive: true})

  const exitCode = await exec(
    'node',
    [
      'scripts/ota/resolve-runtime.mjs',
      '--platform', platform,
      '--profile', profile,
      '--source-commit', sourceCommit,
      '--output', reportPath,
    ],
    {cwd: workingDirectory},
  )
  if (exitCode !== 0) throw new Error(`Canonical runtime calculator exited with status ${exitCode}`)

  const report = validateReport(await readJson(reportPath), {platform, profile, sourceCommit})
  setOutput('report-path', reportPath)
  setOutput('runtime-version', report.runtimeVersion)

  const baselineInput = getInput('baseline-report-path').trim()
  if (baselineInput) {
    const baselinePath = isAbsolute(baselineInput) ? baselineInput : join(workingDirectory, baselineInput)
    const baseline = validateReport(await readJson(baselinePath), {platform, profile})
    const diff = compareSources(baseline, report)
    const changed = baseline.runtimeVersion !== report.runtimeVersion
    if (!changed && diff.length > 0) throw new Error('Source diff is non-empty although runtimeVersion is unchanged')
    if (changed && diff.length === 0) throw new Error('runtimeVersion changed without a fingerprint source diff')
    setOutput('changed', String(changed))
    setOutput('diff', JSON.stringify(diff))
  }
}

run().catch(error => setFailed(error instanceof Error ? error.message : String(error)))
