const assert = require('node:assert/strict')
const {mkdtempSync, mkdirSync, readFileSync, writeFileSync} = require('node:fs')
const {tmpdir} = require('node:os')
const {join, resolve} = require('node:path')
const {spawnSync} = require('node:child_process')
const test = require('node:test')

const action = resolve('build/fingerprint-runtime/index.js')
const sourceCommit = '1'.repeat(40)
const otherCommit = '2'.repeat(40)
const hash = value => value.repeat(40)

const report = (overrides = {}) => ({
  schemaVersion: 1,
  platform: 'ios',
  nativeProfile: 'testflight',
  sourceCommit,
  runtimeVersion: 'a'.repeat(40),
  fingerprintPolicyVersion: 1,
  fingerprintToolVersion: '0.20.8',
  toolVersions: {
    expo: '54.0.0',
    expoUpdates: '29.0.0',
    node: '24.0.0',
    packageManager: 'pnpm@10.0.0',
  },
  fingerprintSources: [{type: 'contents', id: 'native-policy', hash: hash('c')}],
  ...overrides,
})

const runAction = ({current = report(), baseline, baselineInput, requestedCommit} = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'fingerprint-runtime-test-'))
  const scripts = join(directory, 'scripts', 'ota')
  mkdirSync(scripts, {recursive: true})
  writeFileSync(
    join(scripts, 'resolve-runtime.mjs'),
    `import {copyFileSync} from 'node:fs'
const output = process.argv[process.argv.indexOf('--output') + 1]
copyFileSync(new URL('../../current.json', import.meta.url), output)
`,
  )
  spawnSync('git', ['init', '-q'], {cwd: directory})
  spawnSync('git', ['add', '.'], {cwd: directory})
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], {
    cwd: directory,
  })
  const checkoutCommit = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: directory, encoding: 'utf8'}).stdout.trim()
  if (current.sourceCommit === sourceCommit) current.sourceCommit = checkoutCommit
  writeFileSync(join(directory, 'current.json'), JSON.stringify(current))
  let baselinePath = ''
  if (baseline) {
    baselinePath = join(directory, 'baseline.json')
    writeFileSync(baselinePath, JSON.stringify(baseline))
  }
  if (baselineInput !== undefined) baselinePath = baselineInput
  const outputPath = join(directory, 'github-output')
  writeFileSync(outputPath, '')
  const result = spawnSync(process.execPath, [action], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INPUT_PLATFORM: 'ios',
      INPUT_PROFILE: 'testflight',
      'INPUT_SOURCE-COMMIT': requestedCommit || checkoutCommit,
      'INPUT_WORKING-DIRECTORY': directory,
      'INPUT_BASELINE-REPORT-PATH': baselinePath,
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: outputPath,
    },
  })
  const outputs = result.status === 0 ? readFileSync(outputPath, 'utf8') : ''
  return {...result, outputs}
}

test('returns a report without claiming compatibility when there is no baseline', () => {
  const result = runAction()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.outputs, /report-path/)
  assert.doesNotMatch(result.outputs, /changed/)
})

test('compares complete source hashes and emits an explicit boolean', () => {
  const current = report({
    runtimeVersion: 'b'.repeat(40),
    fingerprintSources: [{type: 'contents', id: 'native-policy', hash: hash('d')}],
  })
  const result = runAction({current, baseline: report({sourceCommit: otherCommit})})
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.outputs, /changed<<ghadelimiter_\S+\ntrue/)
  assert.match(result.outputs, /native-policy/)
  assert.match(result.outputs, /"kind":"changed"/)
})

test('emits false and an empty diff for an identical baseline', () => {
  const result = runAction({baseline: report({sourceCommit: otherCommit})})
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.outputs, /changed<<ghadelimiter_\S+\nfalse/)
  assert.match(result.outputs, /diff<<ghadelimiter_\S+\n\[\]/)
})

test('accepts Expo managed-workflow sources with an intentional null hash', () => {
  const current = report({
    fingerprintSources: [
      {type: 'contents', id: 'native-policy', hash: hash('c')},
      {type: 'dir', filePath: 'ios', hash: null, reasons: ['bareNativeDir']},
    ],
  })
  const result = runAction({current})
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('rejects a partial current report', () => {
  const current = report()
  delete current.toolVersions
  const result = runAction({current})
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /toolVersions is required/)
})

test('rejects a malformed baseline instead of treating it as compatible', () => {
  const baseline = report({platform: 'android', sourceCommit: otherCommit})
  const result = runAction({baseline})
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /platform does not match/)
})

test('resolves a relative baseline path from working-directory', () => {
  const result = runAction({
    baseline: report({sourceCommit: otherCommit}),
    baselineInput: 'baseline.json',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.outputs, /changed<<ghadelimiter_\S+\nfalse/)
})

test('fails when a supplied baseline path is missing', () => {
  const result = runAction({baselineInput: 'missing-report.json'})
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /ENOENT/)
})

test('rejects a source commit that is not the prepared checkout HEAD', () => {
  const result = runAction({requestedCommit: otherCommit})
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /prepared checkout HEAD/)
})

test('rejects a report for a different source commit', () => {
  const result = runAction({current: report({sourceCommit: otherCommit})})
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /sourceCommit does not match/)
})
