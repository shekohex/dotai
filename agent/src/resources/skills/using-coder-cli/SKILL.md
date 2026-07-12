---
name: using-coder-cli
description: Discover and operate Coder deployments and workspaces with the `coder` CLI, including authentication context, workspace inventory, `coder ssh`, OpenSSH setup, lifecycle actions, port forwarding, apps, and diagnostics. Use when the user mentions Coder CLI, a Coder deployment or instance, Coder workspaces, `coder ssh`, or connecting to or running commands in a Coder workspace.
compatibility: Requires `coder` in PATH and network access to the target Coder deployment.
metadata:
  short-description: Discover and control Coder workspaces
---

# Using Coder CLI

Pin the deployment, identity, and workspace before acting. The installed binary is the source of truth because Coder commands and flags vary by version.

## Process

1. Learn the current CLI before using an unfamiliar command:

```bash
command -v coder
coder version
coder --help
coder <command> --help
```

Do not guess syntax from examples when current help differs.

2. Pin the deployment and authenticated identity:

```bash
coder whoami
coder --url "$deployment_url" whoami
```

Inside a Coder workspace, inspect only non-secret context:

```bash
if [ -n "${CODER_WORKSPACE_NAME:-}" ]; then
  printf 'deployment=%s\nworkspace=%s/%s\n' \
    "${CODER_URL:-unknown}" \
    "${CODER_WORKSPACE_OWNER_NAME:-unknown}" \
    "$CODER_WORKSPACE_NAME"
fi
```

If authentication is missing, use `coder login <url>` in a user-visible interactive terminal. For automation, use an inherited `CODER_SESSION_TOKEN`. Never print, request, read from config, or place a token on the command line; never run `coder login token`.

This step is complete when the exact deployment URL and username are known.

3. Discover workspaces read-only first:

```bash
coder list
coder show "$workspace"
```

Default `coder list` scope is the current owner. Use `--all` only when the task requires other owners and the identity has permission. Use the exact returned identifier; prefer `owner/workspace` when ownership is not implicit.

For machine-readable inventory, filter before displaying it:

```bash
coder list --output json |
  jq 'map({workspace: ((.owner_name // "me") + "/" + .name), organization: .organization_name, template: .template_name, status: .latest_build.status, healthy: .health.healthy, outdated})'
```

Do not display or persist raw `coder list --output json`. It can contain embedded template scripts, resource metadata, and secrets. This step is complete when target workspace, owner, status, and health are known.

4. Choose the least-mutating interaction. Read [command branches](references/COMMANDS.md) when the task needs lifecycle changes, creation, ports, apps, or diagnostics. `coder ssh` autostarts a stopped workspace by default; use `--disable-autostart` when observation must not change state.

5. Connect or execute remotely:

```bash
coder ssh "$workspace"
coder ssh --disable-autostart "$workspace"
coder ssh "$workspace" -- pwd
coder ssh "$workspace" -- sh -lc 'cd "$HOME/project" && git status --short'
```

Use `--` before the remote command. Single-quote `sh -lc` programs when expansion must happen remotely. Local redirections happen locally unless placed inside the remote shell program. Use `-A` only when SSH-agent forwarding is explicitly needed because remote processes can then use loaded local keys.

This step is complete when output and exit status come from the pinned workspace.

6. Use standard OpenSSH only when its full feature set is needed:

```bash
coder config-ssh --dry-run
coder config-ssh
```

Always inspect the dry run first. Applying `coder config-ssh` modifies an SSH config file, so require explicit user intent. Read the generated host pattern rather than assuming a suffix; then use normal `ssh`, `scp`, `rsync`, or Remote-SSH tooling.

7. Verify and report. After a mutation, rerun `coder show "$workspace"` or `coder list` and confirm the requested final state. Report deployment, workspace, action, and observed result without exposing tokens, raw workspace JSON, logs containing credentials, or support bundles.

## Guardrails

- Do not create, update, restart, stop, delete, or rename a workspace without explicit user intent.
- Do not add `--yes` merely to avoid a prompt; use it only after the destructive or billable action is already authorized.
- Bound `coder ping`, `coder logs --follow`, port forwards, and interactive sessions; background long-running commands when the shell tool requires it.
- Bind local forwards to `127.0.0.1` unless external exposure is explicitly requested.
- Treat workspace logs, SSH diagnostics, and support bundles as potentially sensitive.
