import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  estimateTokens,
  formatUsd,
  getLoadedSkillsFromSession,
  loadProjectContextFiles,
  normalizeSkillName,
  shortenPath,
  sumSessionUsage,
} from "./shared.js";
import { ContextView, joinComma, type ContextViewData } from "./view.js";

type ContextCommandData = {
  plainText: string;
  viewData: ContextViewData;
};

type ContextUsageMetrics = {
  viewUsage: ContextViewData["usage"];
  agentFilePaths: string[];
  ctxWindow: number;
  effectiveTokens: number;
  percent: number;
  remainingTokens: number;
  systemPromptTokens: number;
  agentTokens: number;
  toolsTokens: number;
  activeToolCount: number;
};

async function handleContextCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const data = await buildContextCommandData(pi, ctx);
  if (!ctx.hasUI) {
    pi.sendMessage(
      { customType: "context", content: data.plainText, display: true },
      { triggerTurn: false },
    );
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    return new ContextView(tui, theme, data.viewData, done);
  });
}

async function buildContextCommandData(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<ContextCommandData> {
  const extensionFiles = listExtensionFiles(pi);
  const skills = listSkillNames(pi);
  const agentFiles = await loadProjectContextFiles(ctx.cwd);
  const usage = buildContextUsageMetrics(pi, ctx, agentFiles);
  const sessionUsage = sumSessionUsage(ctx);
  const loadedSkills = Array.from(getLoadedSkillsFromSession(ctx)).toSorted((a, b) =>
    a.localeCompare(b),
  );
  return {
    plainText: buildContextPlainText(usage, extensionFiles, skills, sessionUsage),
    viewData: {
      usage: usage.viewUsage,
      agentFiles: usage.agentFilePaths,
      extensions: extensionFiles,
      skills,
      loadedSkills,
      session: { totalTokens: sessionUsage.totalTokens, totalCost: sessionUsage.totalCost },
    },
  };
}

function listExtensionFiles(pi: ExtensionAPI): string[] {
  const extensionsByPath = new Map<string, string[]>();
  for (const command of pi.getCommands().filter((item) => item.source === "extension")) {
    const sourcePath = command.sourceInfo?.path ?? "<unknown>";
    const commands = extensionsByPath.get(sourcePath) ?? [];
    commands.push(command.name);
    extensionsByPath.set(sourcePath, commands);
  }
  return [...extensionsByPath.keys()]
    .map((sourcePath) =>
      sourcePath === "<unknown>" ? sourcePath : (sourcePath.split(/[\\/]/).at(-1) ?? sourcePath),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

function listSkillNames(pi: ExtensionAPI): string[] {
  return pi
    .getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => normalizeSkillName(command.name))
    .toSorted((left, right) => left.localeCompare(right));
}

function buildContextUsageMetrics(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  agentFiles: Awaited<ReturnType<typeof loadProjectContextFiles>>,
): ContextUsageMetrics {
  const agentFilePaths = agentFiles.map((file) => shortenPath(file.path, ctx.cwd));
  const agentTokens = agentFiles.reduce((sum, file) => sum + file.tokens, 0);
  const systemPrompt = ctx.getSystemPrompt();
  const systemPromptTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
  const usage = ctx.getContextUsage();
  const messageTokens = usage?.tokens ?? 0;
  const ctxWindow = usage?.contextWindow ?? 0;
  const activeToolNames = pi.getActiveTools();
  const toolsTokens = estimateActiveToolTokens(pi, activeToolNames);
  const effectiveTokens = messageTokens + toolsTokens;
  const percent = ctxWindow > 0 ? (effectiveTokens / ctxWindow) * 100 : 0;
  const remainingTokens = ctxWindow > 0 ? Math.max(0, ctxWindow - effectiveTokens) : 0;

  return {
    viewUsage:
      usage === undefined
        ? null
        : {
            messageTokens,
            contextWindow: ctxWindow,
            effectiveTokens,
            percent,
            remainingTokens,
            systemPromptTokens,
            agentTokens,
            toolsTokens,
            activeTools: activeToolNames.length,
          },
    agentFilePaths,
    ctxWindow,
    effectiveTokens,
    percent,
    remainingTokens,
    systemPromptTokens,
    agentTokens,
    toolsTokens,
    activeToolCount: activeToolNames.length,
  };
}

function estimateActiveToolTokens(pi: ExtensionAPI, activeToolNames: string[]): number {
  const TOOL_FUDGE = 1.5;
  const toolInfoByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool] as const));
  let toolsTokens = 0;
  for (const toolName of activeToolNames) {
    const info = toolInfoByName.get(toolName);
    const blob = `${toolName}\n${info?.description ?? ""}`;
    toolsTokens += estimateTokens(blob);
  }
  return Math.round(toolsTokens * TOOL_FUDGE);
}

function buildContextPlainText(
  usage: ReturnType<typeof buildContextUsageMetrics>,
  extensionFiles: string[],
  skills: string[],
  sessionUsage: ReturnType<typeof sumSessionUsage>,
): string {
  const lines: string[] = ["Context"];
  if (usage.viewUsage) {
    lines.push(
      `Window: ~${usage.effectiveTokens.toLocaleString()} / ${usage.ctxWindow.toLocaleString()} (${usage.percent.toFixed(1)}% used, ~${usage.remainingTokens.toLocaleString()} left)`,
    );
  } else {
    lines.push("Window: (unknown)");
  }
  lines.push(
    `System: ~${usage.systemPromptTokens.toLocaleString()} tok (AGENTS ~${usage.agentTokens.toLocaleString()})`,
  );
  lines.push(`Tools: ~${usage.toolsTokens.toLocaleString()} tok (${usage.activeToolCount} active)`);
  lines.push(
    `AGENTS: ${usage.agentFilePaths.length > 0 ? joinComma(usage.agentFilePaths) : "(none)"}`,
  );
  lines.push(
    `Extensions (${extensionFiles.length}): ${extensionFiles.length > 0 ? joinComma(extensionFiles) : "(none)"}`,
  );
  lines.push(`Skills (${skills.length}): ${skills.length > 0 ? joinComma(skills) : "(none)"}`);
  lines.push(
    `Session: ${sessionUsage.totalTokens.toLocaleString()} tokens · ${formatUsd(sessionUsage.totalCost)}`,
  );
  return lines.join("\n");
}

export { handleContextCommand };
