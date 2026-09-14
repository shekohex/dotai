#!/usr/bin/env python3
"""Behavior smoke test for coordinator_state.py."""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).with_name("coordinator_state.py")

LEGACY_V1_SCHEMA_SQL = """
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE products(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE repositories(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL, path TEXT, url TEXT, default_branch TEXT NOT NULL DEFAULT 'main',
  role TEXT NOT NULL DEFAULT 'primary', created_at TEXT NOT NULL,
  UNIQUE(product_id, name)
);
CREATE TABLE initiatives(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL,
  charter_status TEXT NOT NULL DEFAULT 'draft', charter_version INTEGER NOT NULL DEFAULT 1,
  soft_time_budget_minutes INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  completed_at TEXT, archived_at TEXT, archive_reason TEXT
);
CREATE TABLE agents(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  harness TEXT, external INTEGER NOT NULL DEFAULT 0, managed INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle', current_task_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tasks(
  id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL REFERENCES initiatives(id),
  title TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL,
  risk_class TEXT NOT NULL DEFAULT 'medium', soft_time_budget_minutes INTEGER,
  owner_agent_id TEXT REFERENCES agents(id), blocker TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE approvals(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  executable_hash TEXT, scope_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, expires_at TEXT, consumed_at TEXT
);
CREATE TABLE task_gates(
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate TEXT NOT NULL, status TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}',
  approval_id TEXT REFERENCES approvals(id), updated_at TEXT NOT NULL,
  PRIMARY KEY(task_id, gate)
);
CREATE TABLE stacks(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id), trunk_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE pull_requests(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  initiative_id TEXT REFERENCES initiatives(id),
  task_id TEXT REFERENCES tasks(id),
  repository_id TEXT REFERENCES repositories(id), number INTEGER, url TEXT,
  branch TEXT NOT NULL, base_branch TEXT NOT NULL, head_sha TEXT,
  state TEXT NOT NULL DEFAULT 'open', stack_id TEXT REFERENCES stacks(id),
  stack_position INTEGER, mergeable_state TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, UNIQUE(repository_id, number)
);
CREATE TABLE pull_request_tasks(
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY(pull_request_id, task_id)
);
CREATE INDEX pull_request_tasks_by_task ON pull_request_tasks(task_id);
CREATE TABLE resource_leases(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  resource_class TEXT NOT NULL, holder_agent_id TEXT REFERENCES agents(id),
  status TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  released_at TEXT
);
CREATE TABLE deployments(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  initiative_id TEXT REFERENCES initiatives(id), environment TEXT NOT NULL,
  head_sha TEXT NOT NULL, plan_hash TEXT, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT
);
CREATE TABLE decisions(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  initiative_id TEXT REFERENCES initiatives(id), title TEXT NOT NULL,
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  supersedes_id TEXT REFERENCES decisions(id), created_at TEXT NOT NULL
);
CREATE TABLE coordinator_leases(
  product_id TEXT PRIMARY KEY REFERENCES products(id), holder_id TEXT NOT NULL,
  token_hash TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE events(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  occurred_at TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
  initiative_id TEXT REFERENCES initiatives(id), action TEXT NOT NULL,
  target_type TEXT, target_id TEXT, risk_class TEXT NOT NULL,
  reason TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', correlation_id TEXT
);
"""


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


def schema_versions(database_path: Path) -> list[int]:
    with sqlite3.connect(database_path) as connection:
        return [
            row[0]
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            )
        ]


def set_schema_versions(database_path: Path, versions: list[int]) -> None:
    with sqlite3.connect(database_path) as connection:
        connection.execute("DELETE FROM schema_migrations")
        connection.executemany(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            [(version, "2026-01-01T00:00:00+00:00") for version in versions],
        )


def database_file_snapshot(database_path: Path) -> dict[str, tuple[bool, int | None, bytes]]:
    snapshot: dict[str, tuple[bool, int | None, bytes]] = {}
    for path in (
        database_path,
        database_path.with_name(f"{database_path.name}-wal"),
        database_path.with_name(f"{database_path.name}-shm"),
    ):
        snapshot[path.name] = (
            path.exists(),
            path.stat().st_mtime_ns if path.exists() else None,
            path.read_bytes() if path.exists() else b"",
        )
    return snapshot


def summarize_file_snapshot(
    snapshot: dict[str, tuple[bool, int | None, bytes]]
) -> dict[str, tuple[bool, int | None, int, str]]:
    return {
        name: (exists, mtime, len(content), hashlib.sha256(content).hexdigest())
        for name, (exists, mtime, content) in snapshot.items()
    }


def create_independent_legacy_v1_fixture(agents_home: Path) -> tuple[Path, str]:
    product_root = agents_home / "projects" / "legacy-fk"
    for directory in (
        product_root,
        product_root / "initiatives",
        product_root / "artifacts",
        product_root / "exports",
        product_root / "checkpoints",
        product_root / "locks",
    ):
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o700)
    database_path = product_root / "state.sqlite"
    lease_token = "legacy-v1-lease-token"
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(LEGACY_V1_SCHEMA_SQL)
        connection.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)",
            ("2026-01-01T00:00:00+00:00",),
        )
        connection.execute(
            "INSERT INTO products(id, name, created_at, updated_at) "
            "VALUES ('legacy-fk', 'Legacy FK Product', ?, ?)",
            ("2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
        )
        connection.execute(
            "INSERT INTO initiatives(id, product_id, title, state, phase, created_at, updated_at) "
            "VALUES ('legacy-fk-initiative', 'legacy-fk', 'Legacy FK initiative', 'active', 'deploy', ?, ?)",
            ("2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
        )
        connection.execute(
            "INSERT INTO tasks(id, initiative_id, title, state, phase, created_at, updated_at) "
            "VALUES ('legacy-fk-task', 'legacy-fk-initiative', 'Legacy FK task', 'complete', 'deploy', ?, ?)",
            ("2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
        )
        connection.execute(
            """
            INSERT INTO pull_requests(
              id, product_id, initiative_id, task_id, number, branch, base_branch,
              head_sha, state, created_at, updated_at
            ) VALUES ('legacy-fk-pr', 'legacy-fk', 'legacy-fk-initiative',
              'legacy-fk-task', 1, 'legacy-fk', 'main', 'legacy-fk-head',
              'merged', ?, ?)
            """,
            ("2026-01-02T00:00:00+00:00", "2026-01-02T00:00:00+00:00"),
        )
        connection.execute(
            "INSERT INTO pull_request_tasks(pull_request_id, task_id, created_at) "
            "VALUES ('legacy-fk-pr', 'legacy-fk-task', ?)",
            ("2026-01-02T00:00:00+00:00",),
        )
        connection.execute(
            """
            INSERT INTO coordinator_leases(
              product_id, holder_id, token_hash, acquired_at, expires_at
            ) VALUES ('legacy-fk', 'coordinator-1', ?, ?, ?)
            """,
            (
                hashlib.sha256(lease_token.encode()).hexdigest(),
                "2026-01-01T00:00:00+00:00",
                "2099-01-01T00:00:00+00:00",
            ),
        )
        connection.execute(
            """
            INSERT INTO events(
              id, product_id, occurred_at, actor_type, actor_id, action,
              risk_class, reason
            ) VALUES ('legacy-fk-event', 'legacy-fk', ?, 'coordinator',
              'fixture', 'fixture.created', 'low', 'Create independent legacy fixture')
            """,
            ("2026-01-01T00:00:00+00:00",),
        )
    database_path.chmod(0o600)
    (product_root / "project.json").write_text(
        json.dumps(
            {"schema_version": 1, "product_id": "legacy-fk", "name": "Legacy FK Product"}
        )
        + "\n",
        encoding="utf-8",
    )
    (product_root / "project.json").chmod(0o600)
    return database_path, lease_token


def assert_legacy_fk_converges() -> None:
    with tempfile.TemporaryDirectory(prefix="program-coordinator-fk-") as temporary:
        agents_home = Path(temporary)
        database_path, lease_token = create_independent_legacy_v1_fixture(agents_home)
        with sqlite3.connect(database_path) as connection:
            assert connection.execute(
                "SELECT on_delete FROM pragma_foreign_key_list('pull_requests') "
                "WHERE \"from\" = 'task_id'"
            ).fetchone()[0] == "NO ACTION"
        summary = run(agents_home, "summary", "--product-id", "legacy-fk")
        assert summary["merged_awaiting_deployment"][0]["id"] == "legacy-fk-pr"
        with sqlite3.connect(database_path) as connection:
            assert connection.execute(
                "SELECT on_delete FROM pragma_foreign_key_list('pull_requests') "
                "WHERE \"from\" = 'task_id'"
            ).fetchone()[0] == "NO ACTION"
        run(
            agents_home,
            "schema-reconcile",
            "--product-id",
            "legacy-fk",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
        )
        with sqlite3.connect(database_path) as connection:
            assert connection.execute(
                "SELECT on_delete FROM pragma_foreign_key_list('pull_requests') "
                "WHERE \"from\" = 'task_id'"
            ).fetchone()[0] == "SET NULL"
            assert connection.execute(
                "SELECT pull_request_id, task_id FROM pull_request_tasks"
            ).fetchall() == [("legacy-fk-pr", "legacy-fk-task")]
            assert connection.execute(
                "SELECT name FROM sqlite_schema "
                "WHERE type='table' AND name='pull_request_deployments'"
            ).fetchone()[0] == "pull_request_deployments"
            event_ids_before_delete = [
                row[0] for row in connection.execute("SELECT id FROM events")
            ]
        deleted = run(
            agents_home,
            "sql",
            "--product-id",
            "legacy-fk",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Delete task and preserve merged PR",
            "DELETE FROM tasks WHERE id='legacy-fk-task'",
        )
        assert deleted["ok"] is True
        with sqlite3.connect(database_path) as connection:
            assert connection.execute(
                "SELECT task_id FROM pull_requests WHERE id='legacy-fk-pr'"
            ).fetchone()[0] is None
            assert connection.execute(
                "SELECT * FROM pull_request_tasks"
            ).fetchall() == []
            assert set(event_ids_before_delete).issubset(
                {row[0] for row in connection.execute("SELECT id FROM events")}
            )


def create_existing_v1_fixture(
    agents_home: Path, *, pre_materialized: bool
) -> tuple[Path, str]:
    run(
        agents_home,
        "init",
        "--product-id",
        "legacy",
        "--name",
        "Legacy Product",
    )
    acquired = run(
        agents_home,
        "lease-acquire",
        "--product-id",
        "legacy",
        "--holder",
        "coordinator-1",
    )
    lease_token = acquired["lease_token"]
    run(
        agents_home,
        "sql",
        "--product-id",
        "legacy",
        "--actor",
        "coordinator-1",
        "--lease-token",
        lease_token,
        "--reason",
        "Create legacy initiative",
        "--params-json",
        '{"now":"2026-01-01T00:00:00+00:00"}',
        """
        INSERT INTO initiatives(
          id, product_id, title, state, phase, created_at, updated_at
        ) VALUES (
          'legacy-initiative', 'legacy', 'Legacy initiative', 'active',
          'deploy', :now, :now
        )
        """,
    )
    run(
        agents_home,
        "sql",
        "--product-id",
        "legacy",
        "--actor",
        "coordinator-1",
        "--lease-token",
        lease_token,
        "--reason",
        "Create legacy task",
        "--params-json",
        '{"now":"2026-01-01T00:00:00+00:00"}',
        """
        INSERT INTO tasks(
          id, initiative_id, title, state, phase, created_at, updated_at
        ) VALUES (
          'legacy-task', 'legacy-initiative', 'Legacy task', 'complete',
          'deploy', :now, :now
        )
        """,
    )
    run(
        agents_home,
        "sql",
        "--product-id",
        "legacy",
        "--actor",
        "coordinator-1",
        "--lease-token",
        lease_token,
        "--reason",
        "Create legacy merged PR",
        "--params-json",
        '{"now":"2026-01-02T00:00:00+00:00"}',
        """
        INSERT INTO pull_requests(
          id, product_id, initiative_id, task_id, number, branch, base_branch,
          head_sha, state, created_at, updated_at
        ) VALUES (
          'legacy-pr', 'legacy', 'legacy-initiative', 'legacy-task', 1,
          'legacy', 'main', 'legacy-head', 'merged', :now, :now
        )
        """,
    )
    database_path = agents_home / "projects" / "legacy" / "state.sqlite"
    with sqlite3.connect(database_path) as connection:
        if not pre_materialized:
            connection.execute("DROP TABLE pull_request_tasks")
        else:
            connection.execute(
                """
                INSERT INTO pull_request_tasks(
                  pull_request_id, task_id, created_at
                ) VALUES ('legacy-pr', 'legacy-task', ?)
                """,
                ("2026-01-02T00:00:00+00:00",),
            )
        connection.execute("DELETE FROM schema_migrations WHERE version <> 1")
    return database_path, lease_token


def assert_existing_v1_opens(*, pre_materialized: bool) -> None:
    with tempfile.TemporaryDirectory(prefix="program-coordinator-v1-") as temporary:
        agents_home = Path(temporary)
        database_path, lease_token = create_existing_v1_fixture(
            agents_home, pre_materialized=pre_materialized
        )
        with sqlite3.connect(database_path) as connection:
            event_ids_before = [
                row[0] for row in connection.execute("SELECT id FROM events")
            ]
            lease_before = connection.execute(
                "SELECT holder_id, token_hash, expires_at FROM coordinator_leases"
            ).fetchone()
        assert schema_versions(database_path) == [1]

        before_read_only_commands = database_file_snapshot(database_path)
        summary = run(agents_home, "summary", "--product-id", "legacy")
        assert summary["merged_awaiting_deployment"][0]["id"] == "legacy-pr"
        assert summary["merged_awaiting_deployment"][0]["task_ids"] == [
            "legacy-task"
        ]
        doctor = run(agents_home, "doctor", "--product-id", "legacy")
        assert doctor["schema_versions"] == [1]
        after_read_only_commands = database_file_snapshot(database_path)
        assert after_read_only_commands == before_read_only_commands, (
            summarize_file_snapshot(before_read_only_commands),
            summarize_file_snapshot(after_read_only_commands),
        )

        run(
            agents_home,
            "schema-reconcile",
            "--product-id",
            "legacy",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
        )

        with sqlite3.connect(database_path) as connection:
            event_ids_after_first = [
                row[0] for row in connection.execute("SELECT id FROM events")
            ]
            assert connection.execute(
                "SELECT name FROM sqlite_schema "
                "WHERE type='table' AND name='pull_request_tasks'"
            ).fetchone()[0] == "pull_request_tasks"
            assert connection.execute(
                "SELECT pull_request_id, task_id FROM pull_request_tasks"
            ).fetchall() == [("legacy-pr", "legacy-task")]
            assert connection.execute(
                "SELECT title FROM initiatives WHERE id='legacy-initiative'"
            ).fetchone()[0] == "Legacy initiative"
            assert connection.execute(
                "SELECT holder_id, token_hash, expires_at FROM coordinator_leases"
            ).fetchone() == lease_before
        assert schema_versions(database_path) == [1]
        assert set(event_ids_before).issubset(event_ids_after_first)
        if pre_materialized:
            assert event_ids_after_first == event_ids_before
        else:
            assert len(event_ids_after_first) == len(event_ids_before) + 1
        assert lease_token.encode() not in database_path.read_bytes()

        run(
            agents_home,
            "schema-reconcile",
            "--product-id",
            "legacy",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
        )
        with sqlite3.connect(database_path) as connection:
            assert [
                row[0] for row in connection.execute("SELECT id FROM events")
            ] == event_ids_after_first

        run(agents_home, "summary", "--product-id", "legacy")
        with sqlite3.connect(database_path) as connection:
            assert [
                row[0] for row in connection.execute("SELECT id FROM events")
            ] == event_ids_after_first


def assert_future_schema_refused() -> None:
    with tempfile.TemporaryDirectory(prefix="program-coordinator-future-") as temporary:
        agents_home = Path(temporary)
        run(
            agents_home,
            "init",
            "--product-id",
            "future",
            "--name",
            "Future Product",
        )
        database_path = agents_home / "projects" / "future" / "state.sqlite"
        with sqlite3.connect(database_path) as connection:
            event_ids_before = [
                row[0] for row in connection.execute("SELECT id FROM events")
            ]
        for versions, error_fragment in (
            ([1, 2], "unsupported newer versions"),
            ([0], "unknown versions"),
        ):
            set_schema_versions(database_path, versions)
            before_refusal = database_file_snapshot(database_path)
            refused = run(
                agents_home,
                "summary",
                "--product-id",
                "future",
                expect_success=False,
            )
            assert refused["ok"] is False
            assert error_fragment in refused["error"]
            assert database_file_snapshot(database_path) == before_refusal
            assert schema_versions(database_path) == versions
            with sqlite3.connect(database_path) as connection:
                assert [
                    row[0] for row in connection.execute("SELECT id FROM events")
                ] == event_ids_before


def assert_reconciliation_failure_rolls_back() -> None:
    with tempfile.TemporaryDirectory(prefix="program-coordinator-rollback-") as temporary:
        agents_home = Path(temporary)
        run(
            agents_home,
            "init",
            "--product-id",
            "rollback",
            "--name",
            "Rollback Product",
        )
        lease_token = run(
            agents_home,
            "lease-acquire",
            "--product-id",
            "rollback",
            "--holder",
            "coordinator-1",
        )["lease_token"]
        database_path = agents_home / "projects" / "rollback" / "state.sqlite"
        with sqlite3.connect(database_path) as connection:
            event_ids_before = [
                row[0] for row in connection.execute("SELECT id FROM events")
            ]
            connection.execute("DROP TABLE pull_request_tasks")
            connection.execute(
                """
                CREATE TABLE pull_request_tasks(
                  pull_request_id TEXT NOT NULL, task_id TEXT NOT NULL
                )
                """
            )
        refused = run(
            agents_home,
            "schema-reconcile",
            "--product-id",
            "rollback",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
            expect_success=False,
        )
        assert refused["ok"] is False
        assert "created_at" in refused["error"]
        assert schema_versions(database_path) == [1]
        with sqlite3.connect(database_path) as connection:
            assert [
                row[0] for row in connection.execute("SELECT id FROM events")
            ] == event_ids_before


def assert_existing_v1_deployment_relation_converges() -> None:
    with tempfile.TemporaryDirectory(
        prefix="program-coordinator-deployment-v1-"
    ) as temporary:
        agents_home = Path(temporary)
        run(
            agents_home,
            "init",
            "--product-id",
            "deployment-legacy",
            "--name",
            "Deployment Legacy Product",
        )
        lease_token = run(
            agents_home,
            "lease-acquire",
            "--product-id",
            "deployment-legacy",
            "--holder",
            "coordinator-1",
        )["lease_token"]
        database_path = (
            agents_home / "projects" / "deployment-legacy" / "state.sqlite"
        )
        with sqlite3.connect(database_path) as connection:
            connection.execute(
                "DROP INDEX pull_request_deployments_by_environment"
            )
            connection.execute(
                "ALTER TABLE pull_request_deployments "
                "RENAME TO pull_request_deployments_current"
            )
            connection.executescript(
                """
                CREATE TABLE pull_request_deployments (
                  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
                  environment TEXT NOT NULL,
                  deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
                  deployed_head_sha TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('pending','passed','failed')),
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY(pull_request_id, environment)
                );
                CREATE INDEX pull_request_deployments_by_environment
                  ON pull_request_deployments(environment, status);
                DROP TABLE pull_request_deployments_current;
                """
            )
            connection.executemany(
                """
                INSERT INTO initiatives(
                  id, product_id, title, state, phase, created_at, updated_at
                ) VALUES (?, 'deployment-legacy', ?, 'complete', 'deploy', ?, ?)
                """,
                [("deployment-legacy-init", "Deployment legacy", "2026-01-01", "2026-01-01")],
            )
            connection.execute(
                """
                INSERT INTO tasks(
                  id, initiative_id, title, state, phase, created_at, updated_at
                ) VALUES (
                  'deployment-legacy-task', 'deployment-legacy-init',
                  'Deployment task', 'complete', 'deploy', '2026-01-01', '2026-01-01'
                )
                """
            )
            connection.execute(
                """
                INSERT INTO pull_requests(
                  id, product_id, task_id, branch, base_branch, head_sha, state,
                  created_at, updated_at
                ) VALUES (
                  'deployment-legacy-pr', 'deployment-legacy',
                  'deployment-legacy-task', 'legacy', 'main', 'legacy-pr-head',
                  'merged', '2026-01-02', '2026-01-02'
                )
                """
            )
            connection.execute(
                """
                INSERT INTO pull_request_tasks(
                  pull_request_id, task_id, created_at
                ) VALUES ('deployment-legacy-pr', 'deployment-legacy-task', '2026-01-02')
                """
            )
            connection.execute(
                """
                INSERT INTO deployments(
                  id, product_id, environment, head_sha, status, created_at,
                  updated_at, verified_at
                ) VALUES (
                  'deployment-legacy-deployment', 'deployment-legacy',
                  'production', 'legacy-merge-head', 'verified', '2026-01-03',
                  '2026-01-03', '2026-01-03'
                )
                """
            )
            connection.execute(
                """
                INSERT INTO pull_request_deployments(
                  pull_request_id, environment, deployment_id, deployed_head_sha,
                  status, updated_at
                ) VALUES (
                  'deployment-legacy-pr', 'production',
                  'deployment-legacy-deployment', 'legacy-pr-head', 'passed',
                  '2026-01-03'
                )
                """
            )

        before_reconcile = run(
            agents_home, "summary", "--product-id", "deployment-legacy"
        )
        before_row = before_reconcile["merged_awaiting_deployment"][0]
        assert before_row["deployment_coverage_statuses"] == {
            "production": "invalid"
        }
        run(
            agents_home,
            "schema-reconcile",
            "--product-id",
            "deployment-legacy",
            "--holder",
            "coordinator-1",
            "--lease-token",
            lease_token,
        )
        with sqlite3.connect(database_path) as connection:
            assert connection.execute(
                "SELECT deployment_head_sha FROM pull_request_deployments"
            ).fetchone()[0] == "legacy-merge-head"
        after_reconcile = run(
            agents_home, "summary", "--product-id", "deployment-legacy"
        )
        assert [row["id"] for row in after_reconcile["fully_deployed"]] == [
            "deployment-legacy-pr"
        ]


def assert_summary_consistent_snapshot() -> None:
    with tempfile.TemporaryDirectory(
        prefix="program-coordinator-snapshot-"
    ) as temporary:
        agents_home = Path(temporary)
        run(
            agents_home,
            "init",
            "--product-id",
            "snapshot",
            "--name",
            "Snapshot Product",
        )
        lease_token = run(
            agents_home,
            "lease-acquire",
            "--product-id",
            "snapshot",
            "--holder",
            "coordinator-1",
        )["lease_token"]
        run(
            agents_home,
            "sql",
            "--product-id",
            "snapshot",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Create snapshot test PR",
            "--params-json",
            '{"now":"2026-01-02T00:00:00+00:00"}',
            "INSERT INTO pull_requests("
            "id, product_id, number, branch, base_branch, head_sha, state, "
            "created_at, updated_at"
            ") VALUES ('snapshot-pr', 'snapshot', 1, 'snapshot', 'main', "
            "'old-head', 'merged', :now, :now)",
        )

        module_spec = importlib.util.spec_from_file_location(
            "program_coordinator_state", SCRIPT
        )
        assert module_spec is not None and module_spec.loader is not None
        coordinator_state = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(coordinator_state)
        database_path = agents_home / "projects" / "snapshot" / "state.sqlite"
        original_connect = coordinator_state.connect
        writer_committed = False

        def traced_connect(product_id: str, *, read_only: bool = False):
            nonlocal writer_committed
            if not read_only:
                return original_connect(product_id, read_only=False)
            connection = sqlite3.connect(database_path)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")

            def inject_commit(statement: str) -> None:
                nonlocal writer_committed
                if (
                    writer_committed
                    or "select * from products where id" not in statement.lower()
                ):
                    return
                with sqlite3.connect(database_path) as writer:
                    writer.execute("BEGIN IMMEDIATE")
                    writer.execute(
                        "UPDATE products SET name='New Snapshot Product' "
                        "WHERE id='snapshot'"
                    )
                    writer.execute(
                        "UPDATE pull_requests SET head_sha='new-head' "
                        "WHERE id='snapshot-pr'"
                    )
                writer_committed = True

            connection.set_trace_callback(inject_commit)
            return connection

        previous_agents_home = os.environ.get("AGENTS_HOME")
        os.environ["AGENTS_HOME"] = str(agents_home)
        coordinator_state.connect = traced_connect
        try:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                coordinator_state.summarize(
                    SimpleNamespace(product_id="snapshot", event_limit=20)
                )
        finally:
            coordinator_state.connect = original_connect
            if previous_agents_home is None:
                os.environ.pop("AGENTS_HOME", None)
            else:
                os.environ["AGENTS_HOME"] = previous_agents_home

        assert writer_committed is True
        summary = json.loads(output.getvalue())
        assert summary["product"]["name"] == "Snapshot Product"
        assert summary["merged_awaiting_deployment"][0]["head_sha"] == "old-head"
        with sqlite3.connect(database_path) as connection:
            assert connection.execute(
                "SELECT name FROM products WHERE id='snapshot'"
            ).fetchone()[0] == "New Snapshot Product"
            assert connection.execute(
                "SELECT head_sha FROM pull_requests WHERE id='snapshot-pr'"
            ).fetchone()[0] == "new-head"


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
            assert [
                row[0]
                for row in connection.execute(
                    "SELECT version FROM schema_migrations ORDER BY version"
                )
            ] == [1]
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

        for task_id, status in (("task-1", "passed"), ("task-2", "pending")):
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
                "Set deployment gate",
                "--params-json",
                json.dumps(
                    {
                        "task": task_id,
                        "status": status,
                        "now": "2026-01-03T00:00:00+00:00",
                    }
                ),
                "INSERT INTO task_gates(task_id, gate, status, updated_at) "
                "VALUES (:task, 'deployment', :status, :now)",
            )

        atomic_pr = run(
            agents_home,
            "pull-request-upsert",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Record multi-task merged PR atomically",
            "--pull-request-json",
            json.dumps(
                {
                    "id": "pr-awaiting",
                    "task_id": "task-1",
                    "number": 10,
                    "branch": "feature/coupled",
                    "base_branch": "main",
                    "head_sha": "head-awaiting",
                    "state": "merged",
                    "created_at": "2026-01-02T00:00:00+00:00",
                    "updated_at": "2026-01-02T00:00:00+00:00",
                }
            ),
            "--task-ids-json",
            '["task-1", "task-2"]',
        )
        assert atomic_pr["task_ids"] == ["task-1", "task-2"]

        default_state_pr = run(
            agents_home,
            "pull-request-upsert",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Record PR using default state",
            "--pull-request-json",
            '{"id":"pr-default-state","branch":"feature/default-state",'
            '"base_branch":"main","created_at":"2026-01-02T00:00:00+00:00",'
            '"updated_at":"2026-01-02T00:00:00+00:00"}',
            "--task-ids-json",
            '["task-1"]',
        )
        assert default_state_pr["task_ids"] == ["task-1"]
        assert run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--read-only",
            "SELECT state FROM pull_requests WHERE id='pr-default-state'",
        )["rows"] == [{"state": "open"}]

        corrected_pr = run(
            agents_home,
            "pull-request-upsert",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Correct complete PR task links",
            "--pull-request-json",
            '{"id":"pr-awaiting","task_id":"task-1",'
            '"updated_at":"2026-01-02T00:00:01+00:00"}',
            "--task-ids-json",
            '["task-2"]',
        )
        assert corrected_pr["task_ids"] == ["task-2"]
        assert run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--read-only",
            "SELECT task_id FROM pull_request_tasks "
            "WHERE pull_request_id='pr-awaiting' ORDER BY task_id",
        )["rows"] == [{"task_id": "task-2"}]
        assert run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--read-only",
            "SELECT task_id FROM pull_requests WHERE id='pr-awaiting'",
        )["rows"] == [{"task_id": "task-2"}]

        for pull_request_id, head_sha, legacy_task_id in (
            ("pr-deployed", "pr-deployed-head", "task-1"),
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

        atomic_failure = run(
            agents_home,
            "pull-request-upsert",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Verify atomic PR link rollback",
            "--pull-request-json",
            '{"id":"pr-atomic-failure","branch":"feature/failure",'
            '"base_branch":"main","created_at":"2026-01-02T00:00:00+00:00",'
            '"updated_at":"2026-01-02T00:00:00+00:00"}',
            "--task-ids-json",
            '["task-1", "missing-task"]',
            expect_success=False,
        )
        assert atomic_failure["ok"] is False
        assert run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--read-only",
            "SELECT COUNT(*) AS count FROM pull_requests "
            "WHERE id='pr-atomic-failure'",
        )["rows"] == [{"count": 0}]

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
            '{"id":"deployment-1","head":"deployment-merge",'
            '"verified":"2026-01-03T00:00:00+00:00"}',
            "INSERT INTO deployments("
            "id, product_id, environment, head_sha, status, created_at, "
            "updated_at, verified_at"
            ") VALUES ("
            ":id, 'sample', 'production', :head, 'verified', :verified, "
            ":verified, :verified"
            ")",
        )

        mismatched_coverage = run(
            agents_home,
            "pull-request-deployment-upsert",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Reject mismatched PR deployment coverage",
            "--pull-request-id",
            "pr-deployed",
            "--environment",
            "production",
            "--deployment-id",
            "deployment-1",
            "--deployed-head-sha",
            "unrelated-head",
            "--status",
            "passed",
            expect_success=False,
        )
        assert "current pull request head" in mismatched_coverage["error"]

        for deployment_id, deployment_status, verified_at in (
            ("deployment-pending", "pending", "2026-01-03T00:00:00+00:00"),
            ("deployment-failed", "failed", "2026-01-03T00:00:00+00:00"),
            ("deployment-unverified", "verified", None),
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
                "Create invalid deployment coverage fixture",
                "--params-json",
                json.dumps(
                    {
                        "id": deployment_id,
                        "status": deployment_status,
                        "verified_at": verified_at,
                        "now": "2026-01-03T00:00:00+00:00",
                    }
                ),
                "INSERT INTO deployments("
                "id, product_id, environment, head_sha, status, created_at, "
                "updated_at, verified_at"
                ") VALUES ("
                ":id, 'sample', 'production', 'deployment-merge', :status, "
                ":now, :now, :verified_at)",
            )
            rejected_coverage = run(
                agents_home,
                "pull-request-deployment-upsert",
                "--product-id",
                "sample",
                "--actor",
                "coordinator-1",
                "--lease-token",
                lease_token,
                "--reason",
                "Reject invalid linked deployment",
                "--pull-request-id",
                "pr-deployed",
                "--environment",
                "production",
                "--deployment-id",
                deployment_id,
                "--deployed-head-sha",
                "pr-deployed-head",
                "--status",
                "passed",
                expect_success=False,
            )
            assert "successful verified deployment" in rejected_coverage["error"]

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
            "Seed stale PR deployment coverage",
            "--params-json",
            '{"updated":"2026-01-03T00:00:01+00:00"}',
            "INSERT INTO pull_request_deployments("
            "pull_request_id, environment, deployment_id, deployment_head_sha, "
            "deployed_head_sha, status, updated_at"
            ") VALUES ('pr-deployed', 'production', 'deployment-1', "
            "'deployment-merge', 'unrelated-head', 'passed', :updated)",
        )
        stale_relation_summary = run(
            agents_home, "summary", "--product-id", "sample"
        )
        stale_relation_awaiting = {
            row["id"]: row
            for row in stale_relation_summary["merged_awaiting_deployment"]
        }
        assert stale_relation_awaiting["pr-deployed"][
            "deployment_coverage_statuses"
        ] == {"production": "stale"}

        coverage = run(
            agents_home,
            "pull-request-deployment-upsert",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token-env",
            "COORDINATOR_LEASE_TOKEN",
            "--reason",
            "Record PR deployment coverage",
            "--pull-request-id",
            "pr-deployed",
            "--environment",
            "production",
            "--deployment-id",
            "deployment-1",
            "--deployed-head-sha",
            "pr-deployed-head",
            "--status",
            "passed",
            environment={"COORDINATOR_LEASE_TOKEN": lease_token},
        )
        assert coverage["status"] == "passed"

        initial_deployment_summary = run(
            agents_home, "summary", "--product-id", "sample"
        )
        assert [row["id"] for row in initial_deployment_summary["fully_deployed"]] == [
            "pr-deployed"
        ]
        assert run(
            agents_home,
            "sql",
            "--product-id",
            "sample",
            "--read-only",
            "SELECT deployment_head_sha, deployed_head_sha "
            "FROM pull_request_deployments WHERE pull_request_id='pr-deployed'",
        )["rows"] == [
            {
                "deployment_head_sha": "deployment-merge",
                "deployed_head_sha": "pr-deployed-head",
            }
        ]
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
            "Change linked deployment head",
            "--params-json",
            '{"head":"changed-deployment-merge"}',
            "UPDATE deployments SET head_sha=:head WHERE id='deployment-1'",
        )
        changed_head_summary = run(
            agents_home, "summary", "--product-id", "sample"
        )
        changed_head_awaiting = {
            row["id"]: row
            for row in changed_head_summary["merged_awaiting_deployment"]
        }
        assert changed_head_awaiting["pr-deployed"][
            "deployment_coverage_statuses"
        ] == {"production": "invalid"}
        assert changed_head_summary["fully_deployed"] == []
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
            "Restore linked deployment head",
            "--params-json",
            '{"head":"deployment-merge"}',
            "UPDATE deployments SET head_sha=:head WHERE id='deployment-1'",
        )
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
            "Invalidate linked deployment",
            "--params-json",
            '{"status":"failed"}',
            "UPDATE deployments SET status=:status, verified_at=NULL "
            "WHERE id='deployment-1'",
        )
        failed_deployment_summary = run(
            agents_home, "summary", "--product-id", "sample"
        )
        failed_deployment_awaiting = {
            row["id"]: row
            for row in failed_deployment_summary["merged_awaiting_deployment"]
        }
        assert failed_deployment_awaiting["pr-deployed"][
            "deployment_coverage_statuses"
        ] == {"production": "invalid"}
        assert failed_deployment_summary["fully_deployed"] == []
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
            "Restore verified deployment",
            "--params-json",
            '{"status":"verified","verified":"2026-01-03T00:00:00+00:00"}',
            "UPDATE deployments SET status=:status, verified_at=:verified "
            "WHERE id='deployment-1'",
        )

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
            "Record later sequential merged PR",
            "--params-json",
            '{"now":"2026-01-04T00:00:00+00:00"}',
            "INSERT INTO pull_requests("
            "id, product_id, task_id, number, branch, base_branch, head_sha, "
            "state, created_at, updated_at"
            ") VALUES ("
            "'pr-sequential-later', 'sample', 'task-1', 12, "
            "'feature/later', 'main', 'later-head', 'merged', :now, :now"
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
        awaiting_by_id = {
            row["id"]: row for row in summary["merged_awaiting_deployment"]
        }
        assert set(awaiting_by_id) == {"pr-awaiting", "pr-sequential-later"}
        assert awaiting_by_id["pr-awaiting"]["task_ids"] == ["task-2"]
        assert awaiting_by_id["pr-awaiting"]["deployment_gate_statuses"] == {
            "task-2": "pending",
        }
        assert awaiting_by_id["pr-awaiting"]["deployment_coverage_statuses"] == {
            "production": "missing"
        }
        assert awaiting_by_id["pr-sequential-later"]["deployment_coverage_statuses"] == {
            "production": "missing"
        }
        assert [row["id"] for row in summary["fully_deployed"]] == ["pr-deployed"]
        assert summary["fully_deployed"][0]["deployment_state"] == "fully_deployed"
        assert summary["fully_deployed"][0]["deployment_gate_statuses"] == {
            "task-1": "passed"
        }
        assert summary["fully_deployed"][0]["deployment_coverage_statuses"] == {
            "production": "passed"
        }

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
            "Advance deployed PR head",
            "--params-json",
            '{"id":"pr-deployed","head":"pr-deployed-new-head"}',
            "UPDATE pull_requests SET head_sha=:head WHERE id=:id",
        )
        stale_summary = run(agents_home, "summary", "--product-id", "sample")
        stale_awaiting = {
            row["id"]: row for row in stale_summary["merged_awaiting_deployment"]
        }
        assert stale_awaiting["pr-deployed"]["deployment_coverage_statuses"] == {
            "production": "stale"
        }
        assert stale_summary["fully_deployed"] == []

        refreshed_coverage = run(
            agents_home,
            "pull-request-deployment-upsert",
            "--product-id",
            "sample",
            "--actor",
            "coordinator-1",
            "--lease-token",
            lease_token,
            "--reason",
            "Refresh PR deployment coverage for new head",
            "--pull-request-id",
            "pr-deployed",
            "--environment",
            "production",
            "--deployment-id",
            "deployment-1",
            "--deployed-head-sha",
            "pr-deployed-new-head",
            "--status",
            "passed",
        )
        assert refreshed_coverage["status"] == "passed"
        recovered_summary = run(agents_home, "summary", "--product-id", "sample")
        assert [row["id"] for row in recovered_summary["fully_deployed"]] == [
            "pr-deployed"
        ]

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

    assert_existing_v1_opens(pre_materialized=False)
    assert_existing_v1_opens(pre_materialized=True)
    assert_legacy_fk_converges()
    assert_future_schema_refused()
    assert_reconciliation_failure_rolls_back()
    assert_existing_v1_deployment_relation_converges()
    assert_summary_consistent_snapshot()

    print("coordinator_state smoke test: passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
