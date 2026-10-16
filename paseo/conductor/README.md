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

| Field         | Notes                                                                      |
| ------------- | -------------------------------------------------------------------------- |
| Project       | Always starts in a new workspace. Workers can still get their own worktree |
| New worktree  | Off: the project's main checkout. On: a fresh worktree                     |
| Branch        | With a new worktree: the base branch. Empty uses the project default       |
| Provider      | Only providers that are enabled and ready on the host                      |
| Model         | The provider's selectable models                                           |
| Reasoning     | The model's reasoning levels, when it has any                              |
| Title         | Shown in the sidebar                                                       |
| First message | Optional. Defaults to a short readiness check                              |

Project, worktree toggle, provider, model, and reasoning are remembered as soon as you pick them.

**Start conductor in this project** in the Command Center opens the form with the current
workspace's project selected.

### Progress

Every agent gets a `progress` tool from a local MCP server the plugin runs under the key
`conductor` (`mcp__conductor__progress` in Claude and Pi, where it is found via tool_search, `conductor.progress` in Codex). It also serves
the guide and the live state as resources (`conductor://progress/guide`, `conductor://progress/state`).
Agents outside a conductor see no tools or resources. Pi lists tools while its agent is still
being created, before Paseo records the parent, so an agent the plugin can't place yet gets the tool
anyway, checked on each call. `paseo plugin logs conductor` says why an agent got no tool or a
checked one ("progress tool hidden from …", "served gated to …", "unknown token"), and the startup
line gives the build (`Conductor plugin 0.1.0 #<code hash>`) to compare machines. The conductor and its
workers use it to record tickets, stages, questions, blockers, and deliverables. Workers resolve to
their parent conductor, so everything lands in one shared log,
`~/.paseo/conductor/conductors/<id>/progress.jsonl`, next to the notes. You see it live in the
conductor screen, the Conductor panel, the **Progress** panel, and the **Progress** pill above the
composer, and you can answer questions from there. The conductor reads the same state with `op=show`, and `op=help`
prints the full usage guide.

Questions can be single or multiple choice (`multi=true`). When a worker asks, the conductor gets a
short note and answers it if the brief already decides it; otherwise the question waits for you.
Every answer, yours or the conductor's, goes to the agent that asked, and your answers also go to
the conductor. The feed marks who answered each question.

In the chat, these notes show as a small chip ("You answered Q3: B") that expands on tap, and
progress tool calls show as cards per action; `op=show` draws the percent bar and counts. The
playbook has the conductor wrap what it sends workers in `<conductor-brief>`, which a worker's chat
shows as a collapsed "From the conductor" card. Check-ins show as a chip too.

The dashboard opens with the run's title, a headline ("2 of 5 tickets done, 1 question waiting
for you, 1 stuck"), what is happening now, and a progress bar with one segment per ticket weighted
by its estimate. Each segment fills as far as its ticket has come: the percent the agent reported,
or else time worked against the estimate, capped at 90% so time alone never claims a ticket done.
Below it: open questions, anything stuck (blocked tickets, tickets past their estimate without an
update, and flagged blockers), and the tickets with their stage, percent, labels, and agents
(finished ones fold into one row). Each row stays short: title, stage and what the agent is
doing now, a bar with time worked against the estimate and the ETA, and up to three chips with a
"+N more" chip for the rest. Working and blocked tickets come first, 8 at a time ("Show N
more"). From 6 tickets up, the card gets a GitHub-style search (`status:working label:ui
agent:ada is:blocked is:overdue stage:review ticket:3 sort:eta`, words, `-` to negate). Typing
suggests keys, then the values in the run with counts (fuzzy: `label:nr` finds "needs review");
Status, Label, and Agent dropdowns pick several values at once, and active filters show as
removable chips, a "12 of 30" count, and a sort (recent activity, status, most overdue,
created, percent). An agent's chip lists the tickets it works now; one agent may work several.
The feed's three tabs share their own search and Kind, Label, Agent, and Ticket dropdowns,
group entries by day, and can follow the ticket search ("Only searched tickets"). Search and sort
are saved per conductor.

The feed reads like a commit log: each entry has a kind (feat, fix, test, research, ...) shown as
an icon, a short title, the ticket and agent as colored chips (the same name always gets the same
color), and how long ago. Press an entry for its details: the body, when it started, how long it
took, who, and its ticket. The dashboard warns when nothing was recorded for 15 minutes while no
agent runs, and uses two columns when it has room.

A blocked ticket goes back to working on its own when its question is answered or its agent posts
another update, and a stuck flag clears with its agent's next update. A ticket blocked or stuck
for 10 minutes (Settings, "Tell the conductor about blockers") gets one short note to the
conductor to answer, unblock, or reassign it; repeats every 30 minutes, three times at most. A
blocker waiting on your answer only shows "Waiting on you" on the dashboard. An agent that starts
running again while its ticket is still blocked gets a one-line reminder to update it. These notes
show as small chips in chat.

When a working ticket gets no update for 15 minutes, the plugin sends its agent a short check-in
note (at most three per quiet spell; any update starts over), only while the agent is idle or
running. **Settings → Conductor** turns check-ins off or changes the minutes.

Tickets link like GitHub issues. `op=ticket` takes `waitsFor=[...]` (it can't start before
those finish; it shows as waiting, then ready, never as stuck), `parent=` (a sub-task; the parent's
percent rolls up from its sub-tasks by estimate, the run's percent counts each piece of work once,
and the parent closes itself when every sub-task is done), and `related=[...]`. Loops, self links,
and unknown ids are refused with the run's ids listed. Writing `#AI-03` or `#3` in any note, update,
question, or ticker shows a tappable chip and a "Mentioned in" backlink. The ticket dialog lists
everything under Linked (waiting on, blocks, parent, sub-tasks with "3/5" and their bars, related,
mentioned in); rows show sub-task and waits-for chips, and sub-tasks sit indented under their
parent. Search adds `parent:`, `waits:`, `blocks:`, `has:children`, `is:ready`, and `is:waiting`.

Ticket ids read T01, T02 by default. Give a conductor a ticket prefix of 1-3 letters or digits
(the New conductor form's "Ticket prefix", or "Change prefix…" under the dashboard) and they read
AI-01, AI-02 instead; changing it relabels every ticket at once and tells the conductor. Agents may
write AI-03, T03, or just 3; `op=show` and `op=help` use the prefix. Q, S, and D stay reserved for
questions, stuck flags, and deliverables.

Press a ticket for its story: its percent, time worked and the ETA left, who is on it (open their
chat), and a timeline rail of its steps with how long each took, its activity, and every revised
estimate and percent, newest first and grouped by day. Tabs list the activity, questions, and deliverables tagged to
it. Answer a question from its dialog by picking an option (with an optional note) or in your own
words; the conductor gets the answer right away. Deliverables, write-ups, and files attached to
questions preview in the app (images up to 10 MB, text up to 256 KB) with Previous and Next;
Markdown files render as documents, other text shows as plain source. Links open in Paseo's
browser. **Open** on any other file (video, audio, PDF, ...) starts a temporary media server on
`127.0.0.1` and opens its page, which plays the file and has a **Close server** button. When
Tailscale is running, the page is shared on your tailnet with `tailscale serve` so other devices
can open it; it is never exposed with `tailscale funnel`. The server stops on Close server, after
10 minutes without requests, or when the plugin unloads, and removes its `tailscale serve` path.
Every URL carries a random token, and only items agents recorded on the run can be opened.

The **Progress** pill counts what needs you ("2 questions", "2Q · 1 stuck"); its popover lets you
answer without leaving the chat, or shows the whole dashboard when nothing is waiting. **Run
history** mirrors each run into a folder of the conductor's workspace, one file per run, so runs
can be committed.

The dashboard's layout and motion are ported from Steve Castaneda's
[Progress plugin](https://github.com/stevecastaneda/paseo-plugins/tree/main/progress) (MIT).

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

The sidebar lists every conductor with a count of workers that need you. Two panels sit beside
Files and Changes in the explorer (its **+** menu) or as workspace tabs: **Conductor** shows the
same detail as the screen, and **Progress** shows only the progress dashboard. Both follow the
workspace: its conductor, or the conductor of a worker running in it (including workers of
workers), with a picker when several conductors work there. The Command Center opens them with
**Open conductor panel** and **Open conductor progress**.

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
- The plugin API has no way to open a file in Paseo's own file viewer, so previews are drawn by the
  plugin; its Markdown renderer covers headings, lists, quotes, tables, code, and inline styles
- Dropdown options are text only; the plugin SDK has no icons for select options
- `CONDUCTOR.md` is read when a conductor is created; existing conductors pick up edits when told
  to re-read it

## Develop

```text
index.server.ts          daemon entry
server/                  monitor, ledger, memory, documents, fresh-base, project instructions,
                         progress MCP server, media server
index.client.tsx         app entry
client/                  screens, panels, sidebar, forms, memory editor
client/progress/         progress dashboard, dialogs, Markdown renderer, and composer pill
shared/                  RPC contracts, settings, playbook, labels, progress state, Markdown parser
```

```bash
npm install
npm run typecheck && npm run lint && npm test && npm run format
paseo plugin install "$PWD"   # once
paseo plugin reload conductor # after changes
paseo plugin logs conductor
```
