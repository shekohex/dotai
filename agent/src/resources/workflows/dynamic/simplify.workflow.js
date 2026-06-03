export const meta = {
  name: "simplify",
  description: "Review changed code for reuse, quality, and efficiency, then fix any issues found",
  phases: [{ title: "Code Review" }, { title: "Fix Issues" }],
};

const diffCommand = (args && args.diffCommand) || "git diff";
const status = (args && args.status) || "";
const stat = (args && args.stat) || "";
const userContext = (args && args.context) || "";
const commandContext = [
  "Before reviewing, run this command with the bash tool to inspect the full diff:",
  diffCommand,
  "",
  "Changed files:",
  status.trim().length > 0 ? status : "No git status output was available.",
  "",
  "Diff stat:",
  stat.trim().length > 0 ? stat : "No git diff stat was available.",
  "",
  "Fallback context:",
  userContext.trim().length > 0 ? userContext : "No fallback context was provided.",
].join("\n");

phase("Code Review");
const reuseReviewPrompt = [
  "Code Reuse Review",
  "",
  "For each change:",
  "",
  "1. Search for existing utilities and helpers that could replace newly written code. Look for similar patterns elsewhere in the codebase — common locations are utility directories, shared modules, and files adjacent to the changed ones.",
  "2. Flag any new function that duplicates existing functionality. Suggest the existing function to use instead.",
  "3. Flag any inline logic that could use an existing utility — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns are common candidates.",
  "",
  commandContext,
].join("\n");
const qualityReviewPrompt = [
  "Code Quality Review",
  "",
  "Review the same changes for hacky patterns:",
  "",
  "1. Redundant state: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls",
  "2. Parameter sprawl: adding new parameters to a function instead of generalizing or restructuring existing ones",
  "3. Copy-paste with slight variation: near-duplicate code blocks that should be unified with a shared abstraction",
  "4. Leaky abstractions: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries",
  "5. Stringly-typed code: using raw strings where constants, enums (string unions), or branded types already exist in the codebase",
  "6. Unnecessary JSX nesting: wrapper Boxes/elements that add no layout value — check if inner component props (flexShrink, alignItems, etc.) already provide the needed behavior",
  "",
  commandContext,
].join("\n");
const efficiencyReviewPrompt = [
  "Efficiency Review",
  "",
  "Review the same changes for efficiency:",
  "",
  "1. Unnecessary work: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns",
  "2. Missed concurrency: independent operations run sequentially when they could run in parallel",
  "3. Hot-path bloat: new blocking work added to startup or per-request/per-render hot paths",
  "4. Recurring no-op updates: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers aren't notified when nothing changed. Also: if a wrapper function takes an updater/reducer callback, verify it honors same-reference returns (or whatever the \"no change\" signal is) — otherwise callers' early-return no-ops are silently defeated",
  "5. Unnecessary existence checks: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error",
  "6. Memory: unbounded data structures, missing cleanup, event listener leaks",
  "7. Overly broad operations: reading entire files when only a portion is needed, loading all items when filtering for one",
  "",
  commandContext,
].join("\n");
const reviews = await parallel([
  () => agent(reuseReviewPrompt, { label: "reuse-review", mode: "fast-review" }),
  () => agent(qualityReviewPrompt, { label: "quality-review", mode: "cheap-review" }),
  () => agent(efficiencyReviewPrompt, { label: "efficiency-review", mode: "review" }),
]);

phase("Fix Issues");
const fixPrompt = [
  "Use the review findings below as an implementation checklist. Verify each finding against the current code and diff, then fix every real issue directly in the working tree.",
  "",
  "If a finding is a false positive or not worth addressing, call it out under skipped findings with a short reason. Do not argue with the finding. Keep moving.",
  "",
  "Clean up any small issues you create while fixing. Keep changes surgical. When done, briefly summarize what was fixed, what was skipped, and whether the code was already clean.",
  "",
  commandContext,
  "",
  "Review findings:",
  JSON.stringify(reviews),
].join("\n");
const fixes = await agent(fixPrompt, { label: "simplify-fixer", mode: "build" });

return { reviews, fixes };
