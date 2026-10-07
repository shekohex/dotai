# Conductor

A [Paseo](https://paseo.sh) plugin for long-lived coordinator agents. You talk to one
conversation, the **conductor**, for days or weeks. It hands work to worker agents, stays free
to answer you while they run, and reports back as results arrive.

Inspired by [Synara Hubs](https://www.trysynara.com/docs/features/hubs), built on Paseo's own
agents, worktrees, and notifications instead of a separate runtime.

- Any provider for the conductor and for each worker: Claude, Codex, Pi, and the rest
- Worker results reach the conductor in real time, even mid-turn, without showing up as noise in
  your conversation
- Durable memory per conductor and across conductors, editable in the app
- Optional `CONDUCTOR.md` per project for project-specific rules
- Worktrees start from the latest remote base, never a stale local `main`
- Works on desktop, web, and mobile

## Requirements

- Paseo 0.11.0 or later, with plugins enabled
- **Enable Paseo tools** turned on for the host (Settings → host → Agents), so conductors can
  start and message workers

## Install

```bash
paseo plugin add shekohex/dotai:paseo/conductor --ref main
```

Or from a local checkout:

```bash
paseo plugin install /absolute/path/to/paseo/conductor
```

Plugins run trusted, unsandboxed code on the daemon host. Review the code before installing.

## Use

### Start a conductor

Open **Conductors** in the sidebar, or press **⌘K** / **Ctrl+K** and run **New conductor**. Pick:

| Field         | Notes                                                              |
| ------------- | ------------------------------------------------------------------ |
| Workspace     | Where the conductor runs. Workers can still get their own worktree |
| Provider      | Only providers that are enabled and ready on the host              |
| Model         | The provider's selectable models                                   |
| Reasoning     | The model's reasoning levels, when it has any                      |
| Title         | Shown in the sidebar                                               |
| First message | Optional. Defaults to a short readiness check                      |

Workspace, provider, model, and reasoning are remembered as soon as you pick them.

**Start conductor in this workspace** in the Command Center opens the form with the current
workspace selected.

### Work with it

Talk to the conductor like any agent. It:

- answers, dispatches, follows up, remembers, or declines every item in your message
- starts workers with Paseo's `create_agent`, giving each a self-contained brief
- ends its turn after dispatching instead of waiting, so it can keep talking to you
- picks up worker results, permission requests, and errors as they happen, and reports in a line
  or two
- uses worktrees for parallel work and sets up `paseo.json` so new worktrees install themselves
- asks before merging, deploying, or anything destructive

### Conductors screen

On wide layouts the screen is a list beside a detail pane; on phones the list opens each detail
full-screen.

- **A conductor**: opens its chat, lists workers grouped as Needs you, Working, Errored, Idle, and
  Closed (tap one to open it), and shows its memory
- **New conductor**: the form above
- **Memory and instructions**: global memory and any workspace's `CONDUCTOR.md`

The sidebar lists every conductor with a count of workers that need you. The **Conductor** panel
(Command Center → **Open conductor panel**) shows the same detail next to the conductor's chat or
any of its workers.

## Memory

Conductors keep durable state outside the chat, so it survives context compaction and restarts.

| File                                                            | Owner     | Purpose                                         |
| --------------------------------------------------------------- | --------- | ----------------------------------------------- |
| `~/.paseo/conductor/conductors/<id>/instructions.md`            | You       | Standing instructions for one conductor         |
| `~/.paseo/conductor/conductors/<id>/decisions.md`               | Conductor | One line per decision or outcome                |
| `~/.paseo/conductor/conductors/<id>/notes.md`                   | Conductor | Work in flight, so it can resume after restarts |
| `~/.paseo/conductor/memory/MEMORY.md` plus any `*.md` beside it | Both      | Global memory shared by all conductors          |

Edit any of them from the app: expand a file, change it, and save. Saves are refused if the
conductor changed the file since you opened it, so neither of you overwrites the other. Saving a
conductor's `instructions.md` tells that conductor to re-read it. Core files can be cleared but
not deleted; extra memory files can be added and deleted.

Set `CONDUCTOR_PASEO_HOME` on the daemon to keep this state somewhere else.

## CONDUCTOR.md

An optional file, like `AGENTS.md` but for conductors. Put it in the project root (or a workspace
directory to override it there) with project-specific rules: preferred providers for reviews,
release process, who approves merges, and so on.

- New conductors get its content appended to their system instructions
- Edit it from **Memory and instructions** or from a conductor's page; saving from a conductor's
  page tells that conductor to re-read it
- Files over 32,000 characters are truncated in the instructions; the conductor is pointed at the
  full file

## How it works

```text
You ──▶ Conductor ──create_agent / send_agent_prompt──▶ Workers
          ▲                                               │
          └──── notify-on-finish, permission requests ◀───┘
          ▲
          └──── plugin: stalled, still waiting, interrupted
```

- **Delegation** uses Paseo's built-in tools. Workers are ordinary subagents of the conductor.
- **Results** come from Paseo's notify-on-finish. When the conductor is mid-turn, Paseo steers the
  result into that turn; otherwise it starts a new one. Paseo hides these system messages from the
  visible timeline, so you only see the conductor's replies.
- **Health**: Paseo's notifications live in memory, so the plugin keeps a worker ledger at
  `~/.paseo/conductor/ledger.json` and checks every minute. It tells the conductor (with the same
  hidden message) when a worker:
  - shows no activity for 10 minutes
  - has had a permission request pending for 5 minutes
  - ended its turn while the plugin was offline, such as during a daemon restart

  The conductor decides what to do. The plugin never acts on workers itself.

- **Fresh worktrees**: before Paseo creates a branch-off worktree from the app or SDK, the plugin
  fetches the base branch and fast-forwards the local copy. Diverged local branches are left
  alone; fetch failures are logged and creation continues. Agents' `create_workspace` calls skip
  plugin hooks, so the conductor's playbook runs the same steps itself and branches from
  `origin/<base>`.
- **Identity** is a label: conductors carry `conductor.role=coordinator`. Workers are found
  through Paseo's `paseo.parent-agent-id` label.

## Limitations

- The concurrency limit (4 workers) is a playbook rule, not enforced
- The plugin's health checks start after its first agent event or app request following a daemon
  start, because plugins receive the Paseo API only through those
- Dropdown options are text only; the plugin SDK has no icons for select options
- `CONDUCTOR.md` is read when a conductor is created; existing conductors pick up edits when told
  to re-read it

## Develop

```text
index.server.ts          daemon entry
server/                  monitor, ledger, memory, documents, fresh-base, project instructions
index.client.tsx         app entry
client/                  screens, panel, sidebar, forms, memory editor
shared/                  RPC contracts, settings, playbook, labels
```

```bash
npm install
npm run typecheck && npm run lint && npm test && npm run format
paseo plugin install "$PWD"   # once
paseo plugin reload conductor # after changes
paseo plugin logs conductor
```
