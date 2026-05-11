---
name: plannotator-visual-explainer
description: >
  Generate beautiful, self-contained HTML visualizations themed with Plannotator's design system.
  Wraps the visual-explainer skill by nicobailon with Plannotator theme token integration. Use for
  architecture diagrams, diff reviews, plan reviews, data tables, slide decks, project recaps, or
  any visual explanation of technical concepts — whenever you want output styled consistently with
  Plannotator's UI and compatible with --render-html annotation. Triggers on the same prompts as
  visual-explainer (diagrams, architecture overviews, visual plans, diff reviews) but produces
  output that uses Plannotator CSS custom properties instead of custom palettes.
---

# Plannotator Visual Explainer

This skill wraps [visual-explainer](https://github.com/nicobailon/visual-explainer) by Nico Bailon with Plannotator theme integration and additional component patterns. You follow visual-explainer's workflow, references, templates, and anti-slop rules — with Plannotator's color/typography tokens and extended patterns for plans and technical documents.

## Theme Override

Instead of visual-explainer's custom palettes and font pairings, use Plannotator's semantic theme tokens. Read `references/theme-override.md` for the exact CSS custom properties and mapping table. Apply these **after** reading visual-explainer's references — they replace only the color and typography layer.

## Extended Patterns

Plannotator adds component patterns that complement visual-explainer's toolkit. Read `references/extended-patterns.md` for timelines, inline SVG diagrams, code blocks with syntax highlighting, risk tables, and open question callouts. Use these alongside Nico's `.ve-card`, `.kpi-card`, `.pipeline` components — they share the same theme tokens.

## Design Philosophy: Use the Power of HTML

The point of generating HTML instead of markdown is spatial layout. Don't pack every piece of information into dense cards. Let the page breathe.

- **Whitespace is a feature.** Generous padding, large section gaps, breathing room between cards. If a section feels cramped, it needs more space, not smaller text.
- **One idea per viewport.** The reader should be able to absorb one concept at a time as they scroll. A hero section, then a diagram, then a detail grid — not all three crammed together.
- **Visual weight signals importance.** Hero sections dominate (large type, accent-tinted backgrounds, more padding). Supporting details are compact and can collapse. Not everything deserves equal treatment.
- **Show, don't describe.** A timeline shows sequencing. A diagram shows relationships. A before/after grid shows change. A code block shows the interface. Use the right visual element — don't describe things in prose that a component could show directly.
- **Timelines show sequence without estimates.** Show the phases and their dependencies, but do not attach hour/day/week estimates. AI consistently misjudges timing. Showing phases in order communicates sequencing; attaching numbers communicates false precision.

## Workflow

1. **Read** visual-explainer's SKILL.md (full workflow, diagram types, quality checks)
2. **Read** the relevant visual-explainer references and templates for your content type
3. **Read** `references/theme-override.md` for Plannotator color/typography tokens
4. **Read** `references/extended-patterns.md` for additional components (timelines, code blocks, risk tables, SVG diagrams)
5. **Generate** following visual-explainer's structure and rules, with Plannotator tokens and extended patterns. Use Nico's component classes (`.ve-card`, `.ve-card--hero`, `.kpi-card`, `.pipeline`, etc.) for cards and layout. Use the extended patterns for timelines, code blocks, risk tables, and SVG diagrams.
6. **Deliver** via Plannotator's annotation UI:

**If the output is a plan or proposal** (something the user should approve/deny):

```bash
plannotator annotate <file> --render-html --gate
```

**If the output is a visual explainer, diagram, or informational page:**

```bash
plannotator annotate <file> --render-html
```

Always use `--render-html` so the HTML renders as-is in the Plannotator UI with theme inheritance and annotation support. Do NOT use `open` or `xdg-open` directly.

## What visual-explainer provides (do not duplicate)

All of these come from visual-explainer — read them there, don't reinvent them:

- Diagram type routing (architecture, flowchart, sequence, ER, state, mind map, etc.)
- Mermaid integration (theming, zoom controls, scaling, layout direction)
- CSS structural patterns (ve-card, grids, connectors, depth tiers, collapsibles)
- Slide deck mode (viewport-snapping presentations)
- Data table patterns (sticky headers, status indicators, responsive scrolling)
- Anti-slop rules (forbidden fonts, colors, animations, patterns)
- Quality checks (squint test, swap test, overflow protection)
- Animation guidelines (staggered entrance, reduced-motion support)

## Plan-specific guidance

When the output is an implementation plan, design doc, or proposal:

**Adapt the visual vocabulary to the task:**

- **Backend/API work**: Lead with data flow diagrams, schemas, API signatures
- **Frontend/UI work**: Lead with mockups, component hierarchy, state flow
- **Infrastructure/DevOps**: Lead with architecture diagrams, deployment flow
- **Refactoring**: Lead with before/after diagrams showing structural change
- **Cross-cutting features**: Lead with a system map showing all touchpoints

**Section menu — pick what fits:**
Solution overview, architecture/data flow diagram, UI mockups, key code, integration points, risks & mitigations, open questions, considerations & rationale, reusability & code quality. Not every plan needs every section — choose what serves the content.

**What NOT to include in plans:**

- Time estimates (timelines showing sequence are fine, hour/day estimates are not)
- Boilerplate sections that would just say "N/A"
- Exhaustive file lists — show the important files, not every file touched

**Quality bar for plans:** The plan should answer "what are we building, why, and how" within 30 seconds of reading.

## PR explainer guidance

When the output is a PR walkthrough, diff review, or code change explainer:

- **TL;DR first** — a bordered card summarizing what the PR does and why, so readers who skim get the gist
- **Risk map** — visual chips showing which files need careful review vs. which are mechanical
- **Inline diffs** — use the diff rendering pattern from `references/extended-patterns.md` for important hunks (not every hunk)
- **File-by-file commentary** — collapsible cards per file with a "why" paragraph explaining the purpose of changes
- **"Where to focus"** — numbered callouts telling reviewers exactly what to look at and why
- **Before/after comparison** — two-column grid for behavior changes

See `references/extended-patterns.md` for diff rendering, review comment bubbles, and file badge patterns.

## What this skill adds

- Plannotator theme tokens (colors, typography, radii) — see `references/theme-override.md`
- Extended component patterns (timelines, code blocks, risk tables, SVG diagrams, open questions) — see `references/extended-patterns.md`
- Plan-specific guidance (section menu, adaptation by task type, quality bar)
- `--render-html` delivery with annotation support and theme inheritance
- Design philosophy emphasizing spatial layout, breathing room, and visual hierarchy
