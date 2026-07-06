# Pi Conductor Context

Pi Conductor defines how GitHub project work becomes visible, steerable Pi coding sessions through Herdr.

## Language

**Conductor**:
The orchestrator that claims GitHub work, creates workspaces, starts Pi sessions, routes follow-ups, and records lifecycle state.
_Avoid_: TUI, dashboard, terminal UI

**Operator Console**:
The live terminal interface where the operator watches and steers running Pi sessions.
_Avoid_: Conductor UI, custom kanban UI

**Pi Session**:
A long-lived Pi coding-agent process attached to one active issue or pull request lifecycle.
_Avoid_: one-shot job, task run

**Prompt Artifact**:
The generated prompt file written into a run workspace and passed to Pi as an `@file` argument for auditability.
_Avoid_: transient pasted prompt, hidden launch argument

**Run Location**:
The Herdr workspace/tab where a Pi session is visible; workspaces map to repositories and tabs map to issues or pull requests.
_Avoid_: durable session identity, pane id

**Run Workspace**:
The filesystem checkout where one Pi session edits code, normally a conductor-created git worktree for one issue or pull request.
_Avoid_: Herdr workspace, main checkout

**Branch Template**:
A repository policy string used to derive predictable conductor branch names from work item fields.
_Avoid_: hard-coded branch prefix, random branch name

**Launch Rule**:
An ordered repository workflow rule that matches issue labels or GitHub Project fields and produces Pi launch flags.
_Avoid_: hard-coded mode choice, unordered label map

**Work Item**:
A GitHub Project item linked to a GitHub issue and normalized for conductor decisions.
_Avoid_: draft card, generic ticket

**Managed Project**:
A GitHub Project and repository pair that the conductor is allowed to scan, claim, and dispatch into Pi sessions.
_Avoid_: any repository, unconfigured board

**Dispatch Label**:
The configurable GitHub issue label that marks a work item as eligible for conductor dispatch when other ownership rules also match.
_Avoid_: hard-coded agent label, project status

**Assigned Work Item**:
A work item whose linked GitHub issue is assigned to the authenticated `gh` account running conductor.
_Avoid_: unowned ready item, team-wide queue item

**Lifecycle Status**:
The conductor's internal status vocabulary for project-card movement: `draft`, `ready`, `in_progress`, `in_review`, `done`, and `blocked`.
_Avoid_: raw GitHub option name, run phase

**Reconciliation**:
The conductor process of fetching current GitHub state and repairing missed, duplicate, delayed, or out-of-order events.
_Avoid_: webhook handling, polling only

**Paused Run**:
A run whose Pi session remains alive in Herdr while conductor automation stops sending follow-ups and lifecycle mutations.
_Avoid_: stopped run, suspended process

**Follow-Up**:
A queued or delivered message from conductor or operator to the owning Pi session after initial dispatch.
_Avoid_: new task, separate run

**Run ID**:
A durable conductor identifier formatted as `owner__repo__issue__uuidv7` for commands, logs, and state references.
_Avoid_: Herdr pane id, Pi session id

**Conductor State Store**:
The local SQLite database that persists conductor run, session, follow-up, and audit state across commands and restarts.
_Avoid_: project cache, Herdr state
