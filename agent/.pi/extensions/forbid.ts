import { homedir } from "node:os";
import { posix, relative, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const GLOBS: Array<readonly [glob: string, reason: string]> = [
  [
    "**/.oxfmtrc.json",
    "You are not allowed to edit this file. Ask the user to modify it instead for you.",
  ],
  [
    "**/.oxlintrc.json",
    "You are not allowed to edit this file. You should not bypass the linter rules, if something is must be fixed, ask the user to fix it instead.",
  ],
];

const RULES = GLOBS.map(([glob, reason]) => ({ glob: normalizePathForGlob(glob), reason }));
const PATH_TOKEN_PATTERN =
  /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`|([^\s"'`<>|&;]+)/g;
const REDIRECTION_TARGET_PATTERN =
  /(?:^|[\s;|&])(?:>|>>|1>|1>>|2>|2>>|&>|&>>)\s*("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`|[^\s"'`|&;]+)/g;
const ARG_PATH_MUTATION_PATTERN =
  /\b(?:rm|mv|chmod|chown|chgrp|touch|truncate|tee)\b|\bgit\s+(?:rm|mv|checkout|restore|reset|clean|apply)\b|\b(?:sed|perl)\b[^\n;|&]*\s-i(?:\S*)?(?:\s|$)|\bawk\b[^\n;|&]*\s-i\s+inplace\b/i;
const DELETE_PATTERN = /\b(?:rm|git\s+rm)\b/i;
const PATCH_MUTATION_HEADER = /^\*\*\* (?:Add|Delete|Update) File:/m;

type PatchOperation = "add" | "delete" | "update" | "move";

function normalizePathForGlob(value: string): string {
  return posix.normalize(value.replaceAll("\\", "/"));
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value.at(0);
  const last = value.at(-1);
  if ((first === '"' || first === "'" || first === "`") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return `${homedir()}/${value.slice(2)}`;
  }
  return value;
}

function toMatchCandidates(pathValue: string, cwd: string): string[] {
  const expanded = expandHomePath(pathValue);
  const raw = normalizePathForGlob(expanded);
  const absolute = normalizePathForGlob(resolve(cwd, expanded));
  const relativeToCwd = normalizePathForGlob(relative(cwd, absolute));
  return [
    ...new Set(
      [raw, absolute, relativeToCwd].filter(
        (candidate) => candidate.length > 0 && candidate !== ".",
      ),
    ),
  ];
}

function findMatchingRule(
  pathValue: string,
  cwd: string,
): { glob: string; reason: string } | undefined {
  const candidates = toMatchCandidates(pathValue, cwd);
  for (const candidate of candidates) {
    for (const rule of RULES) {
      if (posix.matchesGlob(candidate, rule.glob)) {
        return rule;
      }
    }
  }
  return undefined;
}

function isPathLikeToken(token: string): boolean {
  if (!token || token === "--") {
    return false;
  }
  if (token.startsWith("-") || token.startsWith("$")) {
    return false;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
    return false;
  }
  if (token.includes("/") || token.startsWith(".") || token.startsWith("~")) {
    return true;
  }
  return token.includes(".");
}

function extractPathTokens(command: string): string[] {
  PATH_TOKEN_PATTERN.lastIndex = 0;
  const paths: string[] = [];
  let match = PATH_TOKEN_PATTERN.exec(command);
  while (match) {
    const rawToken = match[0];
    const token = stripWrappingQuotes(rawToken);
    if (isPathLikeToken(token)) {
      paths.push(token);
    }
    match = PATH_TOKEN_PATTERN.exec(command);
  }
  return paths;
}

function extractRedirectionTargets(command: string): string[] {
  REDIRECTION_TARGET_PATTERN.lastIndex = 0;
  const targets: string[] = [];
  let match = REDIRECTION_TARGET_PATTERN.exec(command);
  while (match) {
    const token = stripWrappingQuotes(match[1] ?? "");
    if (isPathLikeToken(token)) {
      targets.push(token);
    }
    match = REDIRECTION_TARGET_PATTERN.exec(command);
  }
  return targets;
}

function findBlockedPath(
  paths: string[],
  cwd: string,
): { path: string; reason: string } | undefined {
  for (const path of paths) {
    const matchedRule = findMatchingRule(path, cwd);
    if (matchedRule) {
      return { path, reason: matchedRule.reason };
    }
  }
  return undefined;
}

function findMentionedRule(command: string): { glob: string; reason: string } | undefined {
  return RULES.find((rule) => command.includes(rule.glob));
}

function patchActionLabel(operation: PatchOperation): "Creation" | "Deletion" | "Mutation" {
  if (operation === "delete") {
    return "Deletion";
  }
  if (operation === "add") {
    return "Creation";
  }
  return "Mutation";
}

function extractApplyPatchTargets(
  patchText: string,
): Array<{ path: string; operation: PatchOperation }> {
  const targets: Array<{ path: string; operation: PatchOperation }> = [];
  for (const line of patchText.split(/\r?\n/)) {
    const fileMatch = line.match(/^\*\*\* (Add|Delete|Update) File:\s+(.+)$/);
    if (fileMatch) {
      let operation: Exclude<PatchOperation, "move">;
      if (fileMatch[1] === "Add") {
        operation = "add";
      } else if (fileMatch[1] === "Delete") {
        operation = "delete";
      } else {
        operation = "update";
      }
      const path = stripWrappingQuotes(fileMatch[2].trim());
      targets.push({ path, operation });
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to:\s+(.+)$/);
    if (moveMatch) {
      const path = stripWrappingQuotes(moveMatch[1].trim());
      targets.push({ path, operation: "move" });
    }
  }
  return targets;
}

function findBlockedPatchTarget(
  targets: Array<{ path: string; operation: PatchOperation }>,
  cwd: string,
): { path: string; operation: PatchOperation; reason: string } | undefined {
  for (const target of targets) {
    const matchedRule = findMatchingRule(target.path, cwd);
    if (matchedRule) {
      return { path: target.path, operation: target.operation, reason: matchedRule.reason };
    }
  }
  return undefined;
}

function handleApplyPatch(patchText: string, cwd: string) {
  const patchTargets = extractApplyPatchTargets(patchText);
  const blockedPatchTarget = findBlockedPatchTarget(patchTargets, cwd);
  if (blockedPatchTarget) {
    const action = patchActionLabel(blockedPatchTarget.operation);
    return {
      block: true,
      reason: `${action} blocked for "${blockedPatchTarget.path}": ${blockedPatchTarget.reason}`,
    } as const;
  }

  if (PATCH_MUTATION_HEADER.test(patchText)) {
    const mentionedRule = findMentionedRule(patchText);
    if (mentionedRule) {
      return {
        block: true,
        reason: `Mutation blocked for protected glob "${mentionedRule.glob}": ${mentionedRule.reason}`,
      } as const;
    }
  }
}

function handleWriteOrEdit(path: string, cwd: string) {
  const matchedRule = findMatchingRule(path, cwd);
  if (!matchedRule) {
    return;
  }

  return {
    block: true,
    reason: `Path "${path}" is protected: ${matchedRule.reason}`,
  } as const;
}

function handleBash(command: string, cwd: string) {
  const blockedRedirection = findBlockedPath(extractRedirectionTargets(command), cwd);
  if (blockedRedirection) {
    return {
      block: true,
      reason: `Write redirect blocked for "${blockedRedirection.path}": ${blockedRedirection.reason}`,
    } as const;
  }

  if (!ARG_PATH_MUTATION_PATTERN.test(command)) {
    return;
  }

  const blockedMutationPath = findBlockedPath(extractPathTokens(command), cwd);
  if (blockedMutationPath) {
    const action = DELETE_PATTERN.test(command) ? "Deletion" : "Mutation";
    return {
      block: true,
      reason: `${action} blocked for "${blockedMutationPath.path}": ${blockedMutationPath.reason}`,
    } as const;
  }

  const mentionedRule = findMentionedRule(command);
  if (!mentionedRule) {
    return;
  }

  const action = DELETE_PATTERN.test(command) ? "Deletion" : "Mutation";
  return {
    block: true,
    reason: `${action} blocked for protected glob "${mentionedRule.glob}": ${mentionedRule.reason}`,
  } as const;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    let blocked:
      | {
          block: true;
          reason: string;
        }
      | undefined;

    if (isToolCallEventType<"apply_patch", { patchText: string }>("apply_patch", event)) {
      const patchText = typeof event.input.patchText === "string" ? event.input.patchText : "";
      blocked = handleApplyPatch(patchText, ctx.cwd);
      return blocked;
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      blocked = handleWriteOrEdit(event.input.path, ctx.cwd);
      return blocked;
    }

    if (isToolCallEventType("bash", event)) {
      blocked = handleBash(event.input.command, ctx.cwd);
      return blocked;
    }

    return blocked;
  });
}
