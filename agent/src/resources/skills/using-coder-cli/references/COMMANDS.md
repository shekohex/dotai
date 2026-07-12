# Coder CLI Command Branches

Use these branches only after `SKILL.md` has pinned the deployment, identity, and exact workspace. Run `coder <command> --help` before relying on a flag not shown by the installed version.

## Deployment And Inventory

Show safe identity fields when JSON is required:

```bash
coder whoami --output json | jq 'map({url, username, user_id})'
```

Inspect available workspaces and templates:

```bash
coder list
coder list --search 'owner:me'
coder show "$workspace"
coder templates list
```

Use `coder list --all` only for an explicitly cross-owner task. Inside the current workspace, `coder stat` reports its resource usage. Do not dump the full environment: Coder workspace environments commonly contain session and agent tokens.

## Lifecycle

Inspect current state before and after each operation:

```bash
coder start "$workspace"
coder stop "$workspace"
coder restart "$workspace"
coder update "$workspace"
```

`coder update` can stop a running workspace before rebuilding it. Start, stop, restart, and update can disrupt active work; run them only when requested.

Workspace creation provisions resources and may incur cost. Discover templates and current parameter syntax first:

```bash
coder templates list
coder create --help
coder create "$workspace_name" --template "$template"
```

Deletion destroys the workspace. Do not use `--orphan` or `--yes` unless the user explicitly requested that exact behavior:

```bash
coder delete "$workspace"
```

## SSH And File Transfer

Run simple commands directly and shell programs through the remote shell:

```bash
coder ssh "$workspace" -- uname -a
coder ssh "$workspace" -- sh -lc 'cd "$HOME/project" && npm test'
```

Use `--wait yes|no|auto` when startup-script completion matters. Use `--disable-autostart` to prevent an SSH attempt from starting a stopped workspace. Avoid `-e KEY=value` for secrets because command arguments may be logged or visible to other local processes.

`coder ssh` is not full OpenSSH. For `scp`, `sftp`, `rsync`, `ProxyJump`, or IDE integrations:

```bash
coder config-ssh --dry-run
coder config-ssh
ssh <host-from-generated-config>
scp ./file <host-from-generated-config>:/remote/path/
```

Do not assume `<workspace>.coder`; use the host pattern emitted by the dry run.

## Ports And Apps

Forward workspace TCP port `3000` to local loopback port `8080`:

```bash
coder port-forward "$workspace" --tcp 127.0.0.1:8080:3000
```

Forward remote port `8080` back to a local service on port `3000`:

```bash
coder ssh -R 8080:127.0.0.1:3000 "$workspace"
```

Port forwards are long-running. Keep the process handle, verify the listening address, and stop only the forward created for the task.

Open a workspace application or VS Code only when the user wants a local UI launched:

```bash
coder open app "$workspace" "$app_slug"
coder open vscode "$workspace" "$remote_directory"
```

Use `coder show "$workspace"` to discover agents and application slugs.

## Logs And Connectivity

Start with bounded, read-only checks:

```bash
coder show "$workspace"
coder logs "$workspace"
coder ping --num 4 "$workspace"
coder speedtest "$workspace"
coder netcheck
```

Use `coder show --details`, `coder --verbose`, or `coder ssh --log-dir "$log_dir"` only when basic evidence is insufficient. Build logs and SSH logs can contain credentials or private paths; redact before sharing.

Run `coder support bundle --help` before generating a bundle. Generate or share one only with explicit user intent because it can contain sensitive deployment diagnostics.

## Multiple Deployments

Keep every command pinned to one deployment. Use `--url` for an explicit target or isolate persistent profiles with separate config directories:

```bash
coder --url "$deployment_url" whoami
CODER_CONFIG_DIR="$profile_dir" coder login "$deployment_url"
CODER_CONFIG_DIR="$profile_dir" coder whoami
```

Do not copy tokens between deployments or expose them while switching profiles. Re-run `coder whoami` after every context switch.
