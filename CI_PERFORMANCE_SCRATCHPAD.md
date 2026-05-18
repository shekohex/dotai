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
| 3 | Add explicit repository to preview artifact download | 257s | Pending CI run | 128s | Pending release run | Local verification pending |

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
