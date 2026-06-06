#!/usr/bin/env python3
"""Watch GitHub PR CI and review activity for AI Agent PR babysitting workflows."""

import argparse
import base64
import binascii
import hashlib
import json
import re
import subprocess
import sys
import time
import zlib
from urllib.parse import urlparse

FAILED_RUN_CONCLUSIONS = {
    "failure",
    "timed_out",
    "cancelled",
    "action_required",
    "startup_failure",
    "stale",
}
PENDING_CHECK_STATES = {
    "QUEUED",
    "IN_PROGRESS",
    "PENDING",
    "WAITING",
    "REQUESTED",
}
REVIEW_BOT_LOGIN_KEYWORDS = {
    "codex",
    "claude",
    "opencode",
}
TRUSTED_AUTHOR_ASSOCIATIONS = {
    "OWNER",
    "MEMBER",
    "COLLABORATOR",
}
MERGE_BLOCKING_REVIEW_DECISIONS = {
    "REVIEW_REQUIRED",
    "CHANGES_REQUESTED",
}
MERGE_CONFLICT_OR_BLOCKING_STATES = {
    "BLOCKED",
    "DIRTY",
    "DRAFT",
    "UNKNOWN",
}
GREEN_STATE_MAX_POLL_SECONDS = 60 * 60
COMMENT_BODY_MAX_CHARS = 3000
CURSOR_VERSION = 1


class GhCommandError(RuntimeError):
    pass


def parse_args():
    parser = argparse.ArgumentParser(
        description=(
            "Normalize PR/CI/review state for AI PR babysitting and optionally "
            "trigger flaky reruns."
        )
    )
    parser.add_argument("--pr", default="auto", help="auto, PR number, or PR URL")
    parser.add_argument("--repo", help="Optional OWNER/REPO override")
    parser.add_argument("--poll-seconds", type=int, default=30, help="Watch poll interval")
    parser.add_argument(
        "--max-wait-seconds",
        type=int,
        default=15 * 60,
        help="Emit a heartbeat event after this many seconds without actionable changes",
    )
    parser.add_argument(
        "--max-flaky-retries",
        type=int,
        default=3,
        help="Max rerun cycles per head SHA before stop recommendation",
    )
    parser.add_argument(
        "--cursor",
        help="Opaque cursor returned by a previous watcher event; avoids external state files",
    )
    parser.add_argument("--once", action="store_true", help="Emit one compact snapshot and exit")
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Block silently until a compact actionable/terminal/heartbeat event, then exit",
    )
    parser.add_argument(
        "--stream",
        action="store_true",
        help="Debug mode: continuously emit compact JSONL snapshots",
    )
    parser.add_argument(
        "--retry-failed-now",
        action="store_true",
        help="Rerun failed jobs for current failed workflow runs when policy allows",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Compatibility no-op; output is always JSON",
    )
    args = parser.parse_args()

    if args.poll_seconds <= 0:
        parser.error("--poll-seconds must be > 0")
    if args.max_wait_seconds <= 0:
        parser.error("--max-wait-seconds must be > 0")
    if args.max_flaky_retries < 0:
        parser.error("--max-flaky-retries must be >= 0")
    if args.watch and args.retry_failed_now:
        parser.error("--watch cannot be combined with --retry-failed-now")
    if args.stream and args.retry_failed_now:
        parser.error("--stream cannot be combined with --retry-failed-now")
    if args.watch and args.stream:
        parser.error("--watch cannot be combined with --stream")
    if not args.once and not args.watch and not args.stream and not args.retry_failed_now:
        args.once = True
    return args


def _format_gh_error(cmd, err):
    stdout = (err.stdout or "").strip()
    stderr = (err.stderr or "").strip()
    parts = [f"GitHub CLI command failed: {' '.join(cmd)}"]
    if stdout:
        parts.append(f"stdout: {stdout}")
    if stderr:
        parts.append(f"stderr: {stderr}")
    return "\n".join(parts)


def gh_text(args, repo=None):
    cmd = ["gh"]
    # `gh api` does not accept `-R/--repo` on all gh versions. The watcher's
    # API calls use explicit endpoints (e.g. repos/{owner}/{repo}/...), so the
    # repo flag is unnecessary there.
    if repo and (not args or args[0] != "api"):
        cmd.extend(["-R", repo])
    cmd.extend(args)
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except FileNotFoundError as err:
        raise GhCommandError("`gh` command not found") from err
    except subprocess.CalledProcessError as err:
        raise GhCommandError(_format_gh_error(cmd, err)) from err
    return proc.stdout


def gh_json(args, repo=None):
    raw = gh_text(args, repo=repo).strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        raise GhCommandError(f"Failed to parse JSON from gh output for {' '.join(args)}") from err


def parse_pr_spec(pr_spec):
    if pr_spec == "auto":
        return {"mode": "auto", "value": None}
    if re.fullmatch(r"\d+", pr_spec):
        return {"mode": "number", "value": pr_spec}
    parsed = urlparse(pr_spec)
    if parsed.scheme and parsed.netloc and "/pull/" in parsed.path:
        return {"mode": "url", "value": pr_spec}
    raise ValueError("--pr must be 'auto', a PR number, or a PR URL")


def pr_view_fields():
    return (
        "number,url,state,mergedAt,closedAt,headRefName,headRefOid,"
        "headRepository,headRepositoryOwner,mergeable,mergeStateStatus,reviewDecision"
    )


def checks_fields():
    return "name,state,bucket,link,workflow,event,startedAt,completedAt"


def resolve_pr(pr_spec, repo_override=None):
    parsed = parse_pr_spec(pr_spec)
    cmd = ["pr", "view"]
    if parsed["value"] is not None:
        cmd.append(parsed["value"])
    cmd.extend(["--json", pr_view_fields()])
    data = gh_json(cmd, repo=repo_override)
    if not isinstance(data, dict):
        raise GhCommandError("Unexpected PR payload from `gh pr view`")

    pr_url = str(data.get("url") or "")
    repo = (
        repo_override
        or extract_repo_from_pr_url(pr_url)
        or extract_repo_from_pr_view(data)
    )
    if not repo:
        raise GhCommandError("Unable to determine OWNER/REPO for the PR")

    state = str(data.get("state") or "")
    merged = bool(data.get("mergedAt"))
    closed = bool(data.get("closedAt")) or state.upper() == "CLOSED"

    return {
        "number": int(data["number"]),
        "url": pr_url,
        "repo": repo,
        "head_sha": str(data.get("headRefOid") or ""),
        "head_branch": str(data.get("headRefName") or ""),
        "state": state,
        "merged": merged,
        "closed": closed,
        "mergeable": str(data.get("mergeable") or ""),
        "merge_state_status": str(data.get("mergeStateStatus") or ""),
        "review_decision": str(data.get("reviewDecision") or ""),
    }


def extract_repo_from_pr_view(data):
    head_repo = data.get("headRepository")
    head_owner = data.get("headRepositoryOwner")
    owner = None
    name = None
    if isinstance(head_owner, dict):
        owner = head_owner.get("login") or head_owner.get("name")
    elif isinstance(head_owner, str):
        owner = head_owner
    if isinstance(head_repo, dict):
        name = head_repo.get("name")
        repo_owner = head_repo.get("owner")
        if not owner and isinstance(repo_owner, dict):
            owner = repo_owner.get("login") or repo_owner.get("name")
    elif isinstance(head_repo, str):
        name = head_repo
    if owner and name:
        return f"{owner}/{name}"
    return None


def extract_repo_from_pr_url(pr_url):
    parsed = urlparse(pr_url)
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) >= 4 and parts[2] == "pull":
        return f"{parts[0]}/{parts[1]}"
    return None


def default_cursor_state():
    return {
        "version": CURSOR_VERSION,
        "started_at": None,
        "last_seen_head_sha": None,
        "last_checks_key": None,
        "last_mergeability_key": None,
        "last_ci_failed_event_key": None,
        "last_green_head_sha": None,
        "retries_by_sha": {},
        "review_watermarks": {},
    }


def normalize_cursor_state(value):
    state = default_cursor_state()
    if not isinstance(value, dict):
        return state

    state["started_at"] = value.get("started_at")
    state["last_seen_head_sha"] = value.get("last_seen_head_sha")
    state["last_checks_key"] = value.get("last_checks_key")
    state["last_mergeability_key"] = value.get("last_mergeability_key")
    state["last_ci_failed_event_key"] = value.get("last_ci_failed_event_key") or value.get(
        "last_emitted_event_key"
    )
    state["last_green_head_sha"] = value.get("last_green_head_sha")
    state["retries_by_sha"] = normalize_retries_by_sha(value.get("retries_by_sha"))
    state["review_watermarks"] = normalize_review_watermarks(value.get("review_watermarks"))
    return state


def normalize_retries_by_sha(value):
    if not isinstance(value, dict):
        return {}
    retries = {}
    for key, raw_count in value.items():
        try:
            retries[str(key)] = max(0, int(raw_count))
        except (TypeError, ValueError):
            continue
    return retries


def normalize_review_watermarks(value):
    if not isinstance(value, dict):
        return {}
    watermarks = {}
    for kind in ("issue_comment", "review_comment", "review"):
        raw_watermark = value.get(kind)
        if not isinstance(raw_watermark, dict):
            continue
        watermarks[kind] = {
            "created_at": str(raw_watermark.get("created_at") or ""),
            "id": str(raw_watermark.get("id") or ""),
        }
    return watermarks


def decode_cursor(cursor):
    if not cursor:
        return default_cursor_state()
    try:
        padding = "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode((cursor + padding).encode("ascii"))
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            pass
        payload = json.loads(raw.decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeError, zlib.error) as err:
        raise ValueError("--cursor is not a valid babysit-pr cursor") from err
    if not isinstance(payload, dict) or payload.get("version") != CURSOR_VERSION:
        raise ValueError("--cursor has an unsupported babysit-pr cursor version")
    return normalize_cursor_state(payload)


def encode_cursor(state):
    payload = normalize_cursor_state(state)
    payload["version"] = CURSOR_VERSION
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    compressed = zlib.compress(raw, level=9)
    return base64.urlsafe_b64encode(compressed).decode("ascii").rstrip("=")


def get_pr_checks(pr_spec, repo):
    parsed = parse_pr_spec(pr_spec)
    cmd = ["pr", "checks"]
    if parsed["value"] is not None:
        cmd.append(parsed["value"])
    cmd.extend(["--json", checks_fields()])
    data = gh_json(cmd, repo=repo)
    if data is None:
        return []
    if not isinstance(data, list):
        raise GhCommandError("Unexpected payload from `gh pr checks`")
    return data


def is_pending_check(check):
    bucket = str(check.get("bucket") or "").lower()
    state = str(check.get("state") or "").upper()
    return bucket == "pending" or state in PENDING_CHECK_STATES


def summarize_checks(checks):
    pending_count = 0
    failed_count = 0
    passed_count = 0
    for check in checks:
        bucket = str(check.get("bucket") or "").lower()
        if is_pending_check(check):
            pending_count += 1
        if bucket == "fail":
            failed_count += 1
        if bucket == "pass":
            passed_count += 1
    return {
        "pending_count": pending_count,
        "failed_count": failed_count,
        "passed_count": passed_count,
        "all_terminal": pending_count == 0,
    }


def failed_checks_from_checks(checks):
    failed_checks = []
    for check in checks:
        if str(check.get("bucket") or "").lower() != "fail":
            continue
        failed_checks.append(
            {
                "name": str(check.get("name") or ""),
                "workflow": str(check.get("workflow") or ""),
                "state": str(check.get("state") or ""),
                "link": str(check.get("link") or ""),
            }
        )
    failed_checks.sort(key=lambda item: (item["workflow"], item["name"], item["link"]))
    return failed_checks


def get_workflow_runs_for_sha(repo, head_sha):
    endpoint = f"repos/{repo}/actions/runs"
    data = gh_json(
        ["api", endpoint, "-X", "GET", "-f", f"head_sha={head_sha}", "-f", "per_page=100"],
        repo=repo,
    )
    if not isinstance(data, dict):
        raise GhCommandError("Unexpected payload from actions runs API")
    runs = data.get("workflow_runs") or []
    if not isinstance(runs, list):
        raise GhCommandError("Expected `workflow_runs` to be a list")
    return runs


def failed_runs_from_workflow_runs(runs, head_sha):
    failed_runs = []
    for run in runs:
        if not isinstance(run, dict):
            continue
        if str(run.get("head_sha") or "") != head_sha:
            continue
        conclusion = str(run.get("conclusion") or "")
        if conclusion not in FAILED_RUN_CONCLUSIONS:
            continue
        failed_runs.append(
            {
                "run_id": run.get("id"),
                "workflow_name": run.get("name") or run.get("display_title") or "",
                "status": str(run.get("status") or ""),
                "conclusion": conclusion,
                "html_url": str(run.get("html_url") or ""),
            }
        )
    failed_runs.sort(key=lambda item: (str(item.get("workflow_name") or ""), str(item.get("run_id") or "")))
    return failed_runs


def get_authenticated_login():
    data = gh_json(["api", "user"])
    if not isinstance(data, dict) or not data.get("login"):
        raise GhCommandError("Unable to determine authenticated GitHub login from `gh api user`")
    return str(data["login"])


def comment_endpoints(repo, pr_number):
    return {
        "issue_comment": f"repos/{repo}/issues/{pr_number}/comments",
        "review_comment": f"repos/{repo}/pulls/{pr_number}/comments",
        "review": f"repos/{repo}/pulls/{pr_number}/reviews",
    }


def gh_api_list_paginated(endpoint, repo=None, per_page=100):
    items = []
    page = 1
    while True:
        sep = "&" if "?" in endpoint else "?"
        page_endpoint = f"{endpoint}{sep}per_page={per_page}&page={page}"
        payload = gh_json(["api", page_endpoint], repo=repo)
        if payload is None:
            break
        if not isinstance(payload, list):
            raise GhCommandError(f"Unexpected paginated payload from gh api {endpoint}")
        items.extend(payload)
        if len(payload) < per_page:
            break
        page += 1
    return items


def normalize_issue_comments(items):
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "kind": "issue_comment",
                "id": str(item.get("id") or ""),
                "author": extract_login(item.get("user")),
                "author_association": str(item.get("author_association") or ""),
                "created_at": str(item.get("created_at") or ""),
                "body": str(item.get("body") or ""),
                "path": None,
                "line": None,
                "url": str(item.get("html_url") or ""),
            }
        )
    return out


def normalize_review_comments(items):
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        line = item.get("line")
        if line is None:
            line = item.get("original_line")
        out.append(
            {
                "kind": "review_comment",
                "id": str(item.get("id") or ""),
                "author": extract_login(item.get("user")),
                "author_association": str(item.get("author_association") or ""),
                "created_at": str(item.get("created_at") or ""),
                "body": str(item.get("body") or ""),
                "path": item.get("path"),
                "line": line,
                "url": str(item.get("html_url") or ""),
            }
        )
    return out


def normalize_reviews(items):
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "kind": "review",
                "id": str(item.get("id") or ""),
                "author": extract_login(item.get("user")),
                "author_association": str(item.get("author_association") or ""),
                "created_at": str(item.get("submitted_at") or item.get("created_at") or ""),
                "body": str(item.get("body") or ""),
                "path": None,
                "line": None,
                "url": str(item.get("html_url") or ""),
            }
        )
    return out


def extract_login(user_obj):
    if isinstance(user_obj, dict):
        return str(user_obj.get("login") or "")
    return ""


def is_bot_login(login):
    return bool(login) and login.endswith("[bot]")


def is_actionable_review_bot_login(login):
    if not is_bot_login(login):
        return False
    lower_login = login.lower()
    return any(keyword in lower_login for keyword in REVIEW_BOT_LOGIN_KEYWORDS)


def is_trusted_human_review_author(item, authenticated_login):
    author = str(item.get("author") or "")
    if not author:
        return False
    if authenticated_login and author == authenticated_login:
        return True
    association = str(item.get("author_association") or "").upper()
    return association in TRUSTED_AUTHOR_ASSOCIATIONS


def numeric_id(value):
    text = str(value or "")
    if text.isdigit():
        return int(text)
    return 0


def review_item_position(item):
    return (str(item.get("created_at") or ""), numeric_id(item.get("id")))


def watermark_position(watermark):
    if not isinstance(watermark, dict):
        return ("", 0)
    return (str(watermark.get("created_at") or ""), numeric_id(watermark.get("id")))


def update_review_watermark(watermarks, item):
    kind = str(item.get("kind") or "")
    if not kind:
        return
    if review_item_position(item) <= watermark_position(watermarks.get(kind)):
        return
    watermarks[kind] = {
        "created_at": str(item.get("created_at") or ""),
        "id": str(item.get("id") or ""),
    }


def fetch_new_review_items(pr, state, authenticated_login=None):
    repo = pr["repo"]
    pr_number = pr["number"]
    endpoints = comment_endpoints(repo, pr_number)

    issue_payload = gh_api_list_paginated(endpoints["issue_comment"], repo=repo)
    review_comment_payload = gh_api_list_paginated(endpoints["review_comment"], repo=repo)
    review_payload = gh_api_list_paginated(endpoints["review"], repo=repo)

    issue_items = normalize_issue_comments(issue_payload)
    review_comment_items = normalize_review_comments(review_comment_payload)
    review_items = normalize_reviews(review_payload)
    all_items = issue_items + review_comment_items + review_items

    watermarks = normalize_review_watermarks(state.get("review_watermarks"))

    # With no cursor, surface existing trusted review activity once. Subsequent
    # polls/restarts suppress these IDs via the opaque cursor.

    new_items = []
    for item in all_items:
        item_id = item.get("id")
        if not item_id:
            continue
        author = item.get("author") or ""
        if not author:
            continue
        if is_bot_login(author):
            if not is_actionable_review_bot_login(author):
                continue
        elif not is_trusted_human_review_author(item, authenticated_login):
            continue

        kind = item["kind"]
        if review_item_position(item) <= watermark_position(watermarks.get(kind)):
            continue

        new_items.append(item)
        update_review_watermark(watermarks, item)

    new_items.sort(key=lambda item: (item.get("created_at") or "", item.get("kind") or "", item.get("id") or ""))
    state["review_watermarks"] = watermarks
    return new_items


def current_retry_count(state, head_sha):
    retries = state.get("retries_by_sha") or {}
    value = retries.get(head_sha, 0)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def set_retry_count(state, head_sha, count):
    retries = state.get("retries_by_sha")
    if not isinstance(retries, dict):
        retries = {}
    retries[head_sha] = int(count)
    state["retries_by_sha"] = retries


def unique_actions(actions):
    out = []
    seen = set()
    for action in actions:
        if action not in seen:
            out.append(action)
            seen.add(action)
    return out


def is_pr_ready_to_merge(pr, checks_summary, new_review_items):
    if pr["closed"] or pr["merged"]:
        return False
    if not checks_summary["all_terminal"]:
        return False
    if checks_summary["failed_count"] > 0 or checks_summary["pending_count"] > 0:
        return False
    if new_review_items:
        return False
    if str(pr.get("mergeable") or "") != "MERGEABLE":
        return False
    if str(pr.get("merge_state_status") or "") in MERGE_CONFLICT_OR_BLOCKING_STATES:
        return False
    if str(pr.get("review_decision") or "") in MERGE_BLOCKING_REVIEW_DECISIONS:
        return False
    return True


def recommend_actions(pr, checks_summary, failed_runs, new_review_items, retries_used, max_retries):
    actions = []
    if pr["closed"] or pr["merged"]:
        if new_review_items:
            actions.append("process_review_comment")
        actions.append("stop_pr_closed")
        return unique_actions(actions)

    if is_pr_ready_to_merge(pr, checks_summary, new_review_items):
        actions.append("stop_ready_to_merge")
        return unique_actions(actions)

    if new_review_items:
        actions.append("process_review_comment")

    has_failed_pr_checks = checks_summary["failed_count"] > 0
    if has_failed_pr_checks:
        if checks_summary["all_terminal"] and retries_used >= max_retries:
            actions.append("stop_exhausted_retries")
        else:
            actions.append("diagnose_ci_failure")
            if checks_summary["all_terminal"] and failed_runs and retries_used < max_retries:
                actions.append("retry_failed_checks")

    if not actions:
        actions.append("idle")
    return unique_actions(actions)


def collect_snapshot(args, state):
    pr = resolve_pr(args.pr, repo_override=args.repo)

    if not state.get("started_at"):
        state["started_at"] = int(time.time())

    # `gh pr checks -R <repo>` requires an explicit PR/branch/url argument.
    # After resolving `--pr auto`, reuse the concrete PR number.
    checks = get_pr_checks(str(pr["number"]), repo=pr["repo"])
    checks_summary = summarize_checks(checks)
    workflow_runs = get_workflow_runs_for_sha(pr["repo"], pr["head_sha"])
    failed_runs = failed_runs_from_workflow_runs(workflow_runs, pr["head_sha"])
    authenticated_login = get_authenticated_login()
    new_review_items = fetch_new_review_items(
        pr,
        state,
        authenticated_login=authenticated_login,
    )

    retries_used = current_retry_count(state, pr["head_sha"])
    actions = recommend_actions(
        pr,
        checks_summary,
        failed_runs,
        new_review_items,
        retries_used,
        args.max_flaky_retries,
    )

    snapshot = {
        "pr": pr,
        "checks": checks_summary,
        "failed_checks": failed_checks_from_checks(checks),
        "failed_runs": failed_runs,
        "new_review_items": new_review_items,
        "actions": actions,
        "retry_state": {
            "current_sha_retries_used": retries_used,
            "max_flaky_retries": args.max_flaky_retries,
        },
    }
    return snapshot


def retry_failed_now(args):
    state = decode_cursor(args.cursor)
    snapshot = collect_snapshot(args, state)
    pr = snapshot["pr"]
    checks_summary = snapshot["checks"]
    failed_runs = snapshot["failed_runs"]
    retries_used = snapshot["retry_state"]["current_sha_retries_used"]
    max_retries = snapshot["retry_state"]["max_flaky_retries"]

    result = {
        "event": "retry_result",
        "terminal": False,
        "actions": snapshot.get("actions") or [],
        "pr": compact_pr(pr),
        "checks": compact_checks(checks_summary),
        "failed_checks": snapshot.get("failed_checks") or [],
        "failed_runs": failed_runs,
        "retry": compact_retry(snapshot),
        "rerun_attempted": False,
        "rerun_count": 0,
        "rerun_run_ids": [],
        "reason": None,
    }

    if pr["closed"] or pr["merged"]:
        result["reason"] = "pr_closed"
        return finalize_retry_result(result, state, snapshot)
    if checks_summary["failed_count"] <= 0:
        result["reason"] = "no_failed_pr_checks"
        return finalize_retry_result(result, state, snapshot)
    if not failed_runs:
        result["reason"] = "no_failed_runs"
        return finalize_retry_result(result, state, snapshot)
    if not checks_summary["all_terminal"]:
        result["reason"] = "checks_still_pending"
        return finalize_retry_result(result, state, snapshot)
    if retries_used >= max_retries:
        result["reason"] = "retry_budget_exhausted"
        return finalize_retry_result(result, state, snapshot)

    for run in failed_runs:
        run_id = run.get("run_id")
        if run_id in (None, ""):
            continue
        gh_text(["run", "rerun", str(run_id), "--failed"], repo=pr["repo"])
        result["rerun_run_ids"].append(run_id)

    if result["rerun_run_ids"]:
        new_count = current_retry_count(state, pr["head_sha"]) + 1
        set_retry_count(state, pr["head_sha"], new_count)
        result["rerun_attempted"] = True
        result["rerun_count"] = len(result["rerun_run_ids"])
        result["reason"] = "rerun_triggered"
        snapshot["retry_state"]["current_sha_retries_used"] = new_count
        result["retry"] = compact_retry(snapshot)
    else:
        result["reason"] = "failed_runs_missing_ids"

    return finalize_retry_result(result, state, snapshot)


def finalize_retry_result(result, state, snapshot):
    update_cursor_after_snapshot(state, snapshot)
    result["cursor"] = encode_cursor(state)
    return result


def print_json(obj):
    sys.stdout.write(json.dumps(obj, sort_keys=True) + "\n")
    sys.stdout.flush()


def print_event(event, payload):
    print_json({"event": event, "payload": payload})


def truncate_text(value, max_chars=COMMENT_BODY_MAX_CHARS):
    text = str(value or "")
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars], True


def compact_review_items(items):
    compact_items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        body, truncated = truncate_text(item.get("body"))
        compact_items.append(
            {
                "kind": str(item.get("kind") or ""),
                "id": str(item.get("id") or ""),
                "author": str(item.get("author") or ""),
                "created_at": str(item.get("created_at") or ""),
                "path": item.get("path"),
                "line": item.get("line"),
                "url": str(item.get("url") or ""),
                "body": body,
                "body_truncated": truncated,
            }
        )
    return compact_items


def compact_pr(pr):
    return {
        "repo": pr.get("repo"),
        "number": pr.get("number"),
        "url": pr.get("url"),
        "head_sha": pr.get("head_sha"),
        "head_branch": pr.get("head_branch"),
        "state": pr.get("state"),
        "merged": pr.get("merged"),
        "closed": pr.get("closed"),
        "mergeable": pr.get("mergeable"),
        "merge_state_status": pr.get("merge_state_status"),
        "review_decision": pr.get("review_decision"),
    }


def compact_checks(checks):
    return {
        "passed": int(checks.get("passed_count") or 0),
        "failed": int(checks.get("failed_count") or 0),
        "pending": int(checks.get("pending_count") or 0),
        "all_terminal": bool(checks.get("all_terminal")),
    }


def compact_retry(snapshot):
    retry_state = snapshot.get("retry_state") or {}
    return {
        "used": int(retry_state.get("current_sha_retries_used") or 0),
        "max": int(retry_state.get("max_flaky_retries") or 0),
    }


def checks_key(snapshot):
    checks = snapshot.get("checks") or {}
    return [
        int(checks.get("passed_count") or 0),
        int(checks.get("failed_count") or 0),
        int(checks.get("pending_count") or 0),
        bool(checks.get("all_terminal")),
    ]


def mergeability_key(snapshot):
    pr = snapshot.get("pr") or {}
    return [
        str(pr.get("mergeable") or ""),
        str(pr.get("merge_state_status") or ""),
        str(pr.get("review_decision") or ""),
    ]


def event_key(event_type, snapshot):
    raw_key = json.dumps(
        [event_type, snapshot_change_key(snapshot), compact_retry(snapshot)],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:16]


def base_compact_event(event_type, snapshot, reason, terminal=False):
    return {
        "event": event_type,
        "terminal": terminal,
        "reason": reason,
        "actions": snapshot.get("actions") or [],
        "pr": compact_pr(snapshot.get("pr") or {}),
        "checks": compact_checks(snapshot.get("checks") or {}),
        "failed_checks": snapshot.get("failed_checks") or [],
        "failed_runs": snapshot.get("failed_runs") or [],
        "review_items": compact_review_items(snapshot.get("new_review_items") or []),
        "retry": compact_retry(snapshot),
    }


def mark_emitted(state, event_type, snapshot):
    if event_type == "ci_failed":
        state["last_ci_failed_event_key"] = event_key(event_type, snapshot)
    if event_type == "ci_green":
        pr = snapshot.get("pr") or {}
        state["last_green_head_sha"] = pr.get("head_sha")


def update_cursor_after_snapshot(state, snapshot):
    pr = snapshot.get("pr") or {}
    state["last_seen_head_sha"] = pr.get("head_sha")
    state["last_checks_key"] = checks_key(snapshot)
    state["last_mergeability_key"] = mergeability_key(snapshot)


def build_compact_event(event_type, snapshot, reason, state, terminal=False):
    event = base_compact_event(event_type, snapshot, reason, terminal=terminal)
    mark_emitted(state, event_type, snapshot)
    update_cursor_after_snapshot(state, snapshot)
    event["cursor"] = encode_cursor(state)
    return event


def already_emitted(state, event_type, snapshot):
    if event_type == "ci_failed":
        return state.get("last_ci_failed_event_key") == event_key(event_type, snapshot)
    return False


def choose_watch_event(args, snapshot, state, elapsed_seconds):
    actions = set(snapshot.get("actions") or [])
    pr = snapshot.get("pr") or {}
    current_checks_key = checks_key(snapshot)
    current_mergeability_key = mergeability_key(snapshot)
    previous_head_sha = state.get("last_seen_head_sha")
    current_head_sha = pr.get("head_sha")

    if "stop_pr_closed" in actions:
        return build_compact_event("closed", snapshot, "pr_closed_or_merged", state, terminal=True)
    if "stop_ready_to_merge" in actions:
        return build_compact_event("ready", snapshot, "ready_to_merge", state, terminal=True)
    if "stop_exhausted_retries" in actions:
        return build_compact_event("blocked", snapshot, "retry_budget_exhausted", state, terminal=True)

    if snapshot.get("new_review_items"):
        return build_compact_event("review_feedback", snapshot, "trusted_review_activity", state)

    if "diagnose_ci_failure" in actions and not already_emitted(state, "ci_failed", snapshot):
        return build_compact_event("ci_failed", snapshot, "failed_checks_present", state)

    if previous_head_sha and current_head_sha and previous_head_sha != current_head_sha:
        return build_compact_event("sha_changed", snapshot, "head_sha_changed", state)

    if state.get("last_mergeability_key") is not None and state.get("last_mergeability_key") != current_mergeability_key:
        return build_compact_event("mergeability_changed", snapshot, "mergeability_or_review_decision_changed", state)

    if is_ci_green(snapshot) and state.get("last_green_head_sha") != current_head_sha:
        return build_compact_event("ci_green", snapshot, "ci_green_for_head_sha", state)

    if elapsed_seconds >= args.max_wait_seconds:
        return build_compact_event("heartbeat", snapshot, "max_wait_elapsed_without_actionable_change", state)

    state["last_checks_key"] = current_checks_key
    state["last_mergeability_key"] = current_mergeability_key
    state["last_seen_head_sha"] = current_head_sha
    return None


def is_ci_green(snapshot):
    checks = snapshot.get("checks") or {}
    return (
        bool(checks.get("all_terminal"))
        and int(checks.get("failed_count") or 0) == 0
        and int(checks.get("pending_count") or 0) == 0
    )


def snapshot_change_key(snapshot):
    pr = snapshot.get("pr") or {}
    checks = snapshot.get("checks") or {}
    review_items = snapshot.get("new_review_items") or []
    return (
        str(pr.get("head_sha") or ""),
        str(pr.get("state") or ""),
        str(pr.get("mergeable") or ""),
        str(pr.get("merge_state_status") or ""),
        str(pr.get("review_decision") or ""),
        int(checks.get("passed_count") or 0),
        int(checks.get("failed_count") or 0),
        int(checks.get("pending_count") or 0),
        tuple(
            (str(item.get("kind") or ""), str(item.get("id") or ""))
            for item in review_items
            if isinstance(item, dict)
        ),
        tuple(snapshot.get("actions") or []),
    )


def run_watch(args):
    state = decode_cursor(args.cursor)
    poll_seconds = args.poll_seconds
    started_at = time.time()
    while True:
        snapshot = collect_snapshot(args, state)
        event = choose_watch_event(args, snapshot, state, time.time() - started_at)
        if event:
            event["next_poll_seconds"] = poll_seconds
            print_json(event)
            return 0

        current_change_key = snapshot_change_key(snapshot)
        changed = current_change_key != state.get("last_snapshot_change_key")
        green = is_ci_green(snapshot)

        if not green:
            poll_seconds = args.poll_seconds
        elif changed or state.get("last_snapshot_change_key") is None:
            poll_seconds = args.poll_seconds
        else:
            poll_seconds = min(poll_seconds * 2, GREEN_STATE_MAX_POLL_SECONDS)

        state["last_snapshot_change_key"] = current_change_key
        time.sleep(poll_seconds)


def run_stream(args):
    state = decode_cursor(args.cursor)
    poll_seconds = args.poll_seconds
    while True:
        snapshot = collect_snapshot(args, state)
        event = base_compact_event("snapshot", snapshot, "debug_stream_snapshot")
        update_cursor_after_snapshot(state, snapshot)
        event["cursor"] = encode_cursor(state)
        event["next_poll_seconds"] = poll_seconds
        print_json(event)

        if is_ci_green(snapshot):
            poll_seconds = min(poll_seconds * 2, GREEN_STATE_MAX_POLL_SECONDS)
        else:
            poll_seconds = args.poll_seconds
        time.sleep(poll_seconds)


def run_once(args):
    state = decode_cursor(args.cursor)
    snapshot = collect_snapshot(args, state)
    event = choose_watch_event(args, snapshot, state, elapsed_seconds=0)
    if event is None:
        event = build_compact_event("snapshot", snapshot, "one_shot_snapshot", state)
    print_json(event)
    return 0


def main():
    args = parse_args()
    try:
        if args.retry_failed_now:
            print_json(retry_failed_now(args))
            return 0
        if args.watch:
            return run_watch(args)
        if args.stream:
            return run_stream(args)
        return run_once(args)
    except (GhCommandError, RuntimeError, ValueError) as err:
        sys.stderr.write(f"gh_pr_watch.py error: {err}\n")
        return 1
    except KeyboardInterrupt:
        sys.stderr.write("gh_pr_watch.py interrupted\n")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
