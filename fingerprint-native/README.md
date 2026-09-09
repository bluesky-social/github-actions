# `fingerprint-native` Action

This action uses `@expo/fingerprint` to generate a fingerprint of native changes between a current
branch and a target branch. It is similar to Expo's existing fingerprint action
(see [Expo's actions repository](https://github.com/expo/expo-github-action)), however it does not
cache previous fingerprints. We have experience some issues with the caching approach, as our caches
are often invalidated (because of Docker build caches), leading to many unnecessary rebuilds of
TestFlight/internal clients.

## Prerequisites

Check out the repository and set up Node and its package manager before running
this action (for example, with `pnpm/action-setup` and `actions/setup-node`). The
action uses the package manager on `PATH`; it does not install one globally.
When comparing two commits, the configured package managers must support both
commits' dependency installs, including any version switching specified by the
project.

For `production` and `pull-request`, the action installs and fingerprints the
baseline first, then the current commit. It finishes with the current commit and
its dependencies ready for subsequent steps. `testflight` installs only the
current commit and compares against the supplied fingerprint artifact.

## Inputs

### `profile`

**Required** The name of the profile to use for the fingerprinting. Valid options are:

- `production` - Uses the supplied git tag to compare the current commit against
- `testflight` - Uses the cached "last testflight commit" to compare the current commit against
- `pull-request` - Uses the base branch of the pull request to compare the current commit against

### `previous-commit-tag`

**Required when using `production` profile**. This should be the tag of the previous commit to compare
against. If it is not supplied - or it is not a valid tag - the action will fail when using `production`
profile.

### `working-directory`

This value is automatically set by the action and should not be set manually.

## Updating the `testflight` commit cache

Once a new TestFlight client has been successfully built by GitHub, you should update the cache
with the commit hash the build was based on.
