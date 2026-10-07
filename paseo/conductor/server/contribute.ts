import { randomUUID } from "node:crypto";

import type {
  PluginHookAgent,
  PluginHookContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";

import {
  createConductorRpc,
  listDocumentsRpc,
  writeDocumentRpc,
} from "../shared/contracts.js";
import { conductorLabels } from "../shared/labels.js";
import { formatSystemNote } from "../shared/notice.js";
import { buildConductorSystemPrompt } from "../shared/playbook.js";
import { conductorSettings } from "../shared/settings.js";
import { fastForwardBaseBranch, requestedBranchOffBase } from "./fresh-base.js";
import { LedgerStore } from "./ledger.js";
import {
  documentPath,
  isCoreDocument,
  listDocuments,
  workspaceDirectories,
  writeDocumentFile,
} from "./documents.js";
import { ensureConductorMemory } from "./memory.js";
import { ConductorMonitor } from "./monitor.js";
import { resolveConductorPaths } from "./paths.js";
import { readProjectInstructions } from "./project-instructions.js";

const TICK_MS = 60_000;
const KICKOFF_PROMPT =
  "Conductor started. Read your instructions, notes, and global memory, then reply in one line that you are ready.";

export function contributeServer(server: PluginServerContext) {
  const paths = resolveConductorPaths();
  const monitor = new ConductorMonitor(new LedgerStore(paths.ledgerFile));
  server.registerSettings(conductorSettings);

  const observe = (
    event: { agent: PluginHookAgent },
    context: PluginHookContext,
  ): void => {
    monitor.attach(context.paseo);
    if (event.agent.parentAgentId) void monitor.refresh();
  };
  server.on("agent.created", observe);
  server.on("agent.turn_started", observe);
  server.on("agent.turn_ended", observe);
  server.on("agent.permission_requested", observe);
  server.on("agent.permission_resolved", observe);
  server.on("agent.closed", observe);
  server.on("agent.archived", observe);

  // Covers app/SDK creations. MCP create_workspace bypasses plugin hooks, so the playbook
  // tells conductors to do the same refresh themselves.
  server.before("workspace.create", async ({ request }, { paseo }) => {
    monitor.attach(paseo);
    const { source } = request;
    if (source.kind !== "worktree") return request;
    const base = requestedBranchOffBase(source);
    if (base === undefined) return request;
    const cwd =
      source.cwd ??
      (await paseo.projects.list()).projects.find(
        (project) => project.projectId === source.projectId,
      )?.projectRootPath;
    if (!cwd) return request;
    try {
      const result = await fastForwardBaseBranch(cwd, base);
      console.log("Conductor base refresh", cwd, JSON.stringify(result));
    } catch (error) {
      // Fail open: a stale base is better than blocking workspace creation offline.
      console.warn("Conductor base refresh failed", cwd, error);
    }
    return request;
  });

  server.handle(createConductorRpc, async (input, { paseo }) => {
    monitor.attach(paseo);
    const agentId = randomUUID();
    await ensureConductorMemory(paths, agentId);
    const projectInstructions = await readProjectInstructions(
      await workspaceDirectories(paseo, input.workspaceId),
    );
    const systemPrompt = buildConductorSystemPrompt({
      conductorDir: paths.conductorDir(agentId),
      sharedMemoryDir: paths.sharedMemoryDir,
      projectInstructions,
    });
    const agent = await paseo.workspaces.ref(input.workspaceId).agents.create({
      agentId,
      config: {
        provider: input.model
          ? `${input.provider}/${input.model}`
          : input.provider,
        ...(input.thinkingOptionId
          ? { thinkingOptionId: input.thinkingOptionId }
          : {}),
        systemPrompt,
      },
      title: input.title,
      labels: conductorLabels,
      prompt: input.prompt?.trim() || KICKOFF_PROMPT,
    });
    return { agentId: agent.id };
  });

  server.handle(listDocumentsRpc, async (input, { paseo }) => {
    monitor.attach(paseo);
    return listDocuments(paths, paseo, input);
  });

  server.handle(writeDocumentRpc, async (input, { paseo }) => {
    monitor.attach(paseo);
    const filePath = await documentPath(paths, input.ref, paseo);
    await writeDocumentFile({
      filePath,
      content: input.content,
      previousContent: input.previousContent,
      core: isCoreDocument(input.ref),
    });
    if (input.notifyConductorId) {
      const action = input.content === null ? "deleted" : "updated";
      await paseo.agents
        .ref(input.notifyConductorId)
        .send(
          formatSystemNote(
            `The user ${action} ${filePath}. Re-read it now and follow it from here on. Reply with one short line.`,
          ),
          { activeTurnBehavior: "steer" },
        );
    }
    return { path: filePath };
  });

  const timer = setInterval(() => void monitor.refresh(), TICK_MS);
  return () => clearInterval(timer);
}
