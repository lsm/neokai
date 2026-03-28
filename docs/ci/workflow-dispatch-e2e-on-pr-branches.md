# CI Improvement: workflow_dispatch E2E on PR Branches

**Status:** Verified — no CI changes needed

## Findings

The CI workflow (`.github/workflows/main.yml`) already supports triggering E2E tests on PR branches via `workflow_dispatch`.

## Usage

```bash
gh workflow run main.yml --repo lsm/neokai --ref <pr-branch-name> --field run_e2e_only=true
```

Or in the GitHub Actions UI: select `main.yml`, choose "Run workflow", pick the PR branch, and set `run_e2e_only` to `true`.

## How it works

| Input `run_e2e_only` | Behavior |
|----------------------|----------|
| `false` (default)    | Runs check + unit + online tests (skips E2E) |
| `true`               | Skips all prerequisite jobs, runs only discover + build + E2E |

When `run_e2e_only=true`, these jobs are skipped:
- `check` (lint, knip, format, typecheck)
- `test-daemon-online`
- `test-daemon-shared-unit`
- `test-web`
- `test-cli`
- `coverage-gate`

Only `discover`, `build`, and E2E jobs execute — saving time and CI resources.

## Verification

Tested on PR #1144 (`task/neo-chat-e2e-test-verify-messages-render-as-readab`):
- Run ID: 23688882223
- All E2E jobs (both `e2e-no-llm` and `e2e-llm`) executed successfully
- Prerequisite jobs correctly skipped
- No CI YAML changes required

## Recommendation

No changes needed. The CI is already correctly configured. The team can use `workflow_dispatch` to run E2E on any PR branch before merging.
