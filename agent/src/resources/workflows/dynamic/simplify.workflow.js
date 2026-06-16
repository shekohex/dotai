export const meta = {
  name: "simplify",
  description:
    "Review changed code for reuse, simplification, efficiency, and altitude, then fix safe issues found",
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

const cleanupReviewContract = [
  "You are improving the quality of the changed code, not hunting for correctness bugs. Do not report security, reliability, or behavior bugs unless they are direct evidence that the cleanup would change intended behavior and should be skipped.",
  "Review only issues introduced or materially worsened by the changed code in the diff.",
  "For every finding, include file, line, one-line summary, concrete cost, and a tag: delete, stdlib, native, yagni, shrink, reuse, simplify, efficiency, or altitude.",
  "Skip style preferences, broad rewrites, and improvements that require changes well outside the reviewed diff.",
  "Never simplify away input validation at trust boundaries, error handling that prevents data loss, security measures, accessibility basics, explicitly requested behavior, or the smallest runnable check for non-trivial logic.",
].join("\n");

const ponytailLadder = [
  "Apply the lazy-senior-developer ladder before proposing code:",
  "1. Does this need to exist at all? If speculative, tag delete or yagni.",
  "2. Does the standard library already do it? Tag stdlib and name the function/API.",
  "3. Does the native platform already do it? Tag native and name the feature.",
  "4. Does an already-installed dependency solve it? Reuse it; do not add a new dependency for a few lines of code.",
  "5. Can the same behavior be one line or fewer files? Tag shrink.",
  "6. Only then accept the minimum custom code that works.",
].join("\n");

phase("Code Review");
const reuseReviewPrompt = [
  "Code Reuse Review",
  "",
  cleanupReviewContract,
  "",
  ponytailLadder,
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
  "Simplification Review",
  "",
  cleanupReviewContract,
  "",
  ponytailLadder,
  "",
  "Review the same changes for unnecessary complexity and hacky patterns:",
  "",
  "1. Redundant state: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls",
  "2. Parameter sprawl: adding new parameters to a function instead of generalizing or restructuring existing ones",
  "3. Copy-paste with slight variation: near-duplicate code blocks that should be unified with a shared abstraction",
  "4. Leaky abstractions: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries",
  "5. Stringly-typed code: using raw strings where constants, enums (string unions), or branded types already exist in the codebase",
  "6. Unnecessary JSX nesting: wrapper Boxes/elements that add no layout value — check if inner component props (flexShrink, alignItems, etc.) already provide the needed behavior",
  "7. Single-implementation interfaces, factories with one product, config nobody sets, wrappers that only delegate, files exporting one thing, dead flags, and speculative extension points",
  "8. Hand-rolled standard-library or platform features: validators, sorters, date formatting, path/string helpers, caches, retries, and custom lifecycle code that the runtime already provides",
  "",
  commandContext,
].join("\n");
const efficiencyReviewPrompt = [
  "Efficiency Review",
  "",
  cleanupReviewContract,
  "",
  ponytailLadder,
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
const altitudeReviewPrompt = [
  "Altitude Review",
  "",
  cleanupReviewContract,
  "",
  ponytailLadder,
  "",
  "Review the same changes for code at the wrong abstraction level:",
  "",
  "1. Logic placed too low or too high: policy/business decisions buried in UI glue, CLI parsing, render functions, or infrastructure wrappers",
  "2. Helpers that are too specific for shared locations, or too generic for one call site",
  "3. New abstractions that hide the important operation instead of naming it clearly",
  "4. Cross-layer leakage: persistence, network, UI, domain, and orchestration concerns mixed where existing architecture keeps them separate",
  "5. Missed composition: changed code should reuse or compose existing modules instead of adding another parallel path",
  "6. File/module growth: new responsibilities that should stay near an existing owner rather than expanding a catch-all file",
  "",
  commandContext,
].join("\n");
const reviews = await parallel([
  () => agent(reuseReviewPrompt, { label: "reuse-review", mode: "fast-review" }),
  () => agent(qualityReviewPrompt, { label: "simplification-review", mode: "cheap-review" }),
  () => agent(efficiencyReviewPrompt, { label: "efficiency-review", mode: "review" }),
  () => agent(altitudeReviewPrompt, { label: "altitude-review", mode: "review" }),
]);

phase("Fix Issues");
const fixPrompt = [
  "Use the review findings below as an implementation checklist. Verify each finding against the current code and diff, then fix every real issue directly in the working tree.",
  "",
  "Deduplicate findings that point at the same line or mechanism. Keep the clearest version with the most concrete cost.",
  "",
  "Prefer deletion over addition, stdlib/native/platform features over custom code, existing dependencies over new dependencies, and fewer files over more files.",
  "",
  "Skip any finding whose fix would change intended behavior, require changes well outside the reviewed diff, or that you judge to be a false positive. Call skipped findings out with a short reason. Do not argue with the finding. Keep moving.",
  "",
  "Do not remove trust-boundary validation, data-loss prevention, security checks, accessibility basics, explicitly requested behavior, or the smallest runnable check for non-trivial logic.",
  "",
  "If you intentionally leave a shortcut with a known ceiling, add a concise comment only when future readers would otherwise mistake it for ignorance. The comment must name the ceiling and upgrade trigger.",
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
