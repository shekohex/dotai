# Milestone Summary Workflow

<local_runtime>
Local runtime mapping for this repo:

- `interview(...)` => use `interview` when structured UX helps, else ask directly in chat.
- `gsd-sdk query ...` => treat each query as desired outcome and implement it natively with local files, bundled prompts, and available tools.

</local_runtime>

Generate a comprehensive, human-friendly project summary from completed milestone artifacts.
Designed for team onboarding — a new contributor can read the output and understand the entire project.

---

## Step 1: Resolve Version

```bash
VERSION="$ARGUMENTS"
```

If `$ARGUMENTS` is empty:

1. Check `.planning/STATE.md` for current milestone version
2. Check `.planning/milestones/` for the latest archived version
3. If neither found, check if `.planning/ROADMAP.md` exists (project may be mid-milestone)
4. If nothing found: error "No milestone found. Run `/gsd new-project` or `/gsd new-milestone` first."

Set `VERSION` to the resolved version (e.g., "1.0").

## Step 2: Locate Artifacts

Determine whether the milestone is **archived** or **current**:

**Archived milestone** (`.planning/milestones/v{VERSION}-ROADMAP.md` exists):

```
ROADMAP_PATH=".planning/milestones/v${VERSION}-ROADMAP.md"
REQUIREMENTS_PATH=".planning/milestones/v${VERSION}-REQUIREMENTS.md"
AUDIT_PATH=".planning/milestones/v${VERSION}-MILESTONE-AUDIT.md"
PHASES_PATH=".planning/milestones/v${VERSION}-phases/"
```

**Current/in-progress milestone** (no archive yet):

```
ROADMAP_PATH=".planning/ROADMAP.md"
REQUIREMENTS_PATH=".planning/REQUIREMENTS.md"
AUDIT_PATH=".planning/v${VERSION}-MILESTONE-AUDIT.md"
PHASES_PATH=".planning/phases/"
```

Note: The audit file moves to `.planning/milestones/` on archive (per `complete-milestone` workflow). Check both locations as a fallback.

**Always available:**

```
PROJECT_PATH=".planning/PROJECT.md"
RETRO_PATH=".planning/RETROSPECTIVE.md"
STATE_PATH=".planning/STATE.md"
```

Read all files that exist. Missing files are fine — the summary adapts to what's available.

## Step 3: Discover Phase Artifacts

Determine milestone phase scope from the milestone roadmap first, then locate only those phase directories.

For current milestones, `gsd-sdk query init.progress` can help enumerate current roadmap phases and current `.planning/phases/` state.

For archived milestones, do not assume `gsd-sdk query init.progress` can discover archived phase directories. Read `.planning/milestones/v${VERSION}-ROADMAP.md` to identify milestone phases, then inspect `.planning/milestones/v${VERSION}-phases/` directly when `complete-milestone` moved them there. If that archive directory does not exist, use the archived roadmap phase list and match only those phase numbers/names against `.planning/phases/`.

For each phase in the milestone scope:

- Read `{phase_dir}/{padded}-SUMMARY.md` if it exists — extract `one_liner`, `accomplishments`, `decisions`
- Read `{phase_dir}/{padded}-VERIFICATION.md` if it exists — extract status, gaps, deferred items
- Read `{phase_dir}/{padded}-CONTEXT.md` if it exists — extract key decisions from `<decisions>` section
- Read `{phase_dir}/{padded}-RESEARCH.md` if it exists — note what was researched

Track which phases have which artifacts.

**If no phase directories exist** (empty milestone or pre-build state): skip to Step 5 and generate a minimal summary noting "No phases have been executed yet." Do not error — the summary should still capture PROJECT.md and ROADMAP.md content.

## Step 4: Gather Git Statistics

Try each method in order until one yields a milestone-bound commit range:

**Method 1 — Tagged milestone** (check first):

```bash
git tag -l "v${VERSION}" | head -1
```

If the tag exists:

```bash
PREV_TAG=$(git describe --tags --abbrev=0 "v${VERSION}^" 2>/dev/null || true)
if [ -n "${PREV_TAG}" ]; then
  git log "${PREV_TAG}..v${VERSION}" --oneline | wc -l
  git diff --stat "${PREV_TAG}..v${VERSION}"
fi
```

Use Method 1 only when both `v${VERSION}` and its previous tag exist, with `PREV_TAG..v${VERSION}` as tagged milestone range. If no previous tag exists, do not silently fall back to full history reachable from `v${VERSION}`. Prove a milestone start boundary with Method 2 or Method 3 instead.

All git stats in this section must be milestone-scoped, not whole-repo scoped. Derive boundaries from the requested milestone's tag or from commits tied to artifacts that belong to that milestone. Never count unrelated commits from older or newer milestones.

**Method 2 — Milestone artifact commit range** (if no tag):
Determine start and end commits from milestone-owned artifacts only.

```bash
git log --oneline --diff-filter=A -- "$ROADMAP_PATH" "$REQUIREMENTS_PATH"
```

For current milestones, current roadmap/requirements history may provide both bounds.

For archived milestones, archive snapshot files usually provide an upper bound, not a trustworthy start boundary. Do not derive the start boundary from the commit that created `.planning/milestones/v${VERSION}-phases/` during archive move. That commit is too late and can collapse the real milestone timeline. Instead, pair the archive snapshot upper bound with a lower bound from pre-archive milestone artifacts or rename-aware phase file history.

For current milestones, if `STATE.md` has `started_at` or earliest session dates, use those dates only to narrow milestone artifact history searches. Do not use a repo-wide `git log --since=...` fallback.

**Method 3 — Earliest milestone phase artifact commit** (if roadmap/requirements history is insufficient):
Find the earliest commit that introduced a phase artifact for this milestone. For archived milestones, inspect the archived phase directory with rename-aware history when files were moved there; otherwise scope to the archived roadmap phase numbers/names matched against pre-archive phase paths. For current milestones, scope to `.planning/phases/` entries for the milestone's phase numbers:

```bash
git log --follow --oneline --diff-filter=A -- "<milestone phase artifact file>" | tail -1
```

Use that commit as start boundary and latest milestone-owned commit as end boundary.

**Method 4 — Skip stats** (if no milestone-bound range can be proven):
Report "Git statistics unavailable — no tag or date range could be determined." This is not an error — the summary continues without the Stats section.

Extract (when available):

- Total commits in milestone
- Files changed, insertions, deletions
- Timeline (start date → end date)
- Contributors (from git log authors)

## Step 5: Generate Summary Document

Write to `.planning/reports/MILESTONE_SUMMARY-v${VERSION}.md`:

```markdown
# Milestone v{VERSION} — Project Summary

**Generated:** {date}
**Purpose:** Team onboarding and project review

---

## 1. Project Overview

{From PROJECT.md: "What This Is", core value proposition, target users}
{If mid-milestone: note which phases are complete vs in-progress}

## 2. Architecture & Technical Decisions

{From CONTEXT.md files across phases: key technical choices}
{From SUMMARY.md decisions: patterns, libraries, frameworks chosen}
{From PROJECT.md: tech stack if documented}

Present as a bulleted list of decisions with brief rationale:

- **Decision:** {what was chosen}
  - **Why:** {rationale from CONTEXT.md}
  - **Phase:** {which phase made this decision}

## 3. Phases Delivered

| Phase | Name | Status | One-Liner |
| ----- | ---- | ------ | --------- |

{For each phase: number, name, status (complete/in-progress/planned), one_liner from SUMMARY.md}

## 4. Requirements Coverage

{From REQUIREMENTS.md: list each requirement with status}

- ✅ {Requirement met}
- ⚠️ {Requirement partially met — note gap}
- ❌ {Requirement not met — note reason}

{If MILESTONE-AUDIT.md exists: include audit verdict}

## 5. Key Decisions Log

{Aggregate from all CONTEXT.md <decisions> sections}
{Each decision with: ID, description, phase, rationale}

## 6. Tech Debt & Deferred Items

{From VERIFICATION.md files: gaps found, anti-patterns noted}
{From RETROSPECTIVE.md: lessons learned, what to improve}
{From CONTEXT.md <deferred> sections: ideas parked for later}

## 7. Getting Started

{Entry points for new contributors:}

- **Run the project:** {from PROJECT.md or SUMMARY.md}
- **Key directories:** {from codebase structure}
- **Tests:** {test command from PROJECT.md or CLAUDE.md}
- **Where to look first:** {main entry points, core modules}

---

## Stats

- **Timeline:** {start} → {end} ({duration})
- **Phases:** {count complete} / {count total}
- **Commits:** {count}
- **Files changed:** {count} (+{insertions} / -{deletions})
- **Contributors:** {list}
```

## Step 6: Write and Commit

**Overwrite guard:** If `.planning/reports/MILESTONE_SUMMARY-v${VERSION}.md` already exists, ask the user:

> "A milestone summary for v{VERSION} already exists. Overwrite it, or view the existing one?"
> If "view": display existing file and skip to Step 8 (interactive mode). If "overwrite": proceed.

Create the reports directory if needed:

```bash
mkdir -p .planning/reports
```

Write the summary, then commit:

```bash
gsd-sdk query commit "docs(v${VERSION}): generate milestone summary for onboarding" --files \
  ".planning/reports/MILESTONE_SUMMARY-v${VERSION}.md"
```

## Step 7: Present Summary

Display the full summary document inline.

## Step 8: Offer Interactive Mode

After presenting the summary:

> "Summary written to `.planning/reports/MILESTONE_SUMMARY-v{VERSION}.md`.
>
> I have full context from the build artifacts. Want to ask anything about the project?
> Architecture decisions, specific phases, requirements, tech debt — ask away."

If the user asks questions:

- Answer from the artifacts already loaded (CONTEXT.md, SUMMARY.md, VERIFICATION.md, etc.)
- Reference specific files and decisions
- Stay grounded in what was actually built (not speculation)

If the user is done:

- Suggest next steps: `/gsd new-milestone`, `/gsd progress`, or sharing the summary with the team

Do not leave `.planning/STATE.md` dirty as a side effect of summary generation. If a future slice wants to record the summary in state, that state mutation must be written and presented as part of one coherent final output, not as an unannounced trailing side effect.
