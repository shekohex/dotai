#!/usr/bin/env python3
"""Behavior smoke test for coordinator_state.py."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("coordinator_state.py")


def run(
    agents_home: Path,
    *arguments: str,
    expect_success: bool = True,
    environment: dict[str, str] | None = None,
) -> dict:
    command_environment = {**os.environ, "AGENTS_HOME": str(agents_home)}
    if environment:
        command_environment.update(environment)
    completed = subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        env=command_environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if expect_success and completed.returncode != 0:
        raise AssertionError(completed.stdout + completed.stderr)
    if not expect_success and completed.returncode == 0:
        raise AssertionError("command unexpectedly succeeded")
    return json.loads(completed.stdout)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="program-coordinator-test-") as temporary:
        agents_home = Path(temporary)
        initialized = run(
            agents_home,
            "init",
            "--product-id",
            "sample",
            "--name",
            "Sample Product",
        )
        assert initialized["ok"] is True
        assert initialized["reminders"]
        project_config = json.loads(
            (agents_home / "projects" / "sample" / "project.json").read_text()
        )
        assert project_config["schema_version"] == 1
        assert project_config["limits"]["soft_time_budget_minutes"] is None
        assert project_config["limits"]["fallback_heartbeat_minutes"] == 10
        database_path = agents_home / "projects" / "sample" / "state.sqlite"
        with sqlite3.connect(database_path) as connection:
            assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
            assert connection.execute(
                "SELECT version FROM schema_migrations"
            ).fetchone()[0] == 1
            assert connection.execute(
                "SELECT name FROM sqlite_schema WHERE name='pull_request_tasks'"
            ).fetchone()[0] == "pull_request_tasks"

        acquired = run(
            agents_home,
            "lease-acquire",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-1",
        )
        lease_token = acquired["lease_token"]
        assert lease_token.encode() not in database_path.read_bytes()

        renewed = run(
            agents_home,
            "lease-renew",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-1",
            "--lease-token-env",
            "COORDINATOR_LEASE_TOKEN",
            environment={"COORDINATOR_LEASE_TOKEN": lease_token},
        )
        assert renewed["ok"] is True
        missing_environment_token = run(
            agents_home,
            "lease-renew",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-1",
            "--lease-token-env",
            "MISSING_COORDINATOR_LEASE_TOKEN",
            expect_success=False,
        )
        assert missing_environment_token["ok"] is False

        repository_path = agents_home / "sample-repository"
        worktree_path = agents_home / "sample-worktree"
        repository_path.mkdir()
        subprocess.run(
            ["git", "init", "-b", "main"],
            cwd=repository_path,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [
                "git",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Coordinator Test",
                "-c",
                "user.email=coordinator@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
            cwd=repository_path,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [
                "git",
                "remote",
                "add",
                "origin",
                "git@github.com:Example/Program.git",
            ],
            cwd=repository_path,
            check=True,
        )
        subprocess.run(
            ["git", "worktree", "add", "-b", "test-worktree", str(worktree_path)],
            cwd=repository_path,
            check=True,
            capture_output=True,
        )
        registered = run(
            agents_home,
            "registry-upsert",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--repo-path",
            str(repository_path),
            "--reason",
            "Register smoke-test repository",
        )
        assert registered["repository"]["remote"] == "github.com/example/program"
        detected = run(
            agents_home,
            "registry-detect",
            "--repo-path",
            str(worktree_path),
        )
        assert detected["product_id"] == "sample"
        assert "remote" in detected["matched_by"]
        assert "git_common_dir" in detected["matched_by"]
        registry = run(
            agents_home, "registry-list", "--product-id", "sample"
        )
        assert len(registry["repositories"]) == 1

        mutation = run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Create initiative for smoke test",
            "--action",
            "initiative.created",
            "--params-json",
            json.dumps(
                {
                    "id": "initiative-1",
                    "product": "sample",
                    "title": "Ship capability",
                    "now": "2026-01-01T00:00:00+00:00",
                }
            ),
            """
            INSERT INTO initiatives(
              id, product_id, title, state, phase, soft_time_budget_minutes,
              created_at, updated_at
            ) VALUES (
              :id, :product, :title, 'active', 'research', 90, :now, :now
            )
            """,
        )
        assert mutation["ok"] is True
        assert mutation["changed_rows"] == 1
        assert mutation["touched_tables"] == ["initiatives"]

        query = run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--read-only",
            "--params-json",
            '{"id":"initiative-1"}',
            "SELECT title, soft_time_budget_minutes FROM initiatives WHERE id=:id",
        )
        assert query["rows"] == [
            {"title": "Ship capability", "soft_time_budget_minutes": 90}
        ]

        for task_id, title in (
            ("task-1", "First coupled task"),
            ("task-2", "Second coupled task"),
        ):
            run(
                agents_home,
                "sql",
                "--product-id",
                "sample",
                "--actor",
                "coordinator-1",
                "--lease-token-env",
                "COORDINATOR_LEASE_TOKEN",
                "--reason",
                "Create coupled task",
                "--params-json",
                json.dumps(
                    {
                        "id": task_id,
                        "initiative": "initiative-1",
                        "title": title,
                        "now": "2026-01-01T00:00:00+00:00",
                    }
                ),
                "INSERT INTO tasks("
                "id, initiative_id, title, state, phase, created_at, updated_at"
                ") VALUES ("
                ":id, :initiative, :title, 'complete', 'merge', :now, :now"
                ")",
                environment={"COORDINATOR_LEASE_TOKEN": lease_token},
            )

        for pull_request_id, head_sha, legacy_task_id in (
            ("pr-awaiting", "head-awaiting", "task-1"),
            ("pr-deployed", "head-deployed", None),
        ):
            run(
                agents_home,
                "sql",
                "--product-id",
                "sample",
                "--actor",
                "coordinator-1",
                "--lease-token",
                lease_token,
                "--reason",
                "Record merged PR",
                "--params-json",
                json.dumps(
                    {
                        "id": pull_request_id,
                        "initiative": "initiative-1",
                        "legacy_task": legacy_task_id,
                        "head": head_sha,
                        "now": "2026-01-02T00:00:00+00:00",
                    }
                ),
                "INSERT INTO pull_requests("
                "id, product_id, initiative_id, task_id, number, branch, "
                "base_branch, head_sha, state, created_at, updated_at"
                ") VALUES ("
                ":id, 'sample', NULL, :legacy_task, 10, 'feature/coupled', "
                "'main', :head, 'merged', :now, :now"
                ")",
            )

        linked_tasks = run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Link multiple tasks to one PR",
            "--params-json",
            json.dumps(
                {
                    "pr": "pr-awaiting",
                    "task_one": "task-1",
                    "task_two": "task-2",
                    "now": "2026-01-02T00:00:00+00:00",
                }
            ),
            "INSERT INTO pull_request_tasks(pull_request_id, task_id, created_at) "
            "VALUES (:pr, :task_one, :now), (:pr, :task_two, :now)",
        )
        assert linked_tasks["changed_rows"] == 2

        run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Record verified deployment",
            "--params-json",
            '{"id":"deployment-1","head":"head-deployed",'
            '"verified":"2026-01-03T00:00:00+00:00"}',
            "INSERT INTO deployments("
            "id, product_id, environment, head_sha, status, created_at, "
            "updated_at, verified_at"
            ") VALUES ("
            ":id, 'sample', 'production', :head, 'verified', :verified, "
            ":verified, :verified"
            ")",
        )

        checkpoint = run(
            agents_home,
            "checkpoint",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Before smoke-test mutation",
            "--trigger",
            "test",
        )
        checkpoint_id = checkpoint["checkpoint_id"]
        assert Path(checkpoint["checkpoint_directory"]).is_dir()

        updated = run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Change title after checkpoint",
            "--params-json",
            '{"id":"initiative-1","title":"Changed capability"}',
            "UPDATE initiatives SET title=:title WHERE id=:id",
        )
        assert updated["checkpoint"] is None

        restored = run(
            agents_home,
            "restore",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--checkpoint-id",
            checkpoint_id,
            "--reason",
            "Verify checkpoint rollback",
        )
        assert restored["restored_checkpoint_id"] == checkpoint_id
        restored_query = run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--read-only",
            "SELECT title FROM initiatives WHERE id='initiative-1'",
        )
        assert restored_query["rows"] == [{"title": "Ship capability"}]

        deleted = run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Verify destructive mutation checkpoint",
            "DELETE FROM initiatives WHERE id='initiative-1'",
        )
        assert deleted["checkpoint"] is not None
        checkpoints_root = agents_home / "projects" / "sample" / "checkpoints"
        assert len([path for path in checkpoints_root.iterdir() if path.is_dir()]) <= 5
        run(
            agents_home,
            "restore",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--checkpoint-id",
            deleted["checkpoint"]["checkpoint_id"],
            "--reason",
            "Restore automatically checkpointed deletion",
        )
        for checkpoint_number in range(6):
            run(
                agents_home,
                "checkpoint",
                "--product-id",
                "sample",
                "--holder",
                "coordinator-1",
                "--lease-token",
                lease_token,
                "--reason",
                f"Retention checkpoint {checkpoint_number}",
            )
        listed_checkpoints = run(
            agents_home, "checkpoint-list", "--product-id", "sample"
        )
        assert len(listed_checkpoints["checkpoints"]) == 5

        forbidden = run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Attempt forbidden audit mutation",
            "DELETE FROM events",
            expect_success=False,
        )
        assert forbidden["ok"] is False

        ddl_forbidden = run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Attempt forbidden schema mutation",
            "CREATE TABLE bypass(id TEXT)",
            expect_success=False,
        )
        assert ddl_forbidden["ok"] is False

        second_lease = run(
            agents_home,
            "lease-acquire",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-2",
            expect_success=False,
        )
        assert second_lease["ok"] is False
        failure_log = agents_home / "projects" / "sample" / "failed-events.jsonl"
        assert failure_log.exists()

        summary = run(agents_home, "summary", "--product-id", "sample")
        assert len(summary["initiatives"]) == 1
        assert len(summary["recent_events"]) >= 3
        assert summary["merged_awaiting_deployment"][0]["id"] == "pr-awaiting"
        assert summary["merged_awaiting_deployment"][0]["task_ids"] == [
            "task-1",
            "task-2",
        ]
        assert summary["fully_deployed"][0]["id"] == "pr-deployed"
        assert summary["fully_deployed"][0]["deployment_state"] == "fully_deployed"

        doctor = run(agents_home, "doctor", "--product-id", "sample")
        assert doctor["ok"] is True
        assert doctor["journal_mode"] == "wal"
        assert doctor["wal_autocheckpoint_pages"] == 1000

        exported = run(agents_home, "export", "--product-id", "sample")
        export_directory = Path(exported["output_directory"])
        assert (export_directory / "state.json").exists()
        assert (export_directory / "events.jsonl").exists()

        removed_registration = run(
            agents_home,
            "registry-remove",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--repo-path",
            str(worktree_path),
            "--reason",
            "Remove smoke-test repository",
        )
        assert len(removed_registration["removed"]) == 1
        run(
            agents_home,
            "registry-detect",
            "--repo-path",
            str(repository_path),
            expect_success=False,
        )

        released = run(
            agents_home,
            "lease-release",
            "--product-id",
            "sample",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
        )
        assert released["ok"] is True

    print("coordinator_state smoke test: passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
