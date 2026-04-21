import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import path from "node:path";
import { handleContextCommand } from "./command.js";
import {
  SKILL_LOADED_ENTRY,
  getLoadedSkillsFromSession,
  normalizeReadPath,
  normalizeSkillName,
} from "./shared.js";

type SkillIndexEntry = {
  name: string;
  skillFilePath: string;
  skillDir: string;
};

type SkillLoadedEntryData = {
  name: string;
  path: string;
};

const ReadToolResultEventSchema = Type.Object(
  {
    toolName: Type.Literal("read"),
    isError: Type.Optional(Type.Boolean()),
    input: Type.Optional(
      Type.Object(
        {
          path: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

type ContextSkillCacheState = {
  lastSessionId: string | null;
  loadedSkills: Set<string>;
  skillIndex: SkillIndexEntry[];
};

function buildSkillIndex(pi: ExtensionAPI, cwd: string): SkillIndexEntry[] {
  return pi
    .getCommands()
    .filter((c) => c.source === "skill")
    .map((c) => {
      const p = c.sourceInfo?.path ? normalizeReadPath(c.sourceInfo.path, cwd) : "";
      return {
        name: normalizeSkillName(c.name),
        skillFilePath: p,
        skillDir: p ? path.dirname(p) : "",
      };
    })
    .filter((x) => x.name && x.skillDir);
}

function createContextSkillCacheState(): ContextSkillCacheState {
  return {
    lastSessionId: null,
    loadedSkills: new Set<string>(),
    skillIndex: [],
  };
}

function ensureContextSkillCaches(
  pi: ExtensionAPI,
  cache: ContextSkillCacheState,
  ctx: ExtensionContext,
): void {
  const sessionId = ctx.sessionManager.getSessionId();
  if (sessionId !== cache.lastSessionId) {
    cache.lastSessionId = sessionId;
    cache.loadedSkills = getLoadedSkillsFromSession(ctx);
    cache.skillIndex = buildSkillIndex(pi, ctx.cwd);
  }
  if (cache.skillIndex.length === 0) {
    cache.skillIndex = buildSkillIndex(pi, ctx.cwd);
  }
}

function matchSkillForReadPath(cache: ContextSkillCacheState, absPath: string): string | null {
  let best: SkillIndexEntry | null = null;
  for (const skill of cache.skillIndex) {
    if (!skill.skillDir) {
      continue;
    }
    if (
      (absPath === skill.skillFilePath || absPath.startsWith(skill.skillDir + path.sep)) &&
      (best === null || skill.skillDir.length > best.skillDir.length)
    ) {
      best = skill;
    }
  }
  return best?.name ?? null;
}

function handleContextToolResult(
  pi: ExtensionAPI,
  cache: ContextSkillCacheState,
  event: ToolResultEvent,
  ctx: ExtensionContext,
): void {
  if (!Value.Check(ReadToolResultEventSchema, event)) {
    return;
  }

  const parsed = Value.Parse(ReadToolResultEventSchema, event);
  if (parsed.isError === true) {
    return;
  }
  const readPath = parsed.input?.path ?? "";
  if (readPath.length === 0) {
    return;
  }

  ensureContextSkillCaches(pi, cache, ctx);
  const absPath = normalizeReadPath(readPath, ctx.cwd);
  const skillName = matchSkillForReadPath(cache, absPath);
  if (skillName === null || skillName.length === 0 || cache.loadedSkills.has(skillName)) {
    return;
  }

  cache.loadedSkills.add(skillName);
  pi.appendEntry<SkillLoadedEntryData>(SKILL_LOADED_ENTRY, { name: skillName, path: absPath });
}

export default function contextExtension(pi: ExtensionAPI) {
  const skillCache = createContextSkillCacheState();
  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    handleContextToolResult(pi, skillCache, event, ctx);
  });

  pi.registerCommand("context", {
    description: "Show loaded context overview",
    handler: (_args, ctx) => handleContextCommand(pi, ctx),
  });
}
