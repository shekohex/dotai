# State and storage

## Locations

Private coordinator state:

```text
${AGENTS_HOME:-$HOME/.agents}/projects/<product-id>/
├── project.json
├── state.sqlite
├── initiatives/<initiative-id>/
├── events.jsonl
├── artifacts/
├── checkpoints/<timestamp-id>/
├── exports/
└── locks/
```

Global product registry:

```text
${AGENTS_HOME:-$HOME/.agents}/projects/index.json
```

Registry maps normalized remote identity, known checkout roots, and Git common directories to product IDs. GitHub SSH/HTTPS URLs normalize to one identity. Git common-directory matching makes linked worktrees resolve without separate registration. Registry contains no secrets.

Use state script for all registry CRUD:

```bash
python3 scripts/coordinator_state.py registry-upsert \
  --product-id example --holder coordinator \
  --lease-token-env COORDINATOR_LEASE_TOKEN \
  --repo-path . --reason 'Register primary repository'

python3 scripts/coordinator_state.py registry-detect --repo-path .
python3 scripts/coordinator_state.py registry-list --product-id example

python3 scripts/coordinator_state.py registry-remove \
  --product-id example --holder coordinator \
  --lease-token-env COORDINATOR_LEASE_TOKEN \
  --repo-path . --reason 'Remove obsolete repository association'
```

SQLite state currently uses schema v1. Fresh initialization creates the complete v1 definition and records ordered history `[1]`. Read-only commands validate history through an isolated read-only main/WAL snapshot and never reconcile or create state sidecars. Summary validates history and projects all related state inside one read transaction. A lease-protected mutation path runs the ordered v1 reconciliation transactionally; it idempotently materializes `pull_request_tasks`, `pull_request_deployments`, their indexes, legacy single-task links, and canonical `pull_requests.task_id` `ON DELETE SET NULL` behavior. Repeated reconciliation converges without changing schema version; unknown, newer, or inconsistent history refuses before writable connection setup. Future schema work adds an explicit ordered step and version only when approved.

Registry writes require active product coordinator lease, use atomic file replacement, and append product audit events. A remote already assigned to another product is a hard conflict; never reassign silently.

Lease commands accept either `--lease-token TOKEN` or `--lease-token-env NAME`. The environment form keeps the token out of command arguments and shell history; it is resolved only for that process and still validates the same hashed token under the same product lock. Never write the plaintext token to SQLite, files, checkpoints, logs, or project configuration.

When detection finds no mapping, derive a concise candidate ID/name from normalized remote and ask one bootstrap question: create new product or attach repository to existing product. Initialization and registration follow that answer. This one-time identity confirmation prevents accidental fragmentation of multi-repository products. Later worktrees and clones resolve automatically.

Committed repository knowledge:

```text
<repo>/.agents/project/
├── PRODUCT.md
├── ARCHITECTURE.md
├── WORKFLOWS.md
└── LEARNINGS.md
```

Use existing repository equivalents rather than duplicating them. Never store secrets. Keep private directories `0700` and files `0600`. Disposable caches belong under `${XDG_CACHE_HOME:-$HOME/.cache}/agents/projects`.

## Ownership

One canonical coordinator host owns product. One active coordinator lease permits mutations. Other coordinators may inspect read-only. Transfer requires export, verified import, old-lease release, and explicit new-lease acquisition. Never synchronize live SQLite across machines.

## Data responsibilities

- SQLite: canonical live operational state.
- Markdown: human-authored briefs, decisions, summaries, durable knowledge.
- JSON: product configuration and portable snapshot.
- JSONL: append-only event export.
- External artifact store: large screenshots, videos, traces, and logs. SQLite stores URI, hash, media type, provenance, and verification state.

GitHub issue/PR attachments are preferred durable store for published evidence. Local media is temporary and stays outside Git unless repository visual tests require committed baselines/fixtures. Clean local copies after merge and required deployment verification; retain while diagnosing failures or when user requests it.

Do not duplicate authoritative values. Generated Markdown summaries are projections, not state.
project.json is authoritative configuration. SQLite repository rows are synchronized operational projections used for joins and events.

Pull requests can deliver multiple tightly coupled tasks. Keep `pull_requests.task_id` as existing single-task compatibility field. When `pull-request-upsert --task-ids-json` is supplied, it is the complete set: operation replaces stale `pull_request_tasks(pull_request_id, task_id, created_at)` links atomically in same guarded transaction and aligns compatibility `task_id` to one supplied task. Omitting option preserves existing links and compatibility behavior. Generic `sql` remains one statement per transaction. Summary output exposes complete `task_ids`; task gates and completion remain separate.

Summary output separates merged work into `merged_awaiting_deployment` and `fully_deployed`. Record explicit per-PR, per-environment coverage with `pull-request-deployment-upsert`; a merged PR is fully deployed only when every known deployment environment has a `passed` coverage row for that PR whose `deployed_head_sha` matches current PR head. Task-level deployment gates remain task evidence, not PR coverage. Missing, stale, or non-passed coverage remains awaiting deployment. Deployment classification does not infer coverage from aggregate deployment head SHA, repository ancestry, or network calls during summary.

## Checkpoints and rollback

SQLite uses WAL mode, `synchronous=NORMAL`, a 1,000-page automatic WAL checkpoint, and a 16 MiB journal limit. `checkpoint` uses SQLite's online backup API, so each checkpoint is a consistent standalone `state.sqlite` plus manifest/checksum and `project.json` copy.

Keep newest five checkpoints per product. The state tool prunes older checkpoints automatically. It creates a checkpoint before `DELETE`, `REPLACE`, any high/critical SQL mutation, and every restore. Before an external destructive action, coordinator explicitly runs `checkpoint`; external action remains governed by its separate approval.

```bash
python3 scripts/coordinator_state.py checkpoint \
  --product-id example \
  --holder coordinator \
  --lease-token-env COORDINATOR_LEASE_TOKEN \
  --reason 'Before approved production reset' \
  --trigger pre-deployment
```

List retained checkpoint IDs with `checkpoint-list --product-id <id>`.

Restore requires current writer lease and exact checkpoint ID. Tool verifies product, schema, checksum, and SQLite integrity; first checkpoints current state; atomically replaces database; preserves current lease; then audits restore inside restored database.

```bash
python3 scripts/coordinator_state.py restore \
  --product-id example \
  --holder coordinator \
  --lease-token-env COORDINATOR_LEASE_TOKEN \
  --checkpoint-id 20260101T120000.000000Z-deadbeef \
  --reason 'Roll back invalid coordinator-state mutation'
```

These checkpoints cover coordinator bookkeeping only. They do not back up repositories, application databases, infrastructure, secrets, or external systems. Timestamped `exports/` remain portable JSON/JSONL snapshots for host transfer, not rollback source.

## Guarded SQL

Use `scripts/coordinator_state.py sql`; never raw `sqlite3`. Pass parameters as JSON. One invocation is one transaction. DDL, `ATTACH`, writable pragmas, extension loading, and direct audit/schema mutation are denied. Every successful mutation appends audit event in same transaction. Failed mutations append failure record outside rolled-back transaction.

Example:

```bash
python3 scripts/coordinator_state.py sql \
  --product-id example \
  --actor coordinator \
  --lease-token-env COORDINATOR_LEASE_TOKEN \
  --reason 'Assign ready task' \
  --risk low \
  --params-json '{"task":"task-1","owner":"agent-1"}' \
  'UPDATE tasks SET owner_agent_id=:owner, state="active" WHERE id=:task'
```

Use `--read-only` for diagnostics. Code mode should compose calls and parse JSON results instead of scraping prose.

## Progressive loading

Startup summary includes product, active initiatives, ready/blocked tasks, running agents, leases, open PRs, merged work awaiting deployment, fully deployed work, pending approvals, recent decisions, and unread events. Query archived initiatives, full event history, artifacts, and unrelated knowledge only when needed.
