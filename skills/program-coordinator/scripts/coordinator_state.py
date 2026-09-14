#!/usr/bin/env python3
"""Guarded SQLite state for the program-coordinator skill."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse


SCHEMA_VERSION = 1
CHECKPOINT_LIMIT = 5
WAL_AUTOCHECKPOINT_PAGES = 1000
PRODUCT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
RISK_CLASSES = ("low", "medium", "high", "critical")
SUCCESSFUL_DEPLOYMENT_STATUSES = frozenset(
    ("verified", "deployed", "passed", "succeeded")
)
REMINDER = (
    "Consider updating learned knowledge or user preferences if this operation "
    "revealed durable information."
)

CANONICAL_PULL_REQUESTS_TABLE_SQL = """
CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  initiative_id TEXT REFERENCES initiatives(id),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  repository_id TEXT REFERENCES repositories(id),
  number INTEGER,
  url TEXT,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  head_sha TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  stack_id TEXT REFERENCES stacks(id),
  stack_position INTEGER,
  mergeable_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository_id, number)
);
"""

PULL_REQUEST_TASKS_TABLE_SQL = """
CREATE TABLE pull_request_tasks (
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(pull_request_id, task_id)
);
"""

PULL_REQUEST_DEPLOYMENTS_TABLE_SQL = """
CREATE TABLE pull_request_deployments (
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  deployment_head_sha TEXT,
  deployed_head_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','passed','failed')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(pull_request_id, environment),
  CHECK(deployment_id IS NULL OR deployment_head_sha IS NOT NULL)
);
"""

PULL_REQUEST_TASKS_INDEX_SQL = (
    "CREATE INDEX pull_request_tasks_by_task ON pull_request_tasks(task_id);"
)
PULL_REQUEST_DEPLOYMENTS_INDEX_SQL = (
    "CREATE INDEX pull_request_deployments_by_environment "
    "ON pull_request_deployments(environment, status);"
)
PULL_REQUESTS_PRODUCT_STATE_INDEX_SQL = (
    "CREATE INDEX prs_by_product_state ON pull_requests(product_id, state);"
)

PULL_REQUEST_COLUMNS = (
    "id",
    "product_id",
    "initiative_id",
    "task_id",
    "repository_id",
    "number",
    "url",
    "branch",
    "base_branch",
    "head_sha",
    "state",
    "stack_id",
    "stack_position",
    "mergeable_state",
    "created_at",
    "updated_at",
)

SCHEMA_SQL = """
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT,
  url TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  role TEXT NOT NULL DEFAULT 'primary',
  created_at TEXT NOT NULL,
  UNIQUE(product_id, name)
);
CREATE TABLE initiatives (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','blocked','complete','deferred','cancelled')),
  phase TEXT NOT NULL CHECK(phase IN ('research','build','validate','review','merge','deploy')),
  charter_status TEXT NOT NULL DEFAULT 'draft'
    CHECK(charter_status IN ('draft','pending','approved','superseded')),
  charter_version INTEGER NOT NULL DEFAULT 1 CHECK(charter_version > 0),
  soft_time_budget_minutes INTEGER CHECK(
    soft_time_budget_minutes IS NULL OR soft_time_budget_minutes > 0
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  archived_at TEXT,
  archive_reason TEXT
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  harness TEXT,
  external INTEGER NOT NULL DEFAULT 0 CHECK(external IN (0,1)),
  managed INTEGER NOT NULL DEFAULT 1 CHECK(managed IN (0,1)),
  status TEXT NOT NULL DEFAULT 'idle',
  current_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','blocked','complete','deferred','cancelled')),
  phase TEXT NOT NULL CHECK(phase IN ('research','build','validate','review','merge','deploy')),
  risk_class TEXT NOT NULL DEFAULT 'medium'
    CHECK(risk_class IN ('low','medium','high','critical')),
  soft_time_budget_minutes INTEGER CHECK(
    soft_time_budget_minutes IS NULL OR soft_time_budget_minutes > 0
  ),
  owner_agent_id TEXT REFERENCES agents(id),
  blocker TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, depends_on_task_id),
  CHECK(task_id <> depends_on_task_id)
);
CREATE TABLE task_gates (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate TEXT NOT NULL CHECK(gate IN (
    'implementation','focused_validation','heavy_validation','evidence',
    'review','signoff','merge_approval','deployment'
  )),
  status TEXT NOT NULL CHECK(status IN (
    'not_required','pending','running','passed','failed','waived'
  )),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  approval_id TEXT REFERENCES approvals(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(task_id, gate),
  CHECK(status <> 'waived' OR approval_id IS NOT NULL)
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  repository_id TEXT REFERENCES repositories(id),
  owner_agent_id TEXT REFERENCES agents(id),
  harness TEXT,
  path TEXT NOT NULL,
  branch TEXT,
  base_sha TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  external INTEGER NOT NULL DEFAULT 0 CHECK(external IN (0,1)),
  recovery_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
__CANONICAL_PULL_REQUESTS_TABLE__
__PULL_REQUEST_TASKS_TABLE__
CREATE TABLE stacks (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  trunk_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK(state IN ('active','merged','dissolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE review_rounds (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK(round_number > 0),
  reviewer_agent_id TEXT NOT NULL REFERENCES agents(id),
  head_sha TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('passed','changes_requested','blocked')),
  findings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(findings_json)),
  completed_at TEXT NOT NULL,
  UNIQUE(pull_request_id, round_number)
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  executable_hash TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(scope_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','consumed','expired','revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  consumed_at TEXT,
  CHECK((status = 'consumed' AND consumed_at IS NOT NULL) OR status <> 'consumed')
);
CREATE TABLE resource_leases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  resource_class TEXT NOT NULL
    CHECK(resource_class IN ('light','medium','heavy','review','deploy')),
  holder_agent_id TEXT REFERENCES agents(id),
  status TEXT NOT NULL CHECK(status IN ('active','released','expired')),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
);
CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  initiative_id TEXT REFERENCES initiatives(id),
  environment TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  plan_hash TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT
);
__PULL_REQUEST_DEPLOYMENTS_TABLE__
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  initiative_id TEXT REFERENCES initiatives(id),
  task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  sha256 TEXT,
  media_type TEXT,
  verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  initiative_id TEXT REFERENCES initiatives(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','superseded')),
  supersedes_id TEXT REFERENCES decisions(id),
  created_at TEXT NOT NULL
);
CREATE TABLE knowledge_entries (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('candidate','active','superseded')),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
  supersedes_id TEXT REFERENCES knowledge_entries(id),
  created_at TEXT NOT NULL
);
CREATE TABLE preference_entries (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  body TEXT NOT NULL,
  explicit INTEGER NOT NULL CHECK(explicit IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('candidate','active','superseded')),
  source_event_id TEXT,
  supersedes_id TEXT REFERENCES preference_entries(id),
  created_at TEXT NOT NULL
);
CREATE TABLE coordinator_leases (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  holder_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  initiative_id TEXT REFERENCES initiatives(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  risk_class TEXT NOT NULL CHECK(risk_class IN ('low','medium','high','critical')),
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  correlation_id TEXT
);
CREATE TRIGGER events_no_update
BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete
BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER approvals_identity_immutable
BEFORE UPDATE ON approvals
WHEN OLD.action IS NOT NEW.action
  OR OLD.target_type IS NOT NEW.target_type
  OR OLD.target_id IS NOT NEW.target_id
  OR OLD.executable_hash IS NOT NEW.executable_hash
  OR OLD.scope_json IS NOT NEW.scope_json
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.expires_at IS NOT NEW.expires_at
BEGIN SELECT RAISE(ABORT, 'approval identity is immutable'); END;
CREATE TRIGGER approvals_terminal
BEFORE UPDATE ON approvals
WHEN OLD.status IN ('consumed','expired','revoked')
BEGIN SELECT RAISE(ABORT, 'terminal approval cannot change'); END;
CREATE INDEX tasks_by_initiative_state ON tasks(initiative_id, state);
CREATE INDEX initiatives_by_product_archive ON initiatives(product_id, archived_at);
CREATE INDEX events_by_product_time ON events(product_id, occurred_at DESC);
__PULL_REQUESTS_PRODUCT_STATE_INDEX__
__PULL_REQUEST_TASKS_INDEX__
__PULL_REQUEST_DEPLOYMENTS_INDEX__
""".replace(
    "__CANONICAL_PULL_REQUESTS_TABLE__", CANONICAL_PULL_REQUESTS_TABLE_SQL
).replace(
    "__PULL_REQUEST_TASKS_TABLE__", PULL_REQUEST_TASKS_TABLE_SQL
).replace(
    "__PULL_REQUEST_DEPLOYMENTS_TABLE__", PULL_REQUEST_DEPLOYMENTS_TABLE_SQL
).replace(
    "__PULL_REQUESTS_PRODUCT_STATE_INDEX__", PULL_REQUESTS_PRODUCT_STATE_INDEX_SQL
).replace(
    "__PULL_REQUEST_TASKS_INDEX__", PULL_REQUEST_TASKS_INDEX_SQL
).replace(
    "__PULL_REQUEST_DEPLOYMENTS_INDEX__", PULL_REQUEST_DEPLOYMENTS_INDEX_SQL
)

# Entries are applied in version order. Version 1 is intentionally rerunnable:
# it repairs databases created earlier in this skill's v1 lifetime. A future
# schema version adds one entry here and is applied only when history is behind.
def make_idempotent_ddl(sql: str) -> str:
    leading_whitespace = sql[: len(sql) - len(sql.lstrip())]
    normalized_sql = sql.lstrip()
    for statement_type in ("TABLE", "INDEX"):
        prefix = f"CREATE {statement_type} "
        if normalized_sql.startswith(prefix):
            return leading_whitespace + normalized_sql.replace(
                prefix, f"CREATE {statement_type} IF NOT EXISTS ", 1
            )
    raise ValueError(f"unsupported schema DDL: {sql}")


SCHEMA_MIGRATION_STEPS: dict[int, tuple[str, ...]] = {
    1: (
        make_idempotent_ddl(PULL_REQUEST_TASKS_TABLE_SQL),
        make_idempotent_ddl(PULL_REQUEST_TASKS_INDEX_SQL),
        make_idempotent_ddl(PULL_REQUEST_DEPLOYMENTS_TABLE_SQL),
        make_idempotent_ddl(PULL_REQUEST_DEPLOYMENTS_INDEX_SQL),
        make_idempotent_ddl(PULL_REQUESTS_PRODUCT_STATE_INDEX_SQL),
        """
        INSERT OR IGNORE INTO pull_request_tasks(
          pull_request_id, task_id, created_at
        )
        SELECT id, task_id, updated_at
        FROM pull_requests
        WHERE task_id IS NOT NULL
        """,
    ),
}


class StateError(RuntimeError):
    """Expected coordinator state failure."""


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def parse_time(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value)
    return (
        parsed.replace(tzinfo=dt.timezone.utc)
        if parsed.tzinfo is None
        else parsed.astimezone(dt.timezone.utc)
    )


def emit(payload: dict[str, Any]) -> None:
    payload.setdefault("reminders", [REMINDER])
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str))


def get_agents_home() -> Path:
    configured = os.environ.get("AGENTS_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".agents"


def validate_product_id(product_id: str) -> str:
    if not PRODUCT_ID_PATTERN.fullmatch(product_id):
        raise StateError("product-id must match [a-z0-9][a-z0-9._-]{0,127}")
    return product_id


def get_product_root(product_id: str) -> Path:
    return get_agents_home() / "projects" / validate_product_id(product_id)


def get_registry_path() -> Path:
    return get_agents_home() / "projects" / "index.json"


def get_database_path(product_id: str) -> Path:
    return get_product_root(product_id) / "state.sqlite"


def get_checkpoints_root(product_id: str) -> Path:
    return get_product_root(product_id) / "checkpoints"


def secure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)


@contextlib.contextmanager
def product_lock(product_id: str) -> Iterator[None]:
    lock_directory = get_product_root(product_id) / "locks"
    secure_directory(lock_directory)
    lock_path = lock_directory / "state.lock"
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        lock_path.chmod(0o600)
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


@contextlib.contextmanager
def registry_lock() -> Iterator[None]:
    projects_directory = get_agents_home() / "projects"
    secure_directory(projects_directory)
    lock_path = projects_directory / ".index.lock"
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        lock_path.chmod(0o600)
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


class ReadOnlySnapshotConnection(sqlite3.Connection):
    snapshot_directory: Path | None = None

    def close(self) -> None:
        snapshot_directory = self.snapshot_directory
        self.snapshot_directory = None
        try:
            super().close()
        finally:
            if snapshot_directory is not None:
                shutil.rmtree(snapshot_directory, ignore_errors=True)

    def __exit__(self, *args: Any) -> bool | None:
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def create_read_only_snapshot(database_path: Path) -> tuple[Path, Path]:
    # Opening a live WAL database read-only can create or update its -shm file.
    # Copy the main database and WAL first; only the disposable copy is opened.
    snapshot_directory = Path(tempfile.mkdtemp(prefix="program-coordinator-read-"))
    snapshot_database = snapshot_directory / database_path.name
    try:
        shutil.copyfile(database_path, snapshot_database)
        wal_path = database_path.with_name(f"{database_path.name}-wal")
        if wal_path.exists():
            shutil.copyfile(
                wal_path,
                snapshot_database.with_name(f"{snapshot_database.name}-wal"),
            )
    except BaseException:
        shutil.rmtree(snapshot_directory, ignore_errors=True)
        raise
    return snapshot_database, snapshot_directory


def connect(product_id: str, *, read_only: bool = False) -> sqlite3.Connection:
    database_path = get_database_path(product_id)
    if not database_path.exists():
        raise StateError(f"state does not exist: {database_path}")
    if read_only:
        snapshot_database, snapshot_directory = create_read_only_snapshot(
            database_path
        )
        connection: ReadOnlySnapshotConnection | None = None
        try:
            connection = sqlite3.connect(
                f"file:{snapshot_database}?mode=ro",
                uri=True,
                factory=ReadOnlySnapshotConnection,
            )
            connection.snapshot_directory = snapshot_directory
            connection.execute("PRAGMA query_only = ON")
        except BaseException:
            if connection is not None:
                connection.close()
            else:
                shutil.rmtree(snapshot_directory, ignore_errors=True)
            raise
    else:
        connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    if not read_only:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        connection.execute(f"PRAGMA wal_autocheckpoint = {WAL_AUTOCHECKPOINT_PAGES}")
        connection.execute("PRAGMA journal_size_limit = 16777216")
    return connection


def read_schema_versions(connection: sqlite3.Connection) -> list[int]:
    return [
        row[0]
        for row in connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        )
    ]


def pull_request_fk_is_canonical(connection: sqlite3.Connection) -> bool:
    return any(
        row["table"] == "tasks"
        and row["from"] == "task_id"
        and row["to"] == "id"
        and row["on_delete"].upper() == "SET NULL"
        for row in connection.execute("PRAGMA foreign_key_list('pull_requests')")
    )


def schema_reconciliation_plan(product_id: str) -> bool:
    with connect(product_id, read_only=True) as connection:
        versions = read_schema_versions(connection)
        validate_schema_history(versions)
        return not pull_request_fk_is_canonical(connection)


@contextlib.contextmanager
def schema_reconciliation_mode(
    connection: sqlite3.Connection, *, rebuild_pull_requests: bool
) -> Iterator[None]:
    if rebuild_pull_requests:
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.execute("PRAGMA legacy_alter_table = ON")
    try:
        yield
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    finally:
        if rebuild_pull_requests:
            connection.execute("PRAGMA legacy_alter_table = OFF")
            connection.execute("PRAGMA foreign_keys = ON")


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def rebuild_pull_requests_table(connection: sqlite3.Connection) -> None:
    old_table_name = "pull_requests_before_v1_reconciliation"
    if connection.execute(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",
        (old_table_name,),
    ).fetchone():
        raise StateError(f"temporary schema table already exists: {old_table_name}")
    indexes = connection.execute(
        "SELECT name, sql FROM sqlite_schema "
        "WHERE type='index' AND tbl_name='pull_requests' AND sql IS NOT NULL"
    ).fetchall()
    for index in indexes:
        connection.execute(f"DROP INDEX {quote_identifier(index['name'])}")
    connection.execute(
        f"ALTER TABLE pull_requests RENAME TO {quote_identifier(old_table_name)}"
    )
    connection.execute(CANONICAL_PULL_REQUESTS_TABLE_SQL)
    columns = ", ".join(PULL_REQUEST_COLUMNS)
    connection.execute(
        f"INSERT INTO pull_requests({columns}) "
        f"SELECT {columns} FROM {quote_identifier(old_table_name)}"
    )
    connection.execute(f"DROP TABLE {quote_identifier(old_table_name)}")
    for index in indexes:
        connection.execute(index["sql"])


def assert_foreign_key_integrity(connection: sqlite3.Connection) -> None:
    violations = [dict(row) for row in connection.execute("PRAGMA foreign_key_check")]
    if violations:
        raise StateError(f"foreign key violations after reconciliation: {violations}")


def validate_schema_history(versions: list[int]) -> None:
    if not versions:
        raise StateError("schema migration history is empty")
    newer_versions = [version for version in versions if version > SCHEMA_VERSION]
    if newer_versions:
        raise StateError(
            "schema contains unsupported newer versions: "
            f"{newer_versions} (current: {SCHEMA_VERSION})"
        )
    unknown_versions = [
        version for version in versions if version not in SCHEMA_MIGRATION_STEPS
    ]
    if unknown_versions:
        raise StateError(
            "schema migration history contains unknown versions: "
            f"{unknown_versions}"
        )
    expected_history = list(range(1, versions[-1] + 1))
    if versions != expected_history:
        raise StateError(f"schema migration history is inconsistent: {versions}")
    if versions[-1] < SCHEMA_VERSION:
        missing_versions = list(range(versions[-1] + 1, SCHEMA_VERSION + 1))
        if any(version not in SCHEMA_MIGRATION_STEPS for version in missing_versions):
            raise StateError(
                "schema migration history has no registered steps for: "
                f"{missing_versions}"
            )


def apply_schema_migration_steps(
    connection: sqlite3.Connection, applied_versions: list[int]
) -> list[int]:
    registered_versions = sorted(SCHEMA_MIGRATION_STEPS)
    unsupported_registry_versions = [
        version
        for version in registered_versions
        if version < 1 or version > SCHEMA_VERSION
    ]
    if unsupported_registry_versions:
        raise StateError(
            "schema migration registry contains unsupported versions: "
            f"{unsupported_registry_versions}"
        )
    highest_applied = applied_versions[-1] if applied_versions else 0
    pending_versions = list(range(highest_applied + 1, SCHEMA_VERSION + 1))
    missing_steps = [
        version
        for version in pending_versions
        if version not in SCHEMA_MIGRATION_STEPS
    ]
    if missing_steps:
        raise StateError(
            "schema migration registry missing versions: " f"{missing_steps}"
        )

    executed_versions: list[int] = []
    for version in registered_versions:
        if version > SCHEMA_VERSION:
            break
        # v1 is a compatibility reconciliation and must run even after v1 was
        # recorded. Future entries run once, when absent from history.
        if version != 1 and version in applied_versions:
            continue
        executed_versions.append(version)
        for statement in SCHEMA_MIGRATION_STEPS[version]:
            connection.execute(statement)
        if version in pending_versions:
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, now()),
            )
    return executed_versions


def reconcile_pull_request_deployment_relation(
    connection: sqlite3.Connection,
) -> bool:
    table_exists = connection.execute(
        "SELECT 1 FROM sqlite_schema WHERE type='table' "
        "AND name='pull_request_deployments'"
    ).fetchone()
    if table_exists is None:
        return False
    columns = {
        row["name"] for row in connection.execute(
            "PRAGMA table_info('pull_request_deployments')"
        )
    }
    if "deployment_head_sha" in columns:
        return False
    connection.execute(
        "ALTER TABLE pull_request_deployments ADD COLUMN deployment_head_sha TEXT"
    )
    connection.execute(
        """
        UPDATE pull_request_deployments
        SET deployment_head_sha = (
          SELECT deployments.head_sha
          FROM deployments
          WHERE deployments.id = pull_request_deployments.deployment_id
        )
        WHERE deployment_id IS NOT NULL
        """
    )
    return True


def reconcile_schema_in_transaction(
    connection: sqlite3.Connection,
    product_id: str,
    *,
    rebuild_pull_requests: bool = False,
) -> dict[str, Any]:
    versions = read_schema_versions(connection)
    validate_schema_history(versions)
    if rebuild_pull_requests:
        rebuild_pull_requests_table(connection)
    schema_objects_before = {
        (row[0], row[1])
        for row in connection.execute(
            "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
        )
    }
    changes_before = connection.total_changes
    processed_versions = apply_schema_migration_steps(connection, versions)
    deployment_relation_changed = reconcile_pull_request_deployment_relation(
        connection
    )
    changes = connection.total_changes - changes_before
    schema_objects_after = {
        (row[0], row[1])
        for row in connection.execute(
            "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
        )
    }
    schema_objects_changed = (
        schema_objects_before != schema_objects_after or deployment_relation_changed
    )
    event_id: str | None = None
    if changes or schema_objects_changed or rebuild_pull_requests:
        event_id = add_event(
            connection,
            product_id=product_id,
            actor_id="schema-reconciler",
            action="state.schema_reconciled",
            risk="low",
            reason="Reconcile current coordinator schema under product lock",
            target_type="product",
            target_id=product_id,
            payload={
                "schema_version": SCHEMA_VERSION,
                "processed_versions": processed_versions,
                "database_changes": changes,
                "schema_objects_changed": schema_objects_changed,
                "pull_requests_fk_rebuilt": rebuild_pull_requests,
                "deployment_relation_materialized": deployment_relation_changed,
            },
        )
    return {
        "schema_versions": read_schema_versions(connection),
        "processed_versions": processed_versions,
        "database_changes": changes,
        "schema_objects_changed": schema_objects_changed,
        "pull_requests_fk_rebuilt": rebuild_pull_requests,
        "event_id": event_id,
    }


def reconcile_schema_for_lease(
    product_id: str, holder: str, lease_token: str
) -> dict[str, Any]:
    with product_lock(product_id):
        rebuild_pull_requests = schema_reconciliation_plan(product_id)
        with connect(product_id) as connection:
            validate_lease(connection, product_id, holder, lease_token)
            with schema_reconciliation_mode(
                connection, rebuild_pull_requests=rebuild_pull_requests
            ):
                connection.execute("BEGIN IMMEDIATE")
                validate_lease(connection, product_id, holder, lease_token)
                result = reconcile_schema_in_transaction(
                    connection,
                    product_id,
                    rebuild_pull_requests=rebuild_pull_requests,
                )
                assert_foreign_key_integrity(connection)
                connection.commit()
                return result


def validate_schema_read_only(product_id: str) -> None:
    with product_lock(product_id):
        with connect(product_id, read_only=True) as connection:
            validate_schema_history(read_schema_versions(connection))


def schema_reconcile_command(args: argparse.Namespace) -> None:
    result = reconcile_schema_for_lease(
        args.product_id, args.holder, resolve_lease_token(args)
    )
    emit({"ok": True, **result})


def write_json(path: Path, payload: Any) -> None:
    secure_directory(path.parent)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as temporary_file:
            json.dump(payload, temporary_file, ensure_ascii=False, indent=2, sort_keys=True)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        temporary_path.chmod(0o600)
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def read_registry() -> dict[str, Any]:
    registry_path = get_registry_path()
    if not registry_path.exists():
        return {"schema_version": 1, "repositories": []}
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    if registry.get("schema_version") != 1:
        raise StateError("unsupported project registry schema")
    if not isinstance(registry.get("repositories"), list):
        raise StateError("project registry repositories must be a list")
    return registry


def normalize_remote_url(remote_url: str) -> str:
    value = remote_url.strip()
    if not value:
        raise StateError("remote URL must not be empty")
    scp_match = re.fullmatch(r"(?:[^@/]+@)?([^:/]+):(.+)", value)
    if scp_match and "://" not in value:
        host = scp_match.group(1).lower()
        repository_path = scp_match.group(2)
    else:
        parsed = urlparse(value)
        if parsed.scheme == "file":
            return f"file:{Path(parsed.path).expanduser().resolve()}"
        if not parsed.hostname:
            return f"file:{Path(value).expanduser().resolve()}"
        host = parsed.hostname.lower()
        if parsed.port:
            host = f"{host}:{parsed.port}"
        repository_path = parsed.path
    repository_path = repository_path.strip("/")
    if repository_path.endswith(".git"):
        repository_path = repository_path[:-4]
    if not repository_path:
        raise StateError("remote URL has no repository path")
    if host == "github.com":
        repository_path = repository_path.lower()
    return f"{host}/{repository_path}"


def run_git(repository_path: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=repository_path,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise StateError(completed.stderr.strip() or "git command failed")
    return completed.stdout.strip()


def inspect_repository(
    repository_path: str, explicit_remote_url: str | None = None
) -> dict[str, str | None]:
    requested_path = Path(repository_path).expanduser().resolve()
    if not requested_path.exists():
        raise StateError(f"repository path does not exist: {requested_path}")
    worktree_root = Path(
        run_git(requested_path, "rev-parse", "--show-toplevel")
    ).resolve()
    common_directory_raw = run_git(requested_path, "rev-parse", "--git-common-dir")
    common_directory = Path(common_directory_raw)
    if not common_directory.is_absolute():
        common_directory = (requested_path / common_directory).resolve()
    remote_url = explicit_remote_url
    if remote_url is None:
        remote_result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=worktree_root,
            check=False,
            capture_output=True,
            text=True,
        )
        remote_url = remote_result.stdout.strip() if remote_result.returncode == 0 else None
    return {
        "worktree_root": str(worktree_root),
        "git_common_dir": str(common_directory),
        "remote": normalize_remote_url(remote_url) if remote_url else None,
    }


def registry_matches(
    entry: dict[str, Any], repository: dict[str, str | None]
) -> bool:
    remote = repository["remote"]
    return bool(
        (remote and entry.get("remote") == remote)
        or repository["git_common_dir"] in entry.get("git_common_dirs", [])
        or repository["worktree_root"] in entry.get("paths", [])
    )


def append_failure(product_id: str, payload: dict[str, Any]) -> None:
    failure_path = get_product_root(product_id) / "failed-events.jsonl"
    secure_directory(failure_path.parent)
    file_descriptor = os.open(
        failure_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
    )
    with os.fdopen(file_descriptor, "a", encoding="utf-8") as failure_file:
        failure_file.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
        failure_file.flush()
        os.fsync(failure_file.fileno())


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prune_checkpoints(
    product_id: str, *, protected_ids: set[str] | None = None
) -> list[str]:
    checkpoints_root = get_checkpoints_root(product_id)
    checkpoints = sorted(
        (path for path in checkpoints_root.iterdir() if path.is_dir()),
        key=lambda path: path.name,
        reverse=True,
    )
    protected_ids = protected_ids or set()
    retained = checkpoints[:CHECKPOINT_LIMIT]
    for checkpoint in checkpoints[CHECKPOINT_LIMIT:]:
        if checkpoint.name in protected_ids:
            retained.append(checkpoint)
    while len(retained) > CHECKPOINT_LIMIT:
        removable_index = next(
            (
                index
                for index in range(len(retained) - 1, -1, -1)
                if retained[index].name not in protected_ids
            ),
            None,
        )
        if removable_index is None:
            break
        retained.pop(removable_index)
    retained_ids = {checkpoint.name for checkpoint in retained}
    removed: list[str] = []
    for expired_checkpoint in checkpoints:
        if expired_checkpoint.name not in retained_ids:
            shutil.rmtree(expired_checkpoint)
            removed.append(expired_checkpoint.name)
    return removed


def create_checkpoint_locked(
    product_id: str,
    *,
    reason: str,
    trigger: str,
    actor: str,
    protected_ids: set[str] | None = None,
) -> dict[str, Any]:
    checkpoints_root = get_checkpoints_root(product_id)
    secure_directory(checkpoints_root)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    checkpoint_id = f"{timestamp}-{secrets.token_hex(4)}"
    checkpoint_directory = checkpoints_root / checkpoint_id
    secure_directory(checkpoint_directory)
    checkpoint_database = checkpoint_directory / "state.sqlite"
    temporary_database = checkpoint_directory / ".state.sqlite.tmp"
    try:
        with connect(product_id, read_only=True) as source_connection:
            destination_connection = sqlite3.connect(temporary_database)
            try:
                source_connection.backup(destination_connection)
            finally:
                destination_connection.close()
        temporary_database.chmod(0o600)
        temporary_database.replace(checkpoint_database)
        project_config_path = get_product_root(product_id) / "project.json"
        if project_config_path.exists():
            write_json(
                checkpoint_directory / "project.json",
                json.loads(project_config_path.read_text(encoding="utf-8")),
            )
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "product_id": product_id,
            "checkpoint_id": checkpoint_id,
            "created_at": now(),
            "actor": actor,
            "reason": reason,
            "trigger": trigger,
            "database_sha256": file_sha256(checkpoint_database),
        }
        write_json(checkpoint_directory / "manifest.json", manifest)
    except Exception:
        shutil.rmtree(checkpoint_directory, ignore_errors=True)
        raise
    removed = prune_checkpoints(product_id, protected_ids=protected_ids)
    return {
        "checkpoint_id": checkpoint_id,
        "checkpoint_directory": str(checkpoint_directory),
        "removed_checkpoints": removed,
    }


def sql_requires_checkpoint(sql: str, risk: str) -> bool:
    first_token_match = re.match(r"\s*(?:--[^\n]*\n\s*)*([A-Za-z]+)", sql)
    first_token = first_token_match.group(1).upper() if first_token_match else ""
    return risk in {"high", "critical"} or first_token in {"DELETE", "REPLACE"}


def add_event(
    connection: sqlite3.Connection,
    *,
    product_id: str,
    actor_id: str,
    action: str,
    risk: str,
    reason: str,
    target_type: str | None = None,
    target_id: str | None = None,
    initiative_id: str | None = None,
    correlation_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> str:
    event_id = secrets.token_hex(16)
    connection.execute(
        """
        INSERT INTO events (
          id, product_id, occurred_at, actor_type, actor_id, initiative_id,
          action, target_type, target_id, risk_class, reason, payload_json,
          correlation_id
        ) VALUES (?, ?, ?, 'coordinator', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id,
            product_id,
            now(),
            actor_id,
            initiative_id,
            action,
            target_type,
            target_id,
            risk,
            reason,
            json.dumps(payload or {}, ensure_ascii=False, sort_keys=True),
            correlation_id,
        ),
    )
    return event_id


def initialize(args: argparse.Namespace) -> None:
    root = get_product_root(args.product_id)
    if get_database_path(args.product_id).exists():
        raise StateError(f"product already initialized: {args.product_id}")
    with product_lock(args.product_id):
        for directory in (
            root,
            root / "initiatives",
            root / "artifacts",
            root / "exports",
            root / "checkpoints",
            root / "locks",
        ):
            secure_directory(directory)
        connection = sqlite3.connect(get_database_path(args.product_id))
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            connection.execute(
                f"PRAGMA wal_autocheckpoint = {WAL_AUTOCHECKPOINT_PAGES}"
            )
            connection.execute("PRAGMA journal_size_limit = 16777216")
            connection.executescript(SCHEMA_SQL)
            apply_schema_migration_steps(connection, [])
            timestamp = now()
            connection.execute(
                "INSERT INTO products(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (args.product_id, args.name, timestamp, timestamp),
            )
            event_id = add_event(
                connection,
                product_id=args.product_id,
                actor_id=args.actor,
                action="product.initialized",
                risk="low",
                reason="Initialize coordinator state",
                target_type="product",
                target_id=args.product_id,
                payload={"schema_version": SCHEMA_VERSION},
            )
            connection.commit()
        finally:
            connection.close()
        get_database_path(args.product_id).chmod(0o600)
        write_json(
            root / "project.json",
            {
                "schema_version": SCHEMA_VERSION,
                "product_id": args.product_id,
                "name": args.name,
                "repositories": [],
                "limits": {
                    "max_active_workers": 6,
                    "max_heavy_jobs": 1,
                    "max_reviewers": 2,
                    "max_workers_per_initiative": 3,
                    "max_stack_depth": 4,
                    "max_review_rounds": 3,
                    "soft_time_budget_minutes": None,
                    "fallback_heartbeat_minutes": 10,
                },
            },
        )
    emit(
        {
            "ok": True,
            "product_id": args.product_id,
            "root": str(root),
            "database": str(get_database_path(args.product_id)),
            "event_id": event_id,
        }
    )


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def resolve_lease_token(args: argparse.Namespace) -> str:
    lease_token = getattr(args, "lease_token", None)
    if lease_token:
        return lease_token
    environment_name = getattr(args, "lease_token_env", None)
    if environment_name:
        lease_token = os.environ.get(environment_name)
        if lease_token:
            return lease_token
        raise StateError(
            f"lease token environment variable is empty: {environment_name}"
        )
    raise StateError("--lease-token or --lease-token-env is required")


def validate_lease(
    connection: sqlite3.Connection, product_id: str, holder: str, token: str
) -> None:
    lease = connection.execute(
        "SELECT holder_id, token_hash, expires_at FROM coordinator_leases "
        "WHERE product_id = ?",
        (product_id,),
    ).fetchone()
    if lease is None:
        raise StateError("no active coordinator lease")
    if lease["holder_id"] != holder:
        raise StateError(f"coordinator lease belongs to {lease['holder_id']}")
    if not secrets.compare_digest(lease["token_hash"], token_hash(token)):
        raise StateError("invalid coordinator lease token")
    if parse_time(lease["expires_at"]) <= dt.datetime.now(dt.timezone.utc):
        raise StateError("coordinator lease expired")


def acquire_lease(args: argparse.Namespace) -> None:
    if args.ttl_seconds <= 0:
        raise StateError("--ttl-seconds must be positive")
    lease_token = secrets.token_hex(32)
    acquired_at = dt.datetime.now(dt.timezone.utc)
    expires_at = acquired_at + dt.timedelta(seconds=args.ttl_seconds)
    with product_lock(args.product_id):
        rebuild_pull_requests = schema_reconciliation_plan(args.product_id)
        with connect(args.product_id) as connection:
            with schema_reconciliation_mode(
                connection, rebuild_pull_requests=rebuild_pull_requests
            ):
                connection.execute("BEGIN IMMEDIATE")
                existing = connection.execute(
                    "SELECT holder_id, expires_at FROM coordinator_leases "
                    "WHERE product_id = ?",
                    (args.product_id,),
                ).fetchone()
                if existing and parse_time(existing["expires_at"]) > acquired_at:
                    raise StateError(
                        f"active coordinator lease held by {existing['holder_id']} "
                        f"until {existing['expires_at']}"
                    )
                reconcile_schema_in_transaction(
                    connection,
                    args.product_id,
                    rebuild_pull_requests=rebuild_pull_requests,
                )
                assert_foreign_key_integrity(connection)
                connection.execute(
                    """
                    INSERT INTO coordinator_leases(
                      product_id, holder_id, token_hash, acquired_at, expires_at
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(product_id) DO UPDATE SET
                      holder_id=excluded.holder_id,
                      token_hash=excluded.token_hash,
                      acquired_at=excluded.acquired_at,
                      expires_at=excluded.expires_at
                    """,
                    (
                        args.product_id,
                        args.holder,
                        token_hash(lease_token),
                        acquired_at.isoformat(timespec="seconds"),
                        expires_at.isoformat(timespec="seconds"),
                    ),
                )
                event_id = add_event(
                    connection,
                    product_id=args.product_id,
                    actor_id=args.holder,
                    action="coordinator.lease_acquired",
                    risk="low",
                    reason="Acquire canonical coordinator writer lease",
                    target_type="product",
                    target_id=args.product_id,
                    payload={"expires_at": expires_at.isoformat(timespec="seconds")},
                )
                connection.commit()
    emit(
        {
            "ok": True,
            "holder": args.holder,
            "lease_token": lease_token,
            "expires_at": expires_at.isoformat(timespec="seconds"),
            "event_id": event_id,
        }
    )


def renew_lease(args: argparse.Namespace) -> None:
    if args.ttl_seconds <= 0:
        raise StateError("--ttl-seconds must be positive")
    lease_token = resolve_lease_token(args)
    expires_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(
        seconds=args.ttl_seconds
    )
    with product_lock(args.product_id), connect(args.product_id) as connection:
        connection.execute("BEGIN IMMEDIATE")
        validate_lease(connection, args.product_id, args.holder, lease_token)
        connection.execute(
            "UPDATE coordinator_leases SET expires_at = ? WHERE product_id = ?",
            (expires_at.isoformat(timespec="seconds"), args.product_id),
        )
        event_id = add_event(
            connection,
            product_id=args.product_id,
            actor_id=args.holder,
            action="coordinator.lease_renewed",
            risk="low",
            reason="Renew canonical coordinator writer lease",
            target_type="product",
            target_id=args.product_id,
            payload={"expires_at": expires_at.isoformat(timespec="seconds")},
        )
        connection.commit()
    emit(
        {
            "ok": True,
            "expires_at": expires_at.isoformat(timespec="seconds"),
            "event_id": event_id,
        }
    )


def release_lease(args: argparse.Namespace) -> None:
    lease_token = resolve_lease_token(args)
    with product_lock(args.product_id), connect(args.product_id) as connection:
        connection.execute("BEGIN IMMEDIATE")
        validate_lease(connection, args.product_id, args.holder, lease_token)
        connection.execute(
            "DELETE FROM coordinator_leases WHERE product_id = ?", (args.product_id,)
        )
        event_id = add_event(
            connection,
            product_id=args.product_id,
            actor_id=args.holder,
            action="coordinator.lease_released",
            risk="low",
            reason="Release canonical coordinator writer lease",
            target_type="product",
            target_id=args.product_id,
        )
        connection.commit()
    emit({"ok": True, "event_id": event_id})


def registry_upsert(args: argparse.Namespace) -> None:
    repository = inspect_repository(args.repo_path, args.remote_url)
    lease_token = resolve_lease_token(args)
    with product_lock(args.product_id), connect(args.product_id) as connection:
        validate_lease(
            connection, args.product_id, args.holder, lease_token
        )
        with registry_lock():
            registry = read_registry()
            matches = [
                entry
                for entry in registry["repositories"]
                if registry_matches(entry, repository)
            ]
            conflicting_products = {
                entry["product_id"]
                for entry in matches
                if entry["product_id"] != args.product_id
            }
            if conflicting_products:
                raise StateError(
                    "repository already belongs to product(s): "
                    + ", ".join(sorted(conflicting_products))
                )
            if matches:
                entry = matches[0]
                for duplicate in matches[1:]:
                    for key in ("paths", "git_common_dirs"):
                        entry.setdefault(key, []).extend(duplicate.get(key, []))
                    registry["repositories"].remove(duplicate)
            else:
                entry = {
                    "product_id": args.product_id,
                    "remote": repository["remote"],
                    "paths": [],
                    "git_common_dirs": [],
                    "created_at": now(),
                }
                registry["repositories"].append(entry)
            if repository["remote"]:
                entry["remote"] = repository["remote"]
            entry["paths"] = sorted(
                set(entry.get("paths", [])) | {repository["worktree_root"]}
            )
            entry["git_common_dirs"] = sorted(
                set(entry.get("git_common_dirs", []))
                | {repository["git_common_dir"]}
            )
            entry["updated_at"] = now()
            registry["repositories"].sort(
                key=lambda item: (
                    item["product_id"], item.get("remote") or "", item["paths"]
                )
            )
            write_json(get_registry_path(), registry)
        connection.execute("BEGIN IMMEDIATE")
        validate_lease(
            connection, args.product_id, args.holder, lease_token
        )
        event_id = add_event(
            connection,
            product_id=args.product_id,
            actor_id=args.holder,
            action="registry.repository_upserted",
            risk="low",
            reason=args.reason,
            target_type="repository",
            target_id=repository["remote"] or repository["git_common_dir"],
            payload=repository,
        )
        connection.commit()
    emit({"ok": True, "repository": entry, "event_id": event_id})


def registry_detect(args: argparse.Namespace) -> None:
    repository = inspect_repository(args.repo_path, args.remote_url)
    with registry_lock():
        matches = [
            entry
            for entry in read_registry()["repositories"]
            if registry_matches(entry, repository)
        ]
    product_ids = sorted({entry["product_id"] for entry in matches})
    if not product_ids:
        raise StateError("repository is not registered to a product")
    if len(product_ids) > 1:
        raise StateError(
            "repository registry is ambiguous: " + ", ".join(product_ids)
        )
    emit(
        {
            "ok": True,
            "product_id": product_ids[0],
            "repository": repository,
            "matched_by": [
                key
                for key, matched in (
                    (
                        "remote",
                        bool(
                            repository["remote"]
                            and any(
                                entry.get("remote") == repository["remote"]
                                for entry in matches
                            )
                        ),
                    ),
                    (
                        "git_common_dir",
                        any(
                            repository["git_common_dir"]
                            in entry.get("git_common_dirs", [])
                            for entry in matches
                        ),
                    ),
                    (
                        "path",
                        any(
                            repository["worktree_root"] in entry.get("paths", [])
                            for entry in matches
                        ),
                    ),
                )
                if matched
            ],
        }
    )


def registry_list(args: argparse.Namespace) -> None:
    with registry_lock():
        repositories = read_registry()["repositories"]
    if args.product_id:
        repositories = [
            entry
            for entry in repositories
            if entry["product_id"] == args.product_id
        ]
    emit({"ok": True, "repositories": repositories})


def registry_remove(args: argparse.Namespace) -> None:
    repository = inspect_repository(args.repo_path, args.remote_url)
    lease_token = resolve_lease_token(args)
    with product_lock(args.product_id), connect(args.product_id) as connection:
        validate_lease(
            connection, args.product_id, args.holder, lease_token
        )
        with registry_lock():
            registry = read_registry()
            removed = [
                entry
                for entry in registry["repositories"]
                if entry["product_id"] == args.product_id
                and registry_matches(entry, repository)
            ]
            if not removed:
                raise StateError("matching repository registration not found")
            registry["repositories"] = [
                entry for entry in registry["repositories"] if entry not in removed
            ]
            write_json(get_registry_path(), registry)
        connection.execute("BEGIN IMMEDIATE")
        validate_lease(
            connection, args.product_id, args.holder, lease_token
        )
        event_id = add_event(
            connection,
            product_id=args.product_id,
            actor_id=args.holder,
            action="registry.repository_removed",
            risk="low",
            reason=args.reason,
            target_type="repository",
            target_id=repository["remote"] or repository["git_common_dir"],
            payload={"removed": removed},
        )
        connection.commit()
    emit({"ok": True, "removed": removed, "event_id": event_id})


def forbidden_actions() -> set[int]:
    names = (
        "SQLITE_ALTER_TABLE",
        "SQLITE_ANALYZE",
        "SQLITE_ATTACH",
        "SQLITE_CREATE_INDEX",
        "SQLITE_CREATE_TABLE",
        "SQLITE_CREATE_TEMP_INDEX",
        "SQLITE_CREATE_TEMP_TABLE",
        "SQLITE_CREATE_TEMP_TRIGGER",
        "SQLITE_CREATE_TEMP_VIEW",
        "SQLITE_CREATE_TRIGGER",
        "SQLITE_CREATE_VIEW",
        "SQLITE_CREATE_VTABLE",
        "SQLITE_DETACH",
        "SQLITE_DROP_INDEX",
        "SQLITE_DROP_TABLE",
        "SQLITE_DROP_TEMP_INDEX",
        "SQLITE_DROP_TEMP_TABLE",
        "SQLITE_DROP_TEMP_TRIGGER",
        "SQLITE_DROP_TEMP_VIEW",
        "SQLITE_DROP_TRIGGER",
        "SQLITE_DROP_VIEW",
        "SQLITE_DROP_VTABLE",
        "SQLITE_PRAGMA",
        "SQLITE_REINDEX",
    )
    return {getattr(sqlite3, name) for name in names if hasattr(sqlite3, name)}


def install_guard(connection: sqlite3.Connection) -> tuple[set[str], list[bool]]:
    touched_tables: set[str] = set()
    mutation_seen = [False]
    protected_tables = {"events", "schema_migrations", "coordinator_leases"}
    mutations = {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE}
    denied = forbidden_actions()

    def authorize(
        action: int,
        argument_one: str | None,
        argument_two: str | None,
        database_name: str | None,
        trigger_name: str | None,
    ) -> int:
        del database_name, trigger_name
        if action in denied:
            return sqlite3.SQLITE_DENY
        if action in mutations:
            mutation_seen[0] = True
            if argument_one:
                touched_tables.add(argument_one)
            if argument_one in protected_tables:
                return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION and (
            argument_one == "load_extension" or argument_two == "load_extension"
        ):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    connection.set_authorizer(authorize)
    return touched_tables, mutation_seen


def parse_params(raw_params: str) -> dict[str, Any]:
    params = json.loads(raw_params)
    if not isinstance(params, dict):
        raise StateError("--params-json must decode to object")
    return params


def execute_sql(args: argparse.Namespace) -> None:
    sql = sys.stdin.read() if args.sql == "-" else args.sql
    if not sql.strip():
        raise StateError("SQL must not be empty")
    params = parse_params(args.params_json)
    statement_hash = hashlib.sha256(sql.encode()).hexdigest()

    if args.read_only:
        with connect(args.product_id, read_only=True) as connection:
            _, mutation_seen = install_guard(connection)
            cursor = connection.execute(sql, params)
            result_rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
            if mutation_seen[0]:
                raise StateError("read-only SQL attempted mutation")
        emit(
            {
                "ok": True,
                "read_only": True,
                "rows": result_rows,
                "row_count": len(result_rows),
                "statement_sha256": statement_hash,
            }
        )
        return

    if not args.reason:
        raise StateError("--reason is required for mutating SQL")
    lease_token = resolve_lease_token(args)

    failure = {
        "occurred_at": now(),
        "actor_id": args.actor,
        "action": args.action,
        "risk_class": args.risk,
        "reason": args.reason,
        "statement_sha256": statement_hash,
        "target_type": args.target_type,
        "target_id": args.target_id,
        "correlation_id": args.correlation_id,
    }
    checkpoint: dict[str, Any] | None = None
    try:
        with product_lock(args.product_id), connect(args.product_id) as connection:
            validate_lease(
                connection, args.product_id, args.actor, lease_token
            )
            if sql_requires_checkpoint(sql, args.risk):
                checkpoint = create_checkpoint_locked(
                    args.product_id,
                    reason=args.reason,
                    trigger=f"sql:{args.action}",
                    actor=args.actor,
                )
            connection.execute("BEGIN IMMEDIATE")
            validate_lease(
                connection, args.product_id, args.actor, lease_token
            )
            touched_tables, mutation_seen = install_guard(connection)
            changes_before = connection.total_changes
            cursor = connection.execute(sql, params)
            result_rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
            changed_rows = connection.total_changes - changes_before
            if not mutation_seen[0]:
                connection.rollback()
                emit(
                    {
                        "ok": True,
                        "read_only": True,
                        "rows": result_rows,
                        "row_count": len(result_rows),
                        "statement_sha256": statement_hash,
                    }
                )
                return
            connection.set_authorizer(None)
            event_id = add_event(
                connection,
                product_id=args.product_id,
                actor_id=args.actor,
                action=args.action,
                risk=args.risk,
                reason=args.reason,
                target_type=args.target_type,
                target_id=args.target_id,
                initiative_id=args.initiative_id,
                correlation_id=args.correlation_id,
                payload={
                    "statement_sha256": statement_hash,
                    "changed_rows": changed_rows,
                    "touched_tables": sorted(touched_tables),
                    "parameter_names": sorted(params),
                    "checkpoint": checkpoint,
                },
            )
            connection.commit()
        emit(
            {
                "ok": True,
                "changed_rows": changed_rows,
                "rows": result_rows,
                "event_id": event_id,
                "statement_sha256": statement_hash,
                "touched_tables": sorted(touched_tables),
                "checkpoint": checkpoint,
            }
        )
    except Exception as error:
        failure["error_type"] = type(error).__name__
        failure["error"] = str(error)
        append_failure(args.product_id, failure)
        raise


def parse_json_object(raw_value: str, argument_name: str) -> dict[str, Any]:
    value = json.loads(raw_value)
    if not isinstance(value, dict):
        raise StateError(f"{argument_name} must decode to object")
    return value


def parse_task_ids(raw_value: str) -> list[str]:
    value = json.loads(raw_value)
    if not isinstance(value, list) or any(
        not isinstance(task_id, str) or not task_id for task_id in value
    ):
        raise StateError("--task-ids-json must decode to list of non-empty strings")
    if len(set(value)) != len(value):
        raise StateError("--task-ids-json must not contain duplicates")
    return value


def parse_pull_request_request(
    args: argparse.Namespace,
) -> tuple[dict[str, Any], list[str] | None]:
    pull_request = parse_json_object(
        args.pull_request_json, "--pull-request-json"
    )
    allowed_fields = set(PULL_REQUEST_COLUMNS) - {"product_id"}
    unknown_fields = set(pull_request) - allowed_fields
    if unknown_fields:
        raise StateError(
            "--pull-request-json contains unknown fields: "
            + ", ".join(sorted(unknown_fields))
        )
    pull_request_id = pull_request.get("id")
    if not isinstance(pull_request_id, str) or not pull_request_id:
        raise StateError("--pull-request-json.id must be a non-empty string")
    requested_task_ids = (
        parse_task_ids(args.task_ids_json)
        if args.task_ids_json is not None
        else None
    )
    if "task_id" in pull_request and pull_request["task_id"] is not None:
        if not isinstance(pull_request["task_id"], str) or not pull_request["task_id"]:
            raise StateError("--pull-request-json.task_id must be null or non-empty string")
    return pull_request, requested_task_ids


def validate_pull_request_task_ids(
    connection: sqlite3.Connection, product_id: str, task_ids: list[str]
) -> None:
    if not task_ids:
        return
    placeholders = ", ".join("?" for _ in task_ids)
    valid_task_ids = {
        row["id"]
        for row in connection.execute(
            "SELECT tasks.id FROM tasks "
            "JOIN initiatives ON initiatives.id = tasks.initiative_id "
            f"WHERE initiatives.product_id = ? AND tasks.id IN ({placeholders})",
            (product_id, *task_ids),
        )
    }
    missing_task_ids = [
        task_id for task_id in task_ids if task_id not in valid_task_ids
    ]
    if missing_task_ids:
        raise StateError(
            "task(s) do not belong to product: " + ", ".join(missing_task_ids)
        )


def prepare_pull_request_values(
    connection: sqlite3.Connection,
    product_id: str,
    pull_request: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    pull_request_id = pull_request["id"]
    existing_row = connection.execute(
        "SELECT * FROM pull_requests WHERE id = ?", (pull_request_id,)
    ).fetchone()
    if existing_row is not None and existing_row["product_id"] != product_id:
        raise StateError("pull request belongs to another product")

    if existing_row is None:
        required_fields = {"branch", "base_branch", "created_at", "updated_at"}
        missing_fields = sorted(
            field for field in required_fields if not pull_request.get(field)
        )
        if missing_fields:
            raise StateError(
                "new pull request missing fields: " + ", ".join(missing_fields)
            )
        values = {
            field: pull_request.get(field)
            for field in PULL_REQUEST_COLUMNS
            if field != "product_id"
        }
        values["product_id"] = product_id
        if values["state"] is None:
            values["state"] = "open"
        existing_task_ids: list[str] = []
    else:
        values = {
            field: (
                pull_request[field]
                if field in pull_request
                else existing_row[field]
            )
            for field in PULL_REQUEST_COLUMNS
            if field != "product_id"
        }
        values["product_id"] = product_id
        existing_task_ids = [
            row["task_id"]
            for row in connection.execute(
                "SELECT task_id FROM pull_request_tasks "
                "WHERE pull_request_id = ? ORDER BY created_at, task_id",
                (pull_request_id,),
            )
        ]

    return values, existing_task_ids


def resolve_pull_request_task_links(
    pull_request: dict[str, Any],
    values: dict[str, Any],
    existing_task_ids: list[str],
    requested_task_ids: list[str] | None,
) -> list[str]:
    if requested_task_ids is None:
        task_ids = list(dict.fromkeys(existing_task_ids))
        if values.get("task_id") and values["task_id"] not in task_ids:
            task_ids.insert(0, values["task_id"])
        return task_ids

    task_ids = requested_task_ids.copy()
    requested_compatibility_task_id = pull_request.get("task_id")
    values["task_id"] = (
        requested_compatibility_task_id
        if requested_compatibility_task_id in task_ids
        else (task_ids[0] if task_ids else None)
    )
    return task_ids


def persist_pull_request(
    connection: sqlite3.Connection, values: dict[str, Any]
) -> None:
    columns = ", ".join(PULL_REQUEST_COLUMNS)
    placeholders = ", ".join("?" for _ in PULL_REQUEST_COLUMNS)
    updates = ", ".join(
        f"{field}=excluded.{field}"
        for field in PULL_REQUEST_COLUMNS
        if field not in {"id", "product_id"}
    )
    connection.execute(
        f"INSERT INTO pull_requests({columns}) VALUES ({placeholders}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates}",
        tuple(values[field] for field in PULL_REQUEST_COLUMNS),
    )


def replace_pull_request_task_links(
    connection: sqlite3.Connection,
    pull_request_id: str,
    task_ids: list[str],
    association_timestamp: str,
    *,
    replace_existing: bool,
) -> int:
    association_changes = 0
    if replace_existing:
        if task_ids:
            placeholders = ", ".join("?" for _ in task_ids)
            cursor = connection.execute(
                "DELETE FROM pull_request_tasks "
                "WHERE pull_request_id = ? "
                f"AND task_id NOT IN ({placeholders})",
                (pull_request_id, *task_ids),
            )
        else:
            cursor = connection.execute(
                "DELETE FROM pull_request_tasks WHERE pull_request_id = ?",
                (pull_request_id,),
            )
        association_changes += cursor.rowcount
    for task_id in task_ids:
        cursor = connection.execute(
            "INSERT OR IGNORE INTO pull_request_tasks("
            "pull_request_id, task_id, created_at) VALUES (?, ?, ?)",
            (pull_request_id, task_id, association_timestamp),
        )
        association_changes += cursor.rowcount
    return association_changes


def record_pull_request_upsert_event(
    connection: sqlite3.Connection,
    product_id: str,
    actor: str,
    reason: str,
    pull_request_id: str,
    initiative_id: str | None,
    task_ids: list[str],
    association_changes: int,
    *,
    replace_existing: bool,
) -> str:
    event_id = add_event(
        connection,
        product_id=product_id,
        actor_id=actor,
        action="pull_request.upserted",
        risk="low",
        reason=reason,
        target_type="pull_request",
        target_id=pull_request_id,
        initiative_id=initiative_id,
        payload={
            "task_ids": task_ids,
            "association_changes": association_changes,
            "task_link_semantics": (
                "replace" if replace_existing else "preserve"
            ),
        },
    )
    return event_id


def upsert_pull_request_in_transaction(
    connection: sqlite3.Connection,
    product_id: str,
    actor: str,
    reason: str,
    pull_request: dict[str, Any],
    requested_task_ids: list[str] | None,
) -> dict[str, Any]:
    values, existing_task_ids = prepare_pull_request_values(
        connection, product_id, pull_request
    )
    task_ids = resolve_pull_request_task_links(
        pull_request, values, existing_task_ids, requested_task_ids
    )
    validate_pull_request_task_ids(connection, product_id, task_ids)
    persist_pull_request(connection, values)
    association_changes = replace_pull_request_task_links(
        connection,
        pull_request["id"],
        task_ids,
        values["updated_at"],
        replace_existing=requested_task_ids is not None,
    )
    event_id = record_pull_request_upsert_event(
        connection,
        product_id,
        actor,
        reason,
        pull_request["id"],
        values["initiative_id"],
        task_ids,
        association_changes,
        replace_existing=requested_task_ids is not None,
    )
    return {
        "pull_request_id": pull_request["id"],
        "task_ids": task_ids,
        "changed_rows": 1 + association_changes,
        "event_id": event_id,
    }


def upsert_pull_request(args: argparse.Namespace) -> None:
    pull_request, requested_task_ids = parse_pull_request_request(args)
    pull_request_id = pull_request["id"]
    failure = {
        "occurred_at": now(),
        "actor_id": args.actor,
        "action": "pull_request.upserted",
        "risk_class": "low",
        "reason": args.reason,
        "target_type": "pull_request",
        "target_id": pull_request_id,
    }
    try:
        lease_token = resolve_lease_token(args)
        with product_lock(args.product_id), connect(args.product_id) as connection:
            validate_lease(connection, args.product_id, args.actor, lease_token)
            connection.execute("BEGIN IMMEDIATE")
            validate_lease(connection, args.product_id, args.actor, lease_token)
            result = upsert_pull_request_in_transaction(
                connection,
                args.product_id,
                args.actor,
                args.reason,
                pull_request,
                requested_task_ids,
            )
            connection.commit()
        emit({"ok": True, **result})
    except Exception as error:
        failure["error_type"] = type(error).__name__
        failure["error"] = str(error)
        append_failure(args.product_id, failure)
        raise


def validate_linked_deployment(
    connection: sqlite3.Connection,
    product_id: str,
    environment: str,
    deployment_id: str,
    coverage_status: str,
) -> sqlite3.Row:
    deployment = connection.execute(
        "SELECT product_id, environment, head_sha, status, verified_at "
        "FROM deployments WHERE id = ?",
        (deployment_id,),
    ).fetchone()
    if deployment is None:
        raise StateError("deployment not found")
    if deployment["product_id"] != product_id:
        raise StateError("deployment belongs to another product")
    if deployment["environment"] != environment:
        raise StateError("deployment environment does not match")
    if coverage_status == "passed" and (
        deployment["status"] not in SUCCESSFUL_DEPLOYMENT_STATUSES
        or deployment["verified_at"] is None
    ):
        raise StateError(
            "passed coverage requires successful verified deployment"
        )
    return deployment


def upsert_pull_request_deployment(args: argparse.Namespace) -> None:
    if not args.environment.strip():
        raise StateError("--environment must not be empty")
    if not args.deployed_head_sha.strip():
        raise StateError("--deployed-head-sha must not be empty")
    failure = {
        "occurred_at": now(),
        "actor_id": args.actor,
        "action": "pull_request.deployment_recorded",
        "risk_class": "low",
        "reason": args.reason,
        "target_type": "pull_request",
        "target_id": args.pull_request_id,
    }
    try:
        lease_token = resolve_lease_token(args)
        with product_lock(args.product_id), connect(args.product_id) as connection:
            validate_lease(connection, args.product_id, args.actor, lease_token)
            connection.execute("BEGIN IMMEDIATE")
            validate_lease(connection, args.product_id, args.actor, lease_token)
            pull_request = connection.execute(
                "SELECT product_id, head_sha FROM pull_requests WHERE id = ?",
                (args.pull_request_id,),
            ).fetchone()
            if pull_request is None:
                raise StateError("pull request not found")
            if pull_request["product_id"] != args.product_id:
                raise StateError("pull request belongs to another product")
            if args.deployed_head_sha != pull_request["head_sha"]:
                raise StateError(
                    "deployed head SHA must match current pull request head"
                )
            deployment_head_sha = None
            if args.deployment_id:
                deployment = validate_linked_deployment(
                    connection,
                    args.product_id,
                    args.environment,
                    args.deployment_id,
                    args.status,
                )
                deployment_head_sha = deployment["head_sha"]
            connection.execute(
                """
                INSERT INTO pull_request_deployments(
                  pull_request_id, environment, deployment_id,
                  deployment_head_sha, deployed_head_sha, status, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(pull_request_id, environment) DO UPDATE SET
                  deployment_id=excluded.deployment_id,
                  deployment_head_sha=excluded.deployment_head_sha,
                  deployed_head_sha=excluded.deployed_head_sha,
                  status=excluded.status,
                  updated_at=excluded.updated_at
                """,
                (
                    args.pull_request_id,
                    args.environment,
                    args.deployment_id,
                    deployment_head_sha,
                    args.deployed_head_sha,
                    args.status,
                    now(),
                ),
            )
            event_id = add_event(
                connection,
                product_id=args.product_id,
                actor_id=args.actor,
                action="pull_request.deployment_recorded",
                risk="low",
                reason=args.reason,
                target_type="pull_request",
                target_id=args.pull_request_id,
                payload={
                    "environment": args.environment,
                    "deployment_id": args.deployment_id,
                    "deployment_head_sha": deployment_head_sha,
                    "deployed_head_sha": args.deployed_head_sha,
                    "status": args.status,
                },
            )
            connection.commit()
        emit(
            {
                "ok": True,
                "pull_request_id": args.pull_request_id,
                "environment": args.environment,
                "status": args.status,
                "event_id": event_id,
            }
        )
    except Exception as error:
        failure["error_type"] = type(error).__name__
        failure["error"] = str(error)
        append_failure(args.product_id, failure)
        raise


def query_rows(
    connection: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()
) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute(sql, params).fetchall()]


def pull_request_task_ids(
    connection: sqlite3.Connection, product_id: str
) -> dict[str, list[str]]:
    if connection.execute(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='pull_request_tasks'"
    ).fetchone() is None:
        return {}
    associations = query_rows(
        connection,
        """
        SELECT pull_request_tasks.pull_request_id, pull_request_tasks.task_id
        FROM pull_request_tasks
        JOIN pull_requests ON pull_requests.id = pull_request_tasks.pull_request_id
        WHERE pull_requests.product_id = ?
        ORDER BY pull_request_tasks.created_at, pull_request_tasks.task_id
        """,
        (product_id,),
    )
    task_ids_by_pull_request: dict[str, list[str]] = {}
    for association in associations:
        task_ids_by_pull_request.setdefault(
            association["pull_request_id"], []
        ).append(association["task_id"])
    return task_ids_by_pull_request


def pull_request_rows(
    connection: sqlite3.Connection,
    product_id: str,
    sql: str,
    params: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    rows = query_rows(connection, sql, params)
    task_ids_by_pull_request = pull_request_task_ids(connection, product_id)
    for row in rows:
        task_ids = task_ids_by_pull_request.get(row["id"], []).copy()
        legacy_task_id = row.get("task_id")
        if legacy_task_id and legacy_task_id not in task_ids:
            task_ids.insert(0, legacy_task_id)
        row["task_ids"] = task_ids
    return rows


def deployment_projections(
    connection: sqlite3.Connection, product_id: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    merged_pull_requests = pull_request_rows(
        connection,
        product_id,
        "SELECT * FROM pull_requests WHERE product_id = ? "
        "AND state = 'merged' ORDER BY updated_at DESC",
        (product_id,),
    )
    deployment_gates = query_rows(
        connection,
        """
        SELECT task_gates.task_id, task_gates.status
        FROM task_gates
        JOIN tasks ON tasks.id = task_gates.task_id
        JOIN initiatives ON initiatives.id = tasks.initiative_id
        WHERE initiatives.product_id = ?
          AND task_gates.gate = 'deployment'
        """,
        (product_id,),
    )
    deployment_status_by_task = {
        gate["task_id"]: gate["status"] for gate in deployment_gates
    }
    deployment_head_column = (
        "pull_request_deployments.deployment_head_sha"
        if connection.execute(
            "SELECT 1 FROM pragma_table_info('pull_request_deployments') "
            "WHERE name = 'deployment_head_sha'"
        ).fetchone()
        else "NULL"
    )
    coverage_rows = (
        query_rows(
            connection,
            f"""
            SELECT pull_request_deployments.pull_request_id,
                   pull_request_deployments.environment,
                   pull_request_deployments.status,
                   pull_request_deployments.deployed_head_sha,
                   pull_request_deployments.deployment_id,
                   {deployment_head_column} AS recorded_deployment_head_sha,
                   deployments.product_id AS deployment_product_id,
                   deployments.environment AS deployment_environment,
                   deployments.head_sha AS deployment_head_sha,
                   deployments.status AS deployment_status,
                   deployments.verified_at AS deployment_verified_at
            FROM pull_request_deployments
            JOIN pull_requests
              ON pull_requests.id = pull_request_deployments.pull_request_id
            LEFT JOIN deployments
              ON deployments.id = pull_request_deployments.deployment_id
            WHERE pull_requests.product_id = ?
            """,
            (product_id,),
        )
        if connection.execute(
            "SELECT 1 FROM sqlite_schema "
            "WHERE type='table' AND name='pull_request_deployments'"
        ).fetchone()
        else []
    )
    coverage_by_pull_request: dict[str, dict[str, dict[str, str]]] = {}
    for coverage in coverage_rows:
        coverage_by_pull_request.setdefault(coverage["pull_request_id"], {})[
            coverage["environment"]
        ] = {
            "status": coverage["status"],
            "deployed_head_sha": coverage["deployed_head_sha"],
            "deployment_id": coverage["deployment_id"],
            "recorded_deployment_head_sha": coverage[
                "recorded_deployment_head_sha"
            ],
            "deployment_head_sha": coverage["deployment_head_sha"],
            "deployment_product_id": coverage["deployment_product_id"],
            "deployment_environment": coverage["deployment_environment"],
            "deployment_status": coverage["deployment_status"],
            "deployment_verified_at": coverage["deployment_verified_at"],
        }
    known_environments = {
        row["environment"]
        for row in query_rows(
            connection,
            "SELECT DISTINCT environment FROM deployments "
            "WHERE product_id = ? AND status IN "
            "('verified', 'deployed', 'passed', 'succeeded')",
            (product_id,),
        )
    }
    for coverage in coverage_rows:
        known_environments.add(coverage["environment"])

    awaiting_deployment: list[dict[str, Any]] = []
    fully_deployed: list[dict[str, Any]] = []
    for pull_request in merged_pull_requests:
        pull_request["deployment_gate_statuses"] = {
            task_id: deployment_status_by_task.get(task_id, "missing")
            for task_id in pull_request["task_ids"]
        }
        deployment_coverage_statuses: dict[str, str] = {}
        for environment in sorted(known_environments):
            coverage = coverage_by_pull_request.get(pull_request["id"], {}).get(
                environment
            )
            if coverage is None:
                deployment_coverage_statuses[environment] = "missing"
            elif coverage["deployed_head_sha"] != pull_request["head_sha"]:
                deployment_coverage_statuses[environment] = "stale"
            elif coverage["deployment_id"] is not None and (
                coverage["deployment_product_id"] != product_id
                or coverage["deployment_environment"] != environment
                or coverage["recorded_deployment_head_sha"]
                != coverage["deployment_head_sha"]
                or coverage["deployment_status"]
                not in SUCCESSFUL_DEPLOYMENT_STATUSES
                or coverage["deployment_verified_at"] is None
            ):
                deployment_coverage_statuses[environment] = "invalid"
            else:
                deployment_coverage_statuses[environment] = coverage["status"]
        pull_request["deployment_coverage_statuses"] = deployment_coverage_statuses
        is_fully_deployed = bool(pull_request["task_ids"]) and bool(
            pull_request["deployment_coverage_statuses"]
        ) and all(
            status == "passed"
            for status in pull_request["deployment_coverage_statuses"].values()
        )
        pull_request["deployment_state"] = (
            "fully_deployed" if is_fully_deployed else "merged_awaiting_deployment"
        )
        if is_fully_deployed:
            fully_deployed.append(pull_request)
        else:
            awaiting_deployment.append(pull_request)
    return awaiting_deployment, fully_deployed


def summarize(args: argparse.Namespace) -> None:
    with product_lock(args.product_id), connect(
        args.product_id, read_only=True
    ) as connection:
        connection.execute("BEGIN")
        validate_schema_history(read_schema_versions(connection))
        product_row = connection.execute(
            "SELECT * FROM products WHERE id = ?", (args.product_id,)
        ).fetchone()
        if product_row is None:
            raise StateError(f"product missing from state: {args.product_id}")
        open_pull_requests = pull_request_rows(
            connection,
            args.product_id,
            "SELECT * FROM pull_requests WHERE product_id = ? "
            "AND state = 'open' ORDER BY updated_at DESC",
            (args.product_id,),
        )
        awaiting_deployment, fully_deployed = deployment_projections(
            connection, args.product_id
        )
        emit(
            {
                "ok": True,
                "product": dict(product_row),
                "initiatives": query_rows(
                    connection,
                    "SELECT * FROM initiatives "
                    "WHERE state IN ('active','blocked','pending') "
                    "AND archived_at IS NULL "
                    "ORDER BY updated_at DESC",
                ),
                "tasks": query_rows(
                    connection,
                    """
                    SELECT tasks.* FROM tasks
                    JOIN initiatives ON initiatives.id = tasks.initiative_id
                    WHERE initiatives.product_id = ?
                      AND tasks.state IN ('active','blocked','pending')
                    ORDER BY tasks.updated_at DESC
                    """,
                    (args.product_id,),
                ),
                "agents": query_rows(
                    connection,
                    "SELECT * FROM agents WHERE product_id = ? "
                    "AND status NOT IN ('archived','complete') "
                    "ORDER BY updated_at DESC",
                    (args.product_id,),
                ),
                "pull_requests": open_pull_requests,
                "pending_approvals": query_rows(
                    connection,
                    "SELECT * FROM approvals WHERE product_id = ? "
                    "AND status = 'pending' ORDER BY created_at",
                    (args.product_id,),
                ),
                "resource_leases": query_rows(
                    connection,
                    "SELECT * FROM resource_leases WHERE product_id = ? "
                    "AND status = 'active' ORDER BY acquired_at",
                    (args.product_id,),
                ),
                "deployments": query_rows(
                    connection,
                    "SELECT * FROM deployments WHERE product_id = ? "
                    "ORDER BY updated_at DESC LIMIT 10",
                    (args.product_id,),
                ),
                "merged_awaiting_deployment": awaiting_deployment,
                "fully_deployed": fully_deployed,
                "recent_decisions": query_rows(
                    connection,
                    "SELECT * FROM decisions WHERE product_id = ? "
                    "AND status = 'active' ORDER BY created_at DESC LIMIT 10",
                    (args.product_id,),
                ),
                "recent_events": query_rows(
                    connection,
                    "SELECT * FROM events WHERE product_id = ? "
                    "ORDER BY occurred_at DESC LIMIT ?",
                    (args.product_id, args.event_limit),
                ),
            }
        )


def diagnose(args: argparse.Namespace) -> None:
    root = get_product_root(args.product_id)
    database_path = get_database_path(args.product_id)
    problems: list[str] = []
    if root.stat().st_mode & 0o077:
        problems.append("product directory permissions are broader than 0700")
    if database_path.stat().st_mode & 0o077:
        problems.append("state database permissions are broader than 0600")
    with connect(args.product_id, read_only=True) as connection:
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        wal_autocheckpoint_pages = connection.execute(
            "PRAGMA wal_autocheckpoint"
        ).fetchone()[0]
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_key_violations = [
            dict(row) for row in connection.execute("PRAGMA foreign_key_check")
        ]
        current_schema_versions = [
            row[0]
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            )
        ]
        lease = connection.execute(
            "SELECT holder_id, expires_at FROM coordinator_leases "
            "WHERE product_id = ?",
            (args.product_id,),
        ).fetchone()
    if integrity != "ok":
        problems.append(f"integrity_check: {integrity}")
    if journal_mode.lower() != "wal":
        problems.append(f"journal_mode is {journal_mode}, expected wal")
    if foreign_key_violations:
        problems.append("foreign key violations present")
    if current_schema_versions != [SCHEMA_VERSION]:
        problems.append(f"unexpected schema versions: {current_schema_versions}")
    result = {
        "ok": not problems,
        "product_id": args.product_id,
        "integrity": integrity,
        "journal_mode": journal_mode,
        "wal_autocheckpoint_pages": wal_autocheckpoint_pages,
        "foreign_key_violations": foreign_key_violations,
        "schema_versions": current_schema_versions,
        "coordinator_lease": dict(lease) if lease else None,
        "problems": problems,
    }
    emit(result)
    if problems:
        raise SystemExit(1)


def checkpoint_state(args: argparse.Namespace) -> None:
    lease_token = resolve_lease_token(args)
    with product_lock(args.product_id), connect(args.product_id) as connection:
        validate_lease(
            connection, args.product_id, args.holder, lease_token
        )
        checkpoint = create_checkpoint_locked(
            args.product_id,
            reason=args.reason,
            trigger=args.trigger,
            actor=args.holder,
        )
        connection.execute("BEGIN IMMEDIATE")
        validate_lease(
            connection, args.product_id, args.holder, lease_token
        )
        event_id = add_event(
            connection,
            product_id=args.product_id,
            actor_id=args.holder,
            action="state.checkpoint_created",
            risk="low",
            reason=args.reason,
            target_type="checkpoint",
            target_id=checkpoint["checkpoint_id"],
            payload={"trigger": args.trigger, **checkpoint},
        )
        connection.commit()
    emit({"ok": True, **checkpoint, "event_id": event_id})


def list_checkpoints(args: argparse.Namespace) -> None:
    checkpoints_root = get_checkpoints_root(args.product_id)
    checkpoints: list[dict[str, Any]] = []
    if checkpoints_root.exists():
        for checkpoint_directory in sorted(
            (path for path in checkpoints_root.iterdir() if path.is_dir()),
            key=lambda path: path.name,
            reverse=True,
        ):
            manifest_path = checkpoint_directory / "manifest.json"
            if manifest_path.exists():
                checkpoints.append(
                    json.loads(manifest_path.read_text(encoding="utf-8"))
                )
    emit({"ok": True, "checkpoints": checkpoints})


def resolve_checkpoint(product_id: str, checkpoint_id: str) -> Path:
    if Path(checkpoint_id).name != checkpoint_id or checkpoint_id in {".", ".."}:
        raise StateError("checkpoint must be an exact checkpoint id")
    checkpoint_directory = get_checkpoints_root(product_id) / checkpoint_id
    if not checkpoint_directory.is_dir():
        raise StateError(f"checkpoint not found: {checkpoint_id}")
    return checkpoint_directory


def restore_checkpoint(args: argparse.Namespace) -> None:
    database_path = get_database_path(args.product_id)
    lease_token = resolve_lease_token(args)
    with product_lock(args.product_id):
        checkpoint_directory = resolve_checkpoint(
            args.product_id, args.checkpoint_id
        )
        checkpoint_database = checkpoint_directory / "state.sqlite"
        manifest = json.loads(
            (checkpoint_directory / "manifest.json").read_text(encoding="utf-8")
        )
        if manifest.get("product_id") != args.product_id:
            raise StateError("checkpoint product does not match")
        if manifest.get("schema_version") != SCHEMA_VERSION:
            raise StateError("checkpoint schema version does not match")
        if manifest.get("database_sha256") != file_sha256(checkpoint_database):
            raise StateError("checkpoint database checksum mismatch")
        with connect(args.product_id) as current_connection:
            validate_lease(
                current_connection,
                args.product_id,
                args.holder,
                lease_token,
            )
            current_lease = dict(
                current_connection.execute(
                    "SELECT * FROM coordinator_leases WHERE product_id = ?",
                    (args.product_id,),
                ).fetchone()
            )
        pre_restore_checkpoint = create_checkpoint_locked(
            args.product_id,
            reason=args.reason,
            trigger="pre-restore",
            actor=args.holder,
            protected_ids={args.checkpoint_id},
        )

        restore_file_descriptor, restore_name = tempfile.mkstemp(
            prefix=".state.restore.", dir=get_product_root(args.product_id)
        )
        os.close(restore_file_descriptor)
        restore_path = Path(restore_name)
        try:
            source_connection = sqlite3.connect(
                f"file:{checkpoint_database}?mode=ro", uri=True
            )
            destination_connection = sqlite3.connect(restore_path)
            try:
                source_connection.backup(destination_connection)
            finally:
                source_connection.close()
                destination_connection.close()
            with sqlite3.connect(restore_path) as validation_connection:
                if validation_connection.execute(
                    "PRAGMA integrity_check"
                ).fetchone()[0] != "ok":
                    raise StateError("checkpoint integrity check failed")
                product = validation_connection.execute(
                    "SELECT id FROM products WHERE id = ?", (args.product_id,)
                ).fetchone()
                if product is None:
                    raise StateError("checkpoint product row missing")
                versions = read_schema_versions(validation_connection)
                validate_schema_history(versions)
                if versions != [SCHEMA_VERSION]:
                    raise StateError(f"checkpoint schema versions invalid: {versions}")
            restore_path.chmod(0o600)
            for wal_path in (
                database_path.with_name(f"{database_path.name}-wal"),
                database_path.with_name(f"{database_path.name}-shm"),
            ):
                wal_path.unlink(missing_ok=True)
            restore_path.replace(database_path)
            checkpoint_project_config = checkpoint_directory / "project.json"
            if checkpoint_project_config.exists():
                write_json(
                    get_product_root(args.product_id) / "project.json",
                    json.loads(
                        checkpoint_project_config.read_text(encoding="utf-8")
                    ),
                )
        finally:
            restore_path.unlink(missing_ok=True)

        with connect(args.product_id) as restored_connection:
            rebuild_pull_requests = not pull_request_fk_is_canonical(
                restored_connection
            )
            with schema_reconciliation_mode(
                restored_connection, rebuild_pull_requests=rebuild_pull_requests
            ):
                restored_connection.execute("BEGIN IMMEDIATE")
                reconcile_schema_in_transaction(
                    restored_connection,
                    args.product_id,
                    rebuild_pull_requests=rebuild_pull_requests,
                )
                assert_foreign_key_integrity(restored_connection)
                restored_connection.execute(
                    """
                    INSERT INTO coordinator_leases(
                      product_id, holder_id, token_hash, acquired_at, expires_at
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(product_id) DO UPDATE SET
                      holder_id=excluded.holder_id,
                      token_hash=excluded.token_hash,
                      acquired_at=excluded.acquired_at,
                      expires_at=excluded.expires_at
                    """,
                    (
                        current_lease["product_id"],
                        current_lease["holder_id"],
                        current_lease["token_hash"],
                        current_lease["acquired_at"],
                        current_lease["expires_at"],
                    ),
                )
                event_id = add_event(
                    restored_connection,
                    product_id=args.product_id,
                    actor_id=args.holder,
                    action="state.checkpoint_restored",
                    risk="high",
                    reason=args.reason,
                    target_type="checkpoint",
                    target_id=args.checkpoint_id,
                    payload={"pre_restore_checkpoint": pre_restore_checkpoint},
                )
                restored_connection.commit()
    emit(
        {
            "ok": True,
            "restored_checkpoint_id": args.checkpoint_id,
            "pre_restore_checkpoint": pre_restore_checkpoint,
            "event_id": event_id,
        }
    )


def export_state(args: argparse.Namespace) -> None:
    root = get_product_root(args.product_id)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_directory = (
        Path(args.output_dir) if args.output_dir else root / "exports" / timestamp
    )
    secure_directory(output_directory)
    with connect(args.product_id, read_only=True) as connection:
        table_names = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        snapshot = {
            "schema_version": SCHEMA_VERSION,
            "exported_at": now(),
            "product_id": args.product_id,
            "tables": {
                table_name: query_rows(connection, f'SELECT * FROM "{table_name}"')
                for table_name in table_names
                if table_name != "events"
            },
        }
        event_rows = query_rows(connection, "SELECT * FROM events ORDER BY occurred_at")
    write_json(output_directory / "state.json", snapshot)
    events_path = output_directory / "events.jsonl"
    with events_path.open("w", encoding="utf-8") as events_file:
        for event in event_rows:
            events_file.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    events_path.chmod(0o600)
    emit(
        {
            "ok": True,
            "output_directory": str(output_directory),
            "tables": len(snapshot["tables"]),
            "events": len(event_rows),
        }
    )


def add_lease_token_arguments(
    parser: argparse.ArgumentParser, *, required: bool
) -> None:
    lease_group = parser.add_mutually_exclusive_group(required=required)
    lease_group.add_argument("--lease-token")
    lease_group.add_argument("--lease-token-env", metavar="NAME")


def add_lease_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--product-id", required=True)
    parser.add_argument("--holder", required=True)
    add_lease_token_arguments(parser, required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    init_parser = commands.add_parser("init")
    init_parser.add_argument("--product-id", required=True)
    init_parser.add_argument("--name", required=True)
    init_parser.add_argument("--actor", default="coordinator")
    init_parser.set_defaults(handler=initialize)

    acquire_parser = commands.add_parser("lease-acquire")
    acquire_parser.add_argument("--product-id", required=True)
    acquire_parser.add_argument("--holder", required=True)
    acquire_parser.add_argument("--ttl-seconds", type=int, default=900)
    acquire_parser.set_defaults(handler=acquire_lease)

    renew_parser = commands.add_parser("lease-renew")
    add_lease_arguments(renew_parser)
    renew_parser.add_argument("--ttl-seconds", type=int, default=900)
    renew_parser.set_defaults(handler=renew_lease)

    release_parser = commands.add_parser("lease-release")
    add_lease_arguments(release_parser)
    release_parser.set_defaults(handler=release_lease)

    registry_upsert_parser = commands.add_parser("registry-upsert")
    add_lease_arguments(registry_upsert_parser)
    registry_upsert_parser.add_argument("--repo-path", default=".")
    registry_upsert_parser.add_argument("--remote-url")
    registry_upsert_parser.add_argument("--reason", required=True)
    registry_upsert_parser.set_defaults(handler=registry_upsert)

    registry_detect_parser = commands.add_parser("registry-detect")
    registry_detect_parser.add_argument("--repo-path", default=".")
    registry_detect_parser.add_argument("--remote-url")
    registry_detect_parser.set_defaults(handler=registry_detect)

    registry_list_parser = commands.add_parser("registry-list")
    registry_list_parser.add_argument("--product-id")
    registry_list_parser.set_defaults(handler=registry_list)

    registry_remove_parser = commands.add_parser("registry-remove")
    add_lease_arguments(registry_remove_parser)
    registry_remove_parser.add_argument("--repo-path", default=".")
    registry_remove_parser.add_argument("--remote-url")
    registry_remove_parser.add_argument("--reason", required=True)
    registry_remove_parser.set_defaults(handler=registry_remove)

    sql_parser = commands.add_parser("sql")
    sql_parser.add_argument("--product-id", required=True)
    sql_parser.add_argument("--actor", default="coordinator")
    add_lease_token_arguments(sql_parser, required=False)
    sql_parser.add_argument("--reason")
    sql_parser.add_argument("--risk", choices=RISK_CLASSES, default="low")
    sql_parser.add_argument("--action", default="state.sql_mutation")
    sql_parser.add_argument("--target-type")
    sql_parser.add_argument("--target-id")
    sql_parser.add_argument("--initiative-id")
    sql_parser.add_argument("--correlation-id")
    sql_parser.add_argument("--params-json", default="{}")
    sql_parser.add_argument("--read-only", action="store_true")
    sql_parser.add_argument("sql", help="one SQL statement, or '-' for stdin")
    sql_parser.set_defaults(handler=execute_sql)

    pull_request_parser = commands.add_parser("pull-request-upsert")
    pull_request_parser.add_argument("--product-id", required=True)
    pull_request_parser.add_argument("--actor", default="coordinator")
    add_lease_token_arguments(pull_request_parser, required=True)
    pull_request_parser.add_argument("--reason", required=True)
    pull_request_parser.add_argument("--pull-request-json", required=True)
    pull_request_parser.add_argument("--task-ids-json")
    pull_request_parser.set_defaults(handler=upsert_pull_request)

    deployment_parser = commands.add_parser("pull-request-deployment-upsert")
    deployment_parser.add_argument("--product-id", required=True)
    deployment_parser.add_argument("--actor", default="coordinator")
    add_lease_token_arguments(deployment_parser, required=True)
    deployment_parser.add_argument("--reason", required=True)
    deployment_parser.add_argument("--pull-request-id", required=True)
    deployment_parser.add_argument("--environment", required=True)
    deployment_parser.add_argument("--deployment-id")
    deployment_parser.add_argument("--deployed-head-sha", required=True)
    deployment_parser.add_argument(
        "--status", choices=("pending", "passed", "failed"), required=True
    )
    deployment_parser.set_defaults(handler=upsert_pull_request_deployment)

    reconcile_parser = commands.add_parser("schema-reconcile")
    add_lease_arguments(reconcile_parser)
    reconcile_parser.set_defaults(handler=schema_reconcile_command)

    summary_parser = commands.add_parser("summary")
    summary_parser.add_argument("--product-id", required=True)
    summary_parser.add_argument("--event-limit", type=int, default=20)
    summary_parser.set_defaults(handler=summarize)

    doctor_parser = commands.add_parser("doctor")
    doctor_parser.add_argument("--product-id", required=True)
    doctor_parser.set_defaults(handler=diagnose)

    checkpoint_parser = commands.add_parser("checkpoint")
    add_lease_arguments(checkpoint_parser)
    checkpoint_parser.add_argument("--reason", required=True)
    checkpoint_parser.add_argument("--trigger", default="manual")
    checkpoint_parser.set_defaults(handler=checkpoint_state)

    checkpoint_list_parser = commands.add_parser("checkpoint-list")
    checkpoint_list_parser.add_argument("--product-id", required=True)
    checkpoint_list_parser.set_defaults(handler=list_checkpoints)

    restore_parser = commands.add_parser("restore")
    add_lease_arguments(restore_parser)
    restore_parser.add_argument("--checkpoint-id", required=True)
    restore_parser.add_argument("--reason", required=True)
    restore_parser.set_defaults(handler=restore_checkpoint)

    export_parser = commands.add_parser("export")
    export_parser.add_argument("--product-id", required=True)
    export_parser.add_argument("--output-dir")
    export_parser.set_defaults(handler=export_state)
    return parser


def main() -> int:
    os.umask(0o077)
    try:
        args = build_parser().parse_args()
        product_id = getattr(args, "product_id", None)
        if args.command != "init" and product_id and get_database_path(product_id).exists():
            is_read_only_sql = args.command == "sql" and args.read_only
            if args.command == "lease-acquire":
                pass
            elif args.command == "schema-reconcile":
                pass
            elif args.command == "summary":
                pass
            elif is_read_only_sql or args.command in {
                "doctor",
                "checkpoint-list",
                "export",
            }:
                validate_schema_read_only(product_id)
            elif hasattr(args, "holder") or (
                args.command
                in {
                    "sql",
                    "pull-request-upsert",
                    "pull-request-deployment-upsert",
                }
                and hasattr(args, "actor")
            ):
                lease_holder = getattr(args, "holder", None) or args.actor
                reconcile_schema_for_lease(
                    product_id, lease_holder, resolve_lease_token(args)
                )
            else:
                validate_schema_read_only(product_id)
        args.handler(args)
        return 0
    except (StateError, sqlite3.Error, json.JSONDecodeError, OSError) as error:
        emit({"ok": False, "error_type": type(error).__name__, "error": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
