import {getInput, setFailed, setOutput} from '@actions/core'
import path = require('path')
import {restoreCache} from '@actions/cache'
import {exec, getExecOutput} from '@actions/exec'
import {context} from '@actions/github'
import {diffFingerprints, Fingerprint} from '@expo/fingerprint'
import {promises} from 'fs'

const {readFile, stat} = promises

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

const workingDir = '/home/runner/work/social-app/social-app'
const testflightBuildsDbPath = path.join(
  workingDir,
  'most-recent-testflight-commit.txt',
)
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
  await restoreCache([testflightBuildsDbPath], `most-recent-testflight-commit`)

  // See if the file exists
  try {
    await stat(testflightBuildsDbPath)
  } catch (e) {
    return true
  }

  const commit = await readFile(testflightBuildsDbPath, 'utf8')

  if (commit && commit.trim().length > 0) {
    mostRecentTestflightCommit = commit.trim()
  }

  return true
}

// Step 3
const getCurrentFP = async () => {
  info.currentCommit = currentCommit

  await checkoutCommit(currentCommit)
  await exec('yarn install')
  await exec('yarn add bluesky-social/react-native-bottom-sheet')

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
      const {stdout: lastTag} = await getExecOutput(
        'git describe --tags --abbrev=0',
      )
      const {stdout} = await getExecOutput(`git rev-parse ${lastTag}`)
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

  await checkoutCommit(info.previousCommit)
  await exec('yarn install')

  const {stdout} = await getExecOutput(`npx @expo/fingerprint .`)

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
