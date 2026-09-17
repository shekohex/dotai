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

Do not place Cube credentials in project files. Set optional `CUBE_API_KEY` in daemon runtime.
Trusted control endpoint comes from `CUBE_API_URL`, default `https://sandbox.0iq.xyz`; trusted
data-plane domain comes from `CUBE_SANDBOX_DOMAIN`, default `sbx.0iq.xyz`. Project `cube.apiUrl` and
`cube.sandboxDomain` are assertions and must match before plugin reads Cube/provider/Git secrets.
Cube create uses empty environment; missing/mismatched response domain destroys new Sandbox before
runtime provider/Git credentials are resolved or sent.

## Project `.cube` contract

Project owns:

- `.cube/Dockerfile`
- `.cube/sandbox.py`
- `.cube/config.json`

`cube_init_config` finds the Git root, derives repository/default branch from Git, creates `.cube`
when absent, and writes only `.cube/config.json`. Existing config is never overwritten. Plugin never
creates or edits Dockerfile or Python. Default branch comes from local `origin/HEAD` or origin's
advertised symbolic HEAD; initialization fails with repair guidance when neither is available.
Bundled schema lives at `shared/cube-config.schema.json`.

Configuration contains deployment intent only: project identity, Cube endpoint, template inputs and
resources, idle pause policy, preview ports, and manual snapshot selection. No task state, runtime
state, or secrets belong there.

Snapshot preparation stays explicit and project-owned:

```bash
uv run .cube/sandbox.py prepare-snapshot --name <template-alias>
```

Set `snapshot.id` to pin a prepared snapshot. Otherwise plugin consumes newest API result whose
names include configured template alias. It never infers a snapshot from lockfiles and never creates
snapshots. Project CLI uses dedicated empty-environment source, verifies repository, Git/GitHub
auth, Pi/Codex auth, API-key environment, and Paseo identity paths are absent, snapshots it, then
destroys source on success or failure.

## Lifecycle

`cube_create_agent` without `workId` creates Sandbox from prepared snapshot with no credentials,
validates trusted response domain, then supplies runtime-only provider/Git credentials. Bootstrap
clones configured repository, runs `gh auth setup-git` with runtime token, installs agent
dependencies, installs Paseo CLI v0.8 with Bun when missing, starts remote daemon, enables relay, and
creates first Paseo-owned worktree agent. Runtime Git helper stores no token; image and snapshot
contain no `hosts.yml`, Git credential, or Paseo identity.

Supplying `workId` reuses Sandbox and creates another isolated Paseo worktree agent. Multiple agents
share Sandbox compute, not working directories. Work IDs are internal UUIDs; optional external task
metadata is descriptive only.

Cube idle timeout defaults to 300 seconds with `onTimeout: pause`. While any remote Paseo agent is
running, plugin checks remote status and sends bounded CubeProxy command activity to prevent timeout.
When all agents become idle, one final activity starts configured idle grace and keepalive stops.
Prompt sends and new agents auto-resume paused sandboxes and wait for remote Paseo relay readiness.
Pause is immediate on request. Destroy is explicit, immediate, and has no confirmation. Pause,
destroy, and plugin shutdown cancel keepalive. Undestroyed work remains paused. Plugin does no GitHub
polling; Paseo owns merged-PR worktree cleanup.

Plugin shutdown first rejects new MCP, RPC, and lifecycle operations, then drains accepted tool
requests and tracked work operations before closing relay connections. A Sandbox whose initial
bootstrap is still in flight is destroyed and its incomplete local record removed; established work
records survive reload so busy-agent keepalive can recover on startup. Failed destruction retains
owned error record for explicit retry. Agent-create rollback archives created remote workspace;
rollback failures propagate through shutdown.

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
rejected. Any valid Git root receives the initialization capability even before `.cube/config.json`
exists. `cube_init_config` performs full origin/default-branch resolution and returns actionable
repair guidance instead of silently omitting the tool.

## UI and pairing

**Cube Sandboxes** sidebar surface works in desktop, browser, iOS, and Android. It shows lifecycle,
project, worktree/agent counts, idle grace, preview links, pairing, pause/resume, and immediate
destroy. Busy work says **Keepalive active**; only idle/ready work shows pause countdown.
Busy/success/error states use native Paseo toasts.

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
