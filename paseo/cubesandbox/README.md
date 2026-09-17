# CubeSandbox Paseo plugin

Paseo v0.8 plugin for one Work Sandbox per unit of work. Each plugin installation persists only
the sandbox IDs it creates; it never lists or manages unrelated CubeSandbox workloads.

## Install from Git subdirectory

Enable Paseo plugins after reviewing this trusted server/client code, then:

```bash
paseo plugin add shekohex/dotai:paseo/cubesandbox --ref main
```

The Git install runs `npm ci --omit=dev`. Local development uses:

```bash
npm install
npm run typecheck
npm test
npm run build
```

Do not place Cube credentials in project files. Set optional `CUBE_API_KEY` in the daemon's runtime
environment. Cube API and sandbox-domain defaults are `https://sandbox.0iq.xyz` and `sbx.0iq.xyz`.

## Project `.cube` contract

Project owns:

- `.cube/Dockerfile`
- `.cube/sandbox.py`
- `.cube/config.json`

`cube_init_config` finds the Git root, derives repository/default branch from Git, creates `.cube`
when absent, and writes only `.cube/config.json`. Existing config is never overwritten. Plugin never
creates or edits Dockerfile or Python. Bundled schema lives at `shared/cube-config.schema.json`.

Configuration contains deployment intent only: project identity, Cube endpoint, template inputs and
resources, idle pause policy, preview ports, and manual snapshot selection. No task state, runtime
state, or secrets belong there.

Snapshot preparation stays explicit and project-owned:

```bash
uv run .cube/sandbox.py prepare-snapshot <sandbox-id> --name <template-alias>
```

Set `snapshot.id` to pin a prepared snapshot. Otherwise plugin consumes newest API result whose
names include configured template alias. It never infers a snapshot from lockfiles and never creates
snapshots. Prepare snapshots before injecting secrets, cloning project source, or initializing a
Paseo identity.

## Lifecycle

`cube_create_agent` without `workId` creates Sandbox from prepared snapshot, injects runtime-only
provider/Git environment credentials, clones configured repository, installs Paseo CLI v0.8 when
missing, starts remote daemon, enables relay, and creates first Paseo-owned worktree agent.

Supplying `workId` reuses Sandbox and creates another isolated Paseo worktree agent. Multiple agents
share Sandbox compute, not working directories. Work IDs are internal UUIDs; optional external task
metadata is descriptive only.

Cube idle timeout defaults to 300 seconds with `onTimeout: pause`. Prompt sends and new agents
auto-resume paused sandboxes and wait for remote Paseo relay readiness. Pause is immediate on request.
Destroy is explicit, immediate, and has no confirmation. Undestroyed work remains paused. Plugin
does no GitHub polling; Paseo owns merged-PR worktree cleanup.

## Agent tools

| Tool                | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `cube_create_agent` | Create/reuse Work Sandbox and create isolated remote agent |
| `cube_init_config`  | Create project `.cube/config.json` only                    |
| `cube_send_prompt`  | Resume if needed and prompt managed remote agent           |
| `cube_get_status`   | Read managed lifecycle/agent status                        |
| `cube_get_activity` | Read local lifecycle activity                              |
| `cube_list_work`    | List work owned by initiating repository                   |
| `cube_get_ports`    | Return configured preview URLs                             |
| `cube_pause_work`   | Pause immediately                                          |
| `cube_destroy_work` | Destroy immediately, without confirmation                  |

Paseo v0.8 public plugin API cannot register tools. Server starts loopback-only Streamable HTTP MCP
and injects opaque per-agent capability URL through `server.before("agent.create")`. Capability is
bound to initiating Git root; tool inputs accept no project path. Work IDs from another root are
rejected.

## UI and pairing

**Cube Sandboxes** sidebar surface works in desktop, browser, iOS, and Android. It shows lifecycle,
project, worktree/agent counts, idle grace, preview links, pairing, pause/resume, and immediate
destroy. Busy/success/error states use native Paseo toasts.

Remote daemon runs relay-only. Plugin server connects through Paseo's supported encrypted relay
client protocol. **Pair / open agent** opens manual pairing offer in app/browser. Seamless host
registration/removal is intentionally deferred because public v0.8 plugin client API does not expose
host mutation. Treat pairing links as passwords.

## Security and local state

- Plugin is trusted, unsandboxed daemon code.
- Cube/API/provider/Git tokens stay in process or sandbox runtime environment; project config and
  WorkRecord never contain them.
- Private state defaults to `~/.paseo/cubesandbox-plugin/cubesandbox`: directories mode `0700`, files
  mode `0600`. WorkRecord stores work/sandbox/task/relay/workspace/agent references and lifecycle
  timestamps/status. Pairing offers are separate private secret files and are returned only through
  authenticated plugin UI RPC or initiating-repository MCP capability.
- Server binds MCP to `127.0.0.1` on an ephemeral port. Unknown capabilities return 404.
- Preview ports are project-declared. Plugin performs no port discovery.
- Vendored CubeSandbox Node SDK subset comes from upstream v0.7.1 under Apache-2.0; see
  `server/vendor/cubesandbox-sdk/PROVENANCE.md`.
