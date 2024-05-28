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
    console.log('No previous TestFlight build found.')
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

  console.log('Checking out current commit.')
  await exec(`git checkout ${currentCommit}`)

  console.log('Creating the current fingerprint.')
  console.log('Installing dependencies...')
  await exec('yarn install')

  const {stdout} = await getExecOutput(`npx @expo/fingerprint .`)
  info.currentFingerprint = JSON.parse(stdout.trim())
  return true
}

// Step 4
const getPrevFP = async () => {
  if (profile === 'pull-request') {
    console.log('Pull request. Using main branch as previous commit.')
    const {stdout} = await getExecOutput('git rev-parse main')
    info.previousCommit = stdout.trim()
  } else if (profile === 'testflight') {
    if (mostRecentTestflightCommit) {
      console.log(
        'TestFlight. Using most recent TestFlight build as previous commit.',
      )
      info.previousCommit = mostRecentTestflightCommit
    } else {
      console.log(
        'TestFlight. No previous TestFlight build found, using main branch as previous commit.',
      )
      const {stdout} = await getExecOutput('git rev-parse main')
      info.previousCommit = stdout.trim()
    }
  } else if (profile === 'production') {
    console.log('Production build. Using tag as previous commit.')
    const {stdout, exitCode} = await getExecOutput(
      `git rev-parse ${getInput('previous-commit-tag')}`,
    )
    if (exitCode !== 0) {
      setFailed('Tag not found. Aborting.')
      return false
    }
    info.previousCommit = stdout.trim()
  }

  console.log('Checking out previous commit.')
  await checkoutCommit(info.previousCommit)

  console.log('Installing dependencies...')
  await exec('yarn install')

  console.log('Creating the previous fingerprint.')

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
    console.log('Changes detected.')
    setOutput('diff', diff)
    setOutput('includes-changes', includesChanges ? 'true' : 'false')
  } else {
    console.log('No changes detected.')
  }
  return true
}

// -- Helpers

const checkoutCommit = async (commit: string) => {
  await exec(`git checkout ${commit}`)
}

run()
