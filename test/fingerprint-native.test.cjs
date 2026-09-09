const assert = require('node:assert/strict')
const {execFileSync, spawnSync} = require('node:child_process')
const {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const {tmpdir} = require('node:os')
const {join, resolve} = require('node:path')
const {test} = require('node:test')

function project(t, native = 'current') {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-action-test-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const cwd = join(root, 'project')
  const bin = join(root, 'bin')
  const runtime = join(root, 'runtime')
  for (const path of [cwd, bin, runtime]) mkdirSync(path)
  // Exercise the shipped bundles without access to this repo's node_modules.
  cpSync(resolve('build/fingerprint-native'), join(root, 'action'), {
    recursive: true,
  })
  copyFileSync(resolve('test/fixtures/install.cjs'), join(bin, 'pnpm'))
  chmodSync(join(bin, 'pnpm'), 0o755)
  for (const command of ['npm', 'npx', 'yarn']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nexit 99\n', {mode: 0o755})
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    INSTALL_LOG: join(root, 'installs'),
    RUNNER_TEMP: runtime,
    GITHUB_OUTPUT: join(root, 'outputs'),
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: '',
    GITHUB_REPOSITORY: 'test/fixture',
    'INPUT_BASELINE-FINGERPRINT-PATH': '',
    'INPUT_PREVIOUS-COMMIT-TAG': 'main',
  }
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n')
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({name: 'fixture', packageManager: 'pnpm@11.5.3'}),
  )
  function commit(name, native) {
    writeFileSync(join(cwd, 'fixture.json'), JSON.stringify({native}))
    writeFileSync(join(cwd, 'config-plugin.js'), `module.exports = '${name}'\n`)
    git('add', '.')
    git('commit', '-m', name)
    return git('rev-parse', 'HEAD')
  }
  const baseline = commit('baseline', 'baseline')
  git('checkout', '-b', 'current')
  const current = commit('current', native)
  env.GITHUB_SHA = current

  function fingerprint() {
    const result = spawnSync(
      process.execPath,
      [join(root, 'action/fingerprint.js'), '.'],
      {cwd, env, encoding: 'utf8', timeout: 15000},
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    return JSON.parse(result.stdout)
  }
  function run(profile, extraEnv = {}) {
    writeFileSync(env.GITHUB_OUTPUT, '')
    writeFileSync(env.INSTALL_LOG, '')
    const result = spawnSync(
      process.execPath,
      [join(root, 'action/index.js')],
      {
        cwd,
        env: {...env, INPUT_PROFILE: profile, ...extraEnv},
        encoding: 'utf8',
        timeout: 15000,
      },
    )
    assert.ifError(result.error)
    const outputs = Object.fromEntries(
      [
        ...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(
          /([^\n]+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g,
        ),
      ].map(([, key, , value]) => [key, value]),
    )
    assert.equal(git('rev-parse', 'HEAD'), current)
    assert.equal(result.stderr, '')
    assert.doesNotMatch(result.stdout, /"sources":\[/)
    const artifact = JSON.parse(
      readFileSync(outputs['current-fingerprint-path']),
    )
    assert.equal(
      JSON.parse(artifact.sources.find(s => s.id === 'expoConfig').contents)
        .name,
      'current',
    )
    assert.equal(
      existsSync(join(cwd, 'node_modules/native-fixture')),
      native !== null,
    )
    if (native !== null) {
      assert.equal(
        readFileSync(
          join(cwd, 'node_modules/native-fixture/native.txt'),
          'utf8',
        ),
        native,
      )
    }
    return {
      ...result,
      outputs,
      artifact,
      installs: readFileSync(env.INSTALL_LOG, 'utf8').trim().split('\n'),
    }
  }
  return {cwd, root, env, git, baseline, current, fingerprint, run}
}

test('bundled worker matches Expo, including config and plugin sources', t => {
  const p = project(t)
  execFileSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: p.cwd,
    env: p.env,
  })
  const bundled = p.fingerprint()
  const expected = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `require(process.argv[1]).createFingerprintAsync('.', {silent: true}).then(fp => process.stdout.write(JSON.stringify(fp)))`,
        require.resolve('@expo/fingerprint'),
      ],
      {cwd: p.cwd, env: p.env, encoding: 'utf8'},
    ),
  )
  assert.deepEqual(bundled, expected)
  assert(bundled.sources.some(s => s.reasons.includes('expoConfigPlugins')))
  assert(bundled.sources.some(s => s.reasons.includes('rncoreAutolinkingIos')))
})

for (const [profile, native, status, changed] of [
  ['pull-request', 'current', 0, 'true'],
  ['production', 'baseline', 0, undefined],
  ['production', null, 1, 'true'],
]) {
  test(`${profile}: native=${native}, baseline first, exactly two installs`, t => {
    const p = project(t, native)
    const result = p.run(profile)
    assert.equal(result.status, status, result.stdout)
    assert.equal(result.outputs['includes-changes'], changed)
    assert.deepEqual(result.installs, [p.baseline, p.current])
  })
}

test('testflight without baseline forces native build with one install', t => {
  const p = project(t)
  const result = p.run('testflight')
  assert.equal(result.status, 0, result.stdout)
  assert.equal(result.outputs['includes-changes'], 'true')
  assert.deepEqual(result.installs, [p.current])
})

test('testflight compares a saved baseline without checking it out', t => {
  const p = project(t)
  const first = p.run('testflight')
  const baseline = join(p.root, 'baseline.json')
  writeFileSync(baseline, JSON.stringify(first.artifact))
  p.git('branch', '-D', 'main')
  const result = p.run('testflight', {
    'INPUT_BASELINE-FINGERPRINT-PATH': baseline,
  })
  assert.equal(result.status, 0, result.stdout)
  assert.equal(result.outputs['includes-changes'], undefined)
  assert.deepEqual(result.installs, [p.current])
})

test('failed compilation exits nonzero and preserves existing bundles', t => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-build-test-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  mkdirSync(join(root, 'node_modules/.bin'), {recursive: true})
  mkdirSync(join(root, 'build/fingerprint-native'), {recursive: true})
  writeFileSync(join(root, 'node_modules/.bin/ncc'), '#!/bin/sh\nexit 42\n', {
    mode: 0o755,
  })
  writeFileSync(join(root, 'build/fingerprint-native/index.js'), 'old bundle')
  const result = spawnSync('bash', [resolve('build.sh')], {cwd: root})
  assert.equal(result.status, 42)
  assert.equal(
    readFileSync(join(root, 'build/fingerprint-native/index.js'), 'utf8'),
    'old bundle',
  )
})
