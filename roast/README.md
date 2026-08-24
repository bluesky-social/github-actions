# Roast pull request review

Runs the private [`bluesky-social/roast`](https://github.com/bluesky-social/roast)
CLI against a pull request, publishes one update-in-place PR comment, and uploads
the complete run record as a workflow artifact.

The action downloads a pinned release directly, caches the release archive by
tag/OS/architecture, and verifies it against the release's `checksums.txt` on
every run (including cache hits). It intentionally does not run `brew install`:
the Homebrew cask always resolves to the newest release, so a workflow pinned to
an action commit could otherwise change reviewer versions without a code change.

## Usage

```yaml
name: roast-review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    # Keep gateway credentials away from fork-authored code, drafts, and bots.
    if: >
      github.event.pull_request.draft == false &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.event.pull_request.user.type != 'Bot'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      group: roast-review-${{ github.repository }}-${{ github.event.pull_request.number }}
      cancel-in-progress: true

    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 1

      - uses: bluesky-social/github-actions/roast@main
        with:
          api-key: ${{ secrets.ROAST_API_KEY }}
          release-app-id: ${{ secrets.ROAST_RELEASE_APP_ID }}
          release-app-private-key: ${{ secrets.ROAST_RELEASE_APP_PRIVATE_KEY }}
```

`ROAST_RELEASE_APP_ID` and `ROAST_RELEASE_APP_PRIVATE_KEY` identify a GitHub
App installed on the private `bluesky-social/roast` repository with
`contents: read`. The action mints a short-lived token scoped only to that
repository. `ROAST_API_KEY` is the full `email:key` AI Gateway credential.

The checkout is intentionally pinned to the PR head SHA. The action fetches the
head and base ancestry when needed, asserts that they have a merge base, and
passes the base SHA explicitly to Roast. Starting from a shallow checkout keeps
the initial checkout quick without sacrificing the eventual review scope.

## Inputs

- `release-tag`: Roast version to install. Defaults to `v1.0.11`.
- `task`: description of the intended change. Defaults to the PR title.
- `comment`: set to `false` to run without publishing a PR comment.
- `fail-on-severity`: optionally fail the job for findings at or above `INFO`,
  `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`. By default, findings are review
  feedback and do not fail the job.
- `base-sha` and `pr-number`: override the pull request event values when using
  another event.
- `github-token`: token used for the PR comment. Defaults to `github.token`.
- `artifact-retention-days`: retention for the complete run record. Defaults to
  14 days.

An empty diff, an incomplete/cut-off review, invalid output, authentication
failure, or a stale Roast binary fails the action. Findings only fail it when
`fail-on-severity` is configured.
