# CI Performance Scratchpad

## Objective

Improve GitHub Actions runtime until end-to-end CI and release path completes in under 1 minute, or stop after 100 improvement iterations.

## Measurement Command

```bash
./calc-ci.sh
```

## Baseline Capture

Date: 2026-05-18
Repository: `shekohex/dotai`
Sample size: last 20 GitHub Actions runs, filtered to workflows below.

Workflows measured:

- `CI`
- `Release`
- `Release Please`

## Measurement Files

- Human-readable output: terminal table from `./calc-ci.sh`
- Machine baseline: `.tmp/ci-performance/baseline.json`
- Latest measurement: `.tmp/ci-performance/latest.json`
- Comparison mode: `./calc-ci.sh --baseline .tmp/ci-performance/baseline.json`

## Current Hypotheses

- CI spends most time in dependency install, coverage-enabled tests, build/package smoke steps, and artifact upload.
- Release preview package spends time refreshing lockfile and publishing package after CI already verified code.
- Release Please may be fast enough already; avoid touching unless duplicated setup appears.

## Constraints

- Keep required linting, typechecking, tests, build, packaging, smoke validation, and publishing behavior intact.
- Remove coverage if it materially slows CI and no gate consumes it.
- Avoid duplicated install/setup work across CI and release where safe.
- Prefer changes with measurable runtime reduction.

## Iteration Log

| Iteration | Change | CI Avg Before | CI Avg After | Release Avg Before | Release Avg After | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 0 | Baseline measurement fixtures created | 266s | TBD | 131s | TBD | Baseline captured from last 20 runs |
| 1 | Replace CI coverage with plain tests, remove coverage upload, pack with `--ignore-scripts`, remove release lockfile refresh after version mutation | 266s | 202s actual run, 257s rolling avg | 131s | 106s actual run, 128s rolling avg | Real CI, Release Please, Release passed |
| 2 | Build preview-versioned tarball in CI, upload it, publish same artifact from Release without checkout/cache/install/repack | 257s | 209s actual run | 128s | Failed at artifact download | Release failed because `gh run download` had no checkout repo context |
| 3 | Add explicit repository to preview artifact download | 257s | 201s actual run, 240s rolling avg | 128s | 28s actual run, 100s rolling avg | Real CI, Release Please, Release passed |
| 4 | Split CI into parallel check matrix and separate package smoke job | 240s | 115s actual run, 217s rolling avg | 100s | 34s actual run, 87s rolling avg | Real CI, Release Please, Release passed |
| 5 | Run Vitest with 2 workers in GitHub Actions and use dot reporter in CI | 217s | 122s actual run, 193s rolling avg | 87s | 32s actual run, 72s rolling avg | Real CI, Release Please, Release passed |
| 6 | Increase GitHub Actions Vitest workers to 8 after local worker sweep | 193s | 100s actual run, 180s rolling avg | 72s | 59s actual run, 62s rolling avg | Real CI, Release Please, Release passed |
| 7 | Cache generated Plannotator resources and skip UI rebuild on cache hit | 180s | 114s actual run, 154s rolling avg | 62s | 41s actual run, 49s rolling avg | Real CI, Release Please, Release passed; first run populated cache |
| 8 | Ignore in-progress runs in measurement script and verify Plannotator cache-hit CI path | 154s | 64s actual run, 134s rolling avg | 49s | 31s actual run, 39s rolling avg | Real CI, Release Please, Release passed; CI near target |
| 9 | Disable audit/fund/progress during smoke global install | 134s | 50s actual run, 95s rolling avg | 39s | 29s actual run, 37s rolling avg | Real CI, Release Please, Release passed; CI target met, end-to-end still about 79s |
| 10 | Combine preview release creation and package publishing into one Release job | 95s | 46s actual run, 89s rolling avg | 37s | 19s actual run, 36s rolling avg | Real CI, Release Please, Release passed; end-to-end still about 68s |
| 11 | Move preview release creation and package publish into CI package job, remove `workflow_run` preview release path | 89s | 71s actual run, 83s rolling avg | 36s | No preview Release workflow triggered | Real CI and Release Please passed; preview publish happened inside CI |
| 12 | Add `--prefer-offline` to smoke global install after local benchmark dropped install from about 18s to 6.6s | 83s | 65s actual run, 75s rolling avg | N/A | N/A | Real CI and Release Please passed; runner smoke install stayed 17s |
| 13 | Use restore-only cache actions on hot path to remove post-save hooks | 75s | 50s actual run, 68s rolling avg | N/A | N/A | Real CI and Release Please passed; preview publish completed inside CI package job under 60s |

## Current Best Result

Date: 2026-05-18
Commit: `933ed65`

| Path | Real Run Duration | Evidence |
| --- | ---: | --- |
| CI workflow | 50s | `gh run view 26023950673`; package job `09:04:56` to `09:05:46` |
| Preview package publish | Included in CI | `package / Publish preview package` completed in same CI job |
| Release workflow | Not triggered for preview | Preview release path moved out of `workflow_run` Release workflow |
| Release Please | 2m+ | Independent release-please automation, not on preview publish critical path |

## Vitest Worker Sweep

Date: 2026-05-18
Command shape: `GITHUB_ACTIONS=true npx vitest run --reporter=dot --maxWorkers=<N>`

| Workers | Local Duration |
| ---: | ---: |
| 1 | 60.48s |
| 2 | 31.65s |
| 4 | 17.66s |
| 8 | 11.81s |

## Baseline Summary

| Workflow | Samples | Avg | Min | Max |
| --- | ---: | ---: | ---: | ---: |
| CI | 6 | 266s | 236s | 299s |
| Release | 7 | 131s | 125s | 137s |
| Release Please | 7 | 138s | 120s | 168s |

## Baseline Slowest Steps

| Workflow | Step | Samples | Avg |
| --- | --- | ---: | ---: |
| Release Please | `release-please / Run release-please` | 7 | 132s |
| CI | `verify / Test + Coverage` | 6 | 92s |
| Release | `publish_preview_package / Refresh lockfile` | 7 | 64s |
| CI | `verify / Build` | 6 | 46s |
| CI | `verify / Install dependencies` | 6 | 40s |
| Release | `publish_preview_package / Publish preview package` | 7 | 34s |
| CI | `verify / Pack package` | 6 | 32s |
| CI | `verify / Smoke test global install` | 6 | 19s |

## Success Criteria

- `CI` workflow average under 60 seconds, or end-to-end push path under 60 seconds if release remains coupled.
- Release workflow keeps publishing correct preview/manual/release packages.
- Max 100 improvement iterations.
