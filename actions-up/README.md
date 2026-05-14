# `actions-up` Action

A "Dependabot for GitHub Actions" — runs [`actions-up`](https://github.com/azat-io/actions-up) to bump pinned action versions and opens a PR with the changes. The PR body includes a markdown table of every bumped action.

Designed to be called from a nightly cron workflow in any repo.

## Usage

In the consuming repo, add `.github/workflows/actions-up.yml`:

```yaml
name: actions-up

on:
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: bluesky-social/github-actions/actions-up@main
```

## Inputs

### `token`

Token used to push the branch and open the PR. Defaults to `${{ github.token }}`. Pass a PAT or GitHub App token if you want CI workflows to run on the resulting PR — the default `GITHUB_TOKEN` does not trigger them.

### `branch`

Branch name used for the update PR. Defaults to `ci/actions-up`.

### `commit-message`

Commit message, also used as the PR title. Defaults to `chore: bump pinned GitHub Actions versions`.

### `labels`

Comma-separated labels applied to the PR. Defaults to `dependencies`.

### `node-version`

Node.js version used to run `actions-up`. Defaults to `24`.
