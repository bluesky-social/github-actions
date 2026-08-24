#!/usr/bin/env bash

set -euo pipefail

: "${ROAST_API_KEY:?ROAST_API_KEY is required}"
: "${ROAST_BASE_SHA:?base-sha is required outside a pull_request event}"
: "${ROAST_RECORD_DIR:?ROAST_RECORD_DIR is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

for command in git jq roast; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to run Roast" >&2
    exit 1
  fi
done

if [[ ! "$ROAST_BASE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "base-sha must be a full 40-character commit SHA" >&2
  exit 1
fi

if [[ -n "${ROAST_FAIL_ON_SEVERITY:-}" ]] &&
  [[ ! "$ROAST_FAIL_ON_SEVERITY" =~ ^(INFO|LOW|MEDIUM|HIGH|CRITICAL)$ ]]; then
  echo "fail-on-severity must be INFO, LOW, MEDIUM, HIGH, CRITICAL, or empty" >&2
  exit 1
fi

git rev-parse --is-inside-work-tree >/dev/null
head_sha="$(git rev-parse HEAD)"
if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  # Roast uses a three-dot diff only when git can find a merge base. Fetch
  # both histories so it cannot silently fall back to a two-endpoint diff.
  git fetch --no-tags --unshallow origin "$ROAST_BASE_SHA" "$head_sha"
elif ! git cat-file -e "${ROAST_BASE_SHA}^{commit}" 2>/dev/null; then
  git fetch --no-tags origin "$ROAST_BASE_SHA"
fi
git merge-base "$ROAST_BASE_SHA" HEAD >/dev/null || {
  echo "base-sha and HEAD have no merge base" >&2
  exit 1
}

mkdir -p "$ROAST_RECORD_DIR"
stdout_file="$ROAST_RECORD_DIR/stdout.json"
stderr_file="$ROAST_RECORD_DIR/stderr.log"

task="${ROAST_TASK:-Review the pull request changes}"
args=(review --base "$ROAST_BASE_SHA" --task "$task" --format both)
if [[ -n "${ROAST_FAIL_ON_SEVERITY:-}" ]]; then
  args+=(--max-severity "$ROAST_FAIL_ON_SEVERITY")
fi

set +e
roast "${args[@]}" >"$stdout_file" 2>"$stderr_file"
roast_status=$?
set -e

cat "$stderr_file" >&2

run_id=""
assessment=""
findings_count="0"
outcome="failure"

if [[ -s "$stdout_file" ]] && jq -e '
  type == "object" and
  (.assessment | type == "string" and IN("NO_FINDINGS", "FINDINGS_PRESENT", "NO_DIFF", "INCOMPLETE_NO_SUBMISSION")) and
  (.findings | type == "array") and
  ((.incomplete // false) | type == "boolean") and
  (
    if .assessment == "FINDINGS_PRESENT" then
      (.findings | length) > 0
    else
      (.findings | length) == 0
    end
  ) and
  (
    if .assessment == "NO_DIFF" then
      ((.run_id // "") | type == "string")
    else
      (.run_id | type == "string" and length > 0)
    end
  )
' "$stdout_file" >/dev/null; then
  run_id="$(jq -r '.run_id // ""' "$stdout_file")"
  assessment="$(jq -r '.assessment' "$stdout_file")"
  findings_count="$(jq -r '.findings | length' "$stdout_file")"
  incomplete="$(jq -r '(.incomplete // false) or (.assessment == "INCOMPLETE_NO_SUBMISSION")' "$stdout_file")"

  if [[ "$assessment" == "NO_DIFF" ]]; then
    outcome="no-diff"
  elif [[ "$incomplete" == "true" ]]; then
    outcome="incomplete"
  elif [[ "$roast_status" -eq 1 && -n "${ROAST_FAIL_ON_SEVERITY:-}" ]]; then
    outcome="gate-failed"
  elif [[ "$roast_status" -ne 0 ]]; then
    outcome="failure"
  elif [[ "$findings_count" -gt 0 ]]; then
    outcome="findings"
  else
    outcome="clean"
  fi
fi

{
  echo "run-id=$run_id"
  echo "assessment=$assessment"
  echo "findings-count=$findings_count"
  echo "outcome=$outcome"
  echo "exit-code=$roast_status"
} >>"$GITHUB_OUTPUT"

if [[ "$outcome" == "failure" ]]; then
  echo "Roast exited with status $roast_status and did not produce a valid completed review." >&2
fi
