#!/usr/bin/env bash

set -euo pipefail

: "${GH_TOKEN:?github-token is required to check the pull request head}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SERVER_URL:?GITHUB_SERVER_URL is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${ROAST_RUN_ID:?ROAST_RUN_ID is required}"
: "${ROAST_RECORD_DIR:?ROAST_RECORD_DIR is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

for command in gh git; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to prepare the Roast review comment" >&2
    exit 1
  fi
done

if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "pr-number must be numeric" >&2
  exit 1
fi

reviewed_head="$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD)"
current_head="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq '.head.sha')"
if [[ "$reviewed_head" != "$current_head" ]]; then
  echo "Refusing to publish stale Roast result for $reviewed_head; PR head is $current_head" >&2
  exit 1
fi

report_file="$ROAST_RECORD_DIR/runs/$ROAST_RUN_ID/report.md"
body_file="$RUNNER_TEMP/roast-comment.md"
visible_report="$RUNNER_TEMP/roast-visible-report.md"

if [[ ! -s "$report_file" ]]; then
  echo "Roast's durable report is missing: $report_file" >&2
  exit 1
fi

# GitHub caps issue comments at 65,536 characters. Keep whole lines from the
# severity-sorted report and leave room for the sticky marker, footer, and UTF-8.
LC_ALL=C awk '
  /^## Dropped findings \(--show-dropped\)/ { exit }
  {
    bytes += length($0) + 1
    if (bytes > 48000) {
      print ""
      print "_Report truncated to fit in a GitHub comment. Download the Roast run artifact for the complete report._"
      exit
    }
    print
  }
' "$report_file" >"$visible_report"

{
  cat "$visible_report"
  echo
  echo "---"
  echo "Roast run \`$ROAST_RUN_ID\` · ${ROAST_VERSION:-unknown version} · [workflow run](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID})"
} >"$body_file"
