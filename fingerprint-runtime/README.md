# `fingerprint-runtime` action

This action is a thin runner for a consuming repository's canonical runtime calculator. It does not
install dependencies, change the checkout, or use this action repository's version of
`@expo/fingerprint`.

The checkout must already be prepared for the selected native environment. The action runs:

```sh
node scripts/ota/resolve-runtime.mjs \
  --platform ios \
  --profile testflight \
  --source-commit "$SOURCE_COMMIT" \
  --output "$REPORT_PATH"
```

## Inputs

- `platform` (required): `ios` or `android`.
- `profile` (required): `production` or `testflight`.
- `source-commit` (required): the full 40-character commit SHA of the prepared source.
- `working-directory` (optional, default `.`): the prepared project checkout.
- `baseline-report-path` (optional): a prior report to compare with the new report. Relative paths
  are resolved from `working-directory`.

## Outputs

- `report-path`: the validated report. Upload this file with `actions/upload-artifact`; it is the
  authoritative cross-job value.
- `runtime-version`: a convenience output. GitHub may suppress hash-looking outputs, so do not use
  it as the only cross-job handoff.
- `changed`: exactly `true` or `false` when `baseline-report-path` is provided. It is unset when no
  comparison was requested; no baseline is never evidence of compatibility.
- `diff`: a JSON array of added, removed, and changed fingerprint sources when a baseline is
  provided. Source equality uses the complete source identity, not selected change reasons.

The action fails if the calculator fails or returns a malformed, partial, wrong-platform,
wrong-profile, wrong-source, or non-canonical runtime report.
