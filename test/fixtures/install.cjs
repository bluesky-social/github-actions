#!/usr/bin/env node
// A local package-manager fixture: materialize dependencies without the network.
const assert = require('node:assert/strict')
const {execFileSync} = require('node:child_process')
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} = require('node:fs')
const {dirname} = require('node:path')

assert.deepEqual(process.argv.slice(2), ['install', '--frozen-lockfile'])
assert.equal(existsSync('node_modules'), false, 'install must start clean')
const fixture = require(process.cwd() + '/fixture.json')
appendFileSync(
  process.env.INSTALL_LOG,
  execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}),
)

function write(path, contents) {
  mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, contents)
}

write('node_modules/expo/package.json', '{"name":"expo","version":"55.0.0"}')
write(
  'node_modules/expo/config.js',
  `exports.getConfig = () => ({exp: {name: require('../../config-plugin'), slug: 'fixture'}, pkg: {}})`,
)
write(
  'node_modules/expo-modules-autolinking/package.json',
  '{"name":"expo-modules-autolinking","version":"3.0.0"}',
)
write(
  'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js',
  `const {existsSync} = require('node:fs')
const {join} = require('node:path')
const root = process.cwd()
const nativeRoot = join(root, 'node_modules/native-fixture')
const present = existsSync(nativeRoot)
const config = process.argv[2] === 'resolve'
  ? {modules: present ? [{packageName: 'native-fixture', projects: [{sourceDir: nativeRoot}], pods: [{podspecDir: nativeRoot}]}] : []}
  : {root, dependencies: present ? {'native-fixture': {root: nativeRoot, platforms: {ios: {}, android: {}}}} : {}}
process.stdout.write(JSON.stringify(config))`,
)
if (fixture.native !== null) {
  write('node_modules/native-fixture/native.txt', fixture.native)
}
