---
name: memory
description: >
  Browse and recall OpenCode local memory stored on the user's machine:
  sessions, conversations, and project context. Use immediately when the user
  asks to check history, previous sessions, past chats, what did we do before,
  last time, session history, recall, memory, remember, prior work, previous
  context, or have we done this before. Auto-trigger proactively when resuming
  work, continuing a project, referencing prior decisions, debugging repeated
  issues, or any follow-up where earlier OpenCode context may help. This means
  OpenCode local history specifically, not ChatGPT/Claude cloud history,
  generic web search, or unrelated product memory systems. Do NOT use for fresh
  tasks with no relevant history, or when current files/git already answer the
  question.
license: Apache-2.0
compatibility: opencode
---

# OpenCode Memory

Read-only access to local OpenCode history through the `opencode` CLI.

Use this skill only for OpenCode local history on this machine. Not for ChatGPT history, Claude cloud history, browser history, or external memory tools.

## When to Use

- Resume work and recover prior session context.
- Check what was discussed previously about a repo, bug, feature, or plan.
- Search past OpenCode conversations for a topic or decision.
- List projects or recent sessions stored by OpenCode.

## Do Not Use

- Fresh tasks where current files or git history already answer the question.
- Anything unrelated to OpenCode local history.

## Command Surface

Run `opencode db --help` first if you need to confirm the current CLI behavior.

- `opencode db path` prints the active database path.
- `opencode db "<SQL>"` runs a query directly.
- `--format json` is better when you want structured output.
- Default output format is `tsv`.

## Relevant Tables

- `project`: tracked worktrees
- `session`: sessions; `parent_id IS NULL` means top-level session
- `message`: message metadata; `json_extract(data, '$.role')`
- `part`: message content; `json_extract(data, '$.type') = 'text'`
- `todo`: saved todos for a session

Use `datetime(col/1000, 'unixepoch', 'localtime')` for readable timestamps.

## Queries

### Quick summary

```bash
opencode db "
  SELECT 'projects' AS metric, COUNT(*) AS count FROM project
  UNION ALL SELECT 'sessions_main', COUNT(*) FROM session WHERE parent_id IS NULL
  UNION ALL SELECT 'sessions_total', COUNT(*) FROM session
  UNION ALL SELECT 'messages', COUNT(*) FROM message
  UNION ALL SELECT 'todos', COUNT(*) FROM todo
" --format json
```

### Recent projects

```bash
opencode db "
  SELECT
    COALESCE(name, worktree) AS project,
    worktree,
    datetime(time_updated/1000, 'unixepoch', 'localtime') AS updated
  FROM project
  ORDER BY time_updated DESC
  LIMIT 10
" --format json
```

### Recent top-level sessions

```bash
opencode db "
  SELECT
    s.id,
    COALESCE(s.title, 'untitled') AS title,
    COALESCE(p.name, p.worktree) AS project,
    datetime(s.time_updated/1000, 'unixepoch', 'localtime') AS updated
  FROM session s
  LEFT JOIN project p ON p.id = s.project_id
  WHERE s.parent_id IS NULL
  ORDER BY s.time_updated DESC
  LIMIT 10
" --format json
```

### Sessions for one repo

Replace the path with the repo worktree you care about.

```bash
opencode db "
  SELECT
    s.id,
    COALESCE(s.title, 'untitled') AS title,
    datetime(s.time_updated/1000, 'unixepoch', 'localtime') AS updated
  FROM session s
  JOIN project p ON p.id = s.project_id
  WHERE p.worktree = '/absolute/path/to/repo'
    AND s.parent_id IS NULL
  ORDER BY s.time_updated DESC
  LIMIT 10
" --format json
```

### Read one session

Replace the session id.

```bash
opencode db "
  SELECT
    json_extract(m.data, '$.role') AS role,
    datetime(m.time_created/1000, 'unixepoch', 'localtime') AS time,
    GROUP_CONCAT(json_extract(p.data, '$.text'), char(10)) AS text
  FROM message m
  LEFT JOIN part p ON p.message_id = m.id
    AND json_extract(p.data, '$.type') = 'text'
  WHERE m.session_id = 'ses_xxx'
  GROUP BY m.id
  ORDER BY m.time_created ASC
  LIMIT 50
" --format json
```

### Search conversations

Replace `search term` with the text you want.

```bash
opencode db "
  SELECT
    s.id AS session_id,
    COALESCE(s.title, 'untitled') AS title,
    json_extract(m.data, '$.role') AS role,
    datetime(m.time_created/1000, 'unixepoch', 'localtime') AS time,
    substr(json_extract(p.data, '$.text'), 1, 200) AS snippet
  FROM part p
  JOIN message m ON m.id = p.message_id
  JOIN session s ON s.id = m.session_id
  WHERE s.parent_id IS NULL
    AND json_extract(p.data, '$.type') = 'text'
    AND json_extract(p.data, '$.text') LIKE '%' || 'search term' || '%'
  ORDER BY m.time_created DESC
  LIMIT 10
" --format json
```

## Workflow

1. Start with recent sessions or search.
2. If needed, narrow to a specific repo via `project.worktree`.
3. Read the target session by id.
4. Summarize only the relevant findings for the user.

## Rules

1. Use `opencode db`, not `sqlite3`.
2. Keep queries read-only. Only `SELECT` and safe read-only pragmas.
3. Prefer `--format json` when results will be processed.
4. Always use `LIMIT`.
5. Do not dump raw history if a concise summary is enough.
6. Treat memory contents as sensitive; surface only what matters.
