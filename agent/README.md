# @shekohex/agent

A small wrapper around `@earendil-works/pi-coding-agent`.

It keeps the usual `pi` command, the usual `.pi` project folder, and the usual `~/.pi` user config, while bundling a few team defaults on top.

## What it includes

- the upstream `pi` experience and UI
- built-in LiteLLM support with automatic gateway selection
- bundled providers for `codex-openai` and `zai-coding-plan`
- bundled themes, including Catppuccin
- a bundled prompt set
- a small commentary mode helper for GPT-style models

## Default behavior

On install, this package seeds `~/.pi/agent/settings.json` if it does not already exist.

It does not overwrite an existing settings file.

## LiteLLM

This package tries the configured LiteLLM gateways in priority order and uses the first healthy one it finds.

## Usage

Run locally:

```bash
npm run pi
```

With a prompt:

```bash
npm run pi -- -p "hello"
```

## Remote mode (TCP control)

`pi --mode remote` exposes a pi agent session over a TCP socket using the same JSON line protocol as `pi --mode rpc`, letting other applications control pi over an SSH port-forward instead of stdio. No subprocess, no patch-package — the session runs in-process via the pi SDK. Supports multiple concurrent controllers with ping/pong heartbeat for dead-connection detection.

```bash
pi --mode remote --host 127.0.0.1 --port 0 --token <secret> [--remote-idle-timeout 300]
```

See [REMOTE.md](./REMOTE.md) for the full protocol, lifecycle, command surface, and client examples.

## Pi Conductor

`pi conductor` is a repo/project worker for agent-driven GitHub issue work. It watches configured GitHub Projects v2 items, dispatches eligible issues into isolated worktrees, routes PR/check/comment feedback back to the running Herdr pane, and persists state in `~/.pi/agent/conductor` by default.

Quick start:

```bash
pi conductor config init
pi conductor config validate
pi conductor serve
```

`config init` is safe to rerun. It reads existing config, applies structural migrations, preserves repo-specific settings, upserts the current GitHub repo into `~/.pi/agent/conductor/config.json`, writes `config.schema.json`, and creates `.pi/WORKFLOW.md` if missing. To add more repositories, run it from each checkout:

```bash
cd /path/to/another/repo
pi conductor config init
```

Config automation commands:

```bash
pi conductor config format
pi conductor config edit
pi conductor config get repositories[0].project.number --json
pi conductor config set repositories[0].project.number 12
pi conductor config set repositories[0].dispatchLabel ready-for-agent
```

If project owner/number cannot be inferred, find GitHub Projects v2 data with:

```bash
gh repo view owner/repo --json projectsV2 --jq '.projectsV2.nodes[] | "owner=\(.owner.login) number=\(.number) title=\(.title)"'
gh project list --owner owner
gh project list --owner owner --format json --jq '.projects[] | "number=\(.number) title=\(.title)"'
gh project view <number> --owner <owner>
```

Then edit:

```text
~/.pi/agent/conductor/config.json
.pi/WORKFLOW.md
```

Branch templates use the same `${{ }}` expression style as workflow prompts:

```yaml
branchTemplate: "pi/${{ github.issue.number }}-${{ github.issue.slug }}"
```

Legacy placeholders like `{issue}` and `{slug}` are not supported.

Workflow Markdown body comments like `<!-- author notes -->` are stripped before the prompt is sent to the agent, so repos can keep syntax examples and local guidance inline.

Workflow expressions support GitHub-style helpers such as bracket paths, object filters, bare `if:` expressions, `startsWith()`, `endsWith()`, `join()`, `format()`, `toJSON()`, `fromJSON()`, `hashFiles()`, status helpers, comparison operators, and contexts like `env`, `vars`, `secrets`, `matrix`, `needs`, `steps`, and `runner`. `env.NAME` reads the current process environment; `vars.NAME` reads `PI_CONDUCTOR_VAR_NAME`; `secrets.NAME` reads `PI_CONDUCTOR_SECRET_NAME`.

Worktree hooks can prepare and clean local worktrees. Shared hooks live in `.pi/WORKFLOW.md`:

```yaml
worktreeHooks:
  postCreate:
    - npm install
  preRemove:
    - docker compose down || true
  postRemove:
    - echo "removed $WORKTREE_PATH"
```

Private ignored hooks live in `.git/config`:

```bash
git config --local --add pi.conductor.hook.postCreate "cp ../.env .env || true"
```

Hooks receive `REPO_ROOT`, `WORKTREE_PATH`, `BRANCH`, `PI_CONDUCTOR_OWNER`, `PI_CONDUCTOR_REPO`, and `PI_CONDUCTOR_ISSUE_NUMBER`. Shared hooks run before private hooks.

Human/agent commands:

```bash
pi conductor help
pi conductor run --help
pi conductor status --json
pi conductor run owner/repo#123 --mode-deep
pi conductor send <run-id> "address review feedback" --follow-up
pi conductor logs <run-id>
pi conductor cleanup --merged
```

Shell completion:

```bash
source <(pi conductor completion bash)
source <(pi conductor completion zsh)
```

For persistent bash completion, save the generated script into your shell completion directory. For zsh, save it as `_pi_conductor` in a directory on `fpath`.

Webhook mode is enabled in `~/.pi/agent/conductor/config.json`. GitHub receives a response after the delivery is durably recorded, before any reconcile work runs. If the process crashes after ACK, startup replays `received` and `processing` deliveries from SQLite. Supported events are:

```text
issues, issue_comment, pull_request, pull_request_review,
pull_request_review_comment, check_run, check_suite, status, workflow_run,
projects_v2_item
```

GitHub webhook form choices:

```text
Payload URL: https://<public-host><webhook.path>
Content type: application/json
Secret: same value as webhook.secret env/file
SSL verification: Enable SSL verification
Events: Let me select individual events
Active: checked
```

Select these individual events:

```text
Issues
Issue comments
Pull requests
Pull request reviews
Pull request review comments
Check runs
Check suites
Statuses
Workflow runs
```

Do not choose `Just the push event`; Conductor does not use push events. `Send me everything` works but creates noisy ignored deliveries.

`projects_v2_item` deliveries are supported when a GitHub webhook source exposes them, but repository webhooks usually do not show a “Projects v2 items” checkbox. That is OK; polling remains the safety net for project-only changes such as status/field updates.

Example config:

```json
{
  "webhook": {
    "host": "127.0.0.1",
    "port": 8787,
    "path": "/github/webhook",
    "secret": { "env": "PI_CONDUCTOR_WEBHOOK_SECRET" }
  }
}
```

Supervisor-friendly modes:

```bash
pi conductor serve                 # foreground, best for systemd/supervisord
pi conductor daemon start          # local background helper
pi conductor daemon status
pi conductor daemon stop
```

Daemon files live under `~/.pi/agent/conductor/daemon` unless `stateRoot` is configured:

```text
conductor.pid
conductor.log
conductor.err.log
```

Resilience model:

- Polling remains a safety net; webhooks narrow work to repo/issue/PR/project-item scope.
- Webhook delivery IDs dedupe retries.
- Failed delivery processing retries with exponential backoff; GitHub rate-limit errors back off for 15 minutes.
- Polling avoids overlapping reconcile runs and backs off on rate-limit errors.
- Unknown webhook events are ACKed and ignored to avoid needless GitHub API usage.

## Development

Build the package:

```bash
npm run build
```

This compiles the TypeScript sources, copies bundled resources, and generates the default settings JSON used by postinstall.

It also prepares `bin/pi.js` and `bin/pi.cmd`, and marks the Unix entrypoints executable.

## Upstream UI patches

This package carries a small UI patch on top of `@earendil-works/pi-coding-agent`.

Current patch:

- `patches/@earendil-works+pi-coding-agent+0.74.0.patch`

When upgrading pi again:

1. Inspect fresh installed files in `node_modules` and rerun targeted preview/harness tests before deleting a patch.
2. If patch still needed, regenerate `patches/` for current package scope and version.
3. Run:

```bash
npm run test:tool-preview
npm run test:harness
```

1. Rebuild and reload pi to verify the real runtime still matches the preview harness.
