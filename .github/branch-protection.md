# Branch Protection

Recommended GitHub repository settings for `main`:

1. Require pull request before merging.
2. Require branches to be up to date before merging.
3. Require status checks to pass before merging.
4. Select required status check: `verify`.
5. Restrict direct pushes to `main` if desired.

## Workflow Mapping

1. Workflow file: `.github/workflows/ci.yml`
2. Job name: `verify`
3. Working directory: `agent`
4. Purpose: typecheck, lint, format, tests, coverage, build, smoke install

## Release Expectations

1. Preview publish waits for successful `CI` workflow completion on `main` push.
2. Stable publish waits for successful `verify` run on tagged commit without rerunning CI.
3. `release-please` manages changelog and release PRs from conventional commits.
4. If `release-please` cannot open PRs with `github.token`, set repo action permission to allow pull request creation or define `RELEASE_PLEASE_TOKEN` secret with repo-scoped PAT.
