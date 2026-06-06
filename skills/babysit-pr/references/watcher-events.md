# Watcher Event Contract

`gh_pr_watch.py` is agent-first. Stdout contains one JSON object for normal `--watch`, `--once`, and `--retry-failed-now` calls. Stderr is for script/GitHub errors.

## `--watch`

Blocks silently until one of these happens:

- terminal state: `ready`, `closed`, `blocked`
- actionable state: `review_feedback`, `ci_failed`
- useful progress: `sha_changed`, `mergeability_changed`, `ci_green`
- heartbeat: `heartbeat` after `--max-wait-seconds`

Then it emits one compact JSON object and exits `0`.

## Cursor

Every event includes opaque `cursor`. Pass it to the next watcher command:

```bash
python3 <skill-dir>/scripts/gh_pr_watch.py --pr auto --watch --cursor '<cursor>'
```

The cursor replaces external state files. It remembers review watermarks, latest SHA/check summary, already-emitted CI failure/green events, and flaky retry counts.

## Common Fields

```json
{
  "event": "ci_failed",
  "terminal": false,
  "reason": "failed_checks_present",
  "actions": ["diagnose_ci_failure", "retry_failed_checks"],
  "pr": {
    "repo": "owner/repo",
    "number": 123,
    "url": "https://github.com/owner/repo/pull/123",
    "head_sha": "abc123",
    "head_branch": "feature",
    "state": "OPEN",
    "merged": false,
    "closed": false,
    "mergeable": "MERGEABLE",
    "merge_state_status": "CLEAN",
    "review_decision": "REVIEW_REQUIRED"
  },
  "checks": {
    "passed": 12,
    "failed": 1,
    "pending": 3,
    "all_terminal": false
  },
  "failed_checks": [
    { "name": "test", "workflow": "CI", "state": "FAILURE", "link": "https://github.com/..." }
  ],
  "failed_runs": [
    { "run_id": 123, "workflow_name": "CI", "status": "completed", "conclusion": "failure", "html_url": "https://github.com/..." }
  ],
  "review_items": [],
  "retry": { "used": 0, "max": 3 },
  "cursor": "opaque",
  "next_poll_seconds": 30
}
```

`review_items[].body` is truncated at 3000 chars. Use `url` to fetch full context when `body_truncated` is true.

## Retry Result

```bash
python3 <skill-dir>/scripts/gh_pr_watch.py --pr auto --retry-failed-now --cursor '<cursor>'
```

Emits:

```json
{
  "event": "retry_result",
  "rerun_attempted": true,
  "rerun_count": 1,
  "rerun_run_ids": [123],
  "reason": "rerun_triggered",
  "cursor": "opaque"
}
```

Always continue with returned cursor after retry.

## Debug Stream

`--stream` emits compact JSONL snapshots repeatedly. Use only for local debugging; agents should prefer `--watch`.
