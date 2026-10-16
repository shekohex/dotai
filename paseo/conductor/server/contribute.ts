import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";

import {
  answerQuestionRpc,
  getProgressRpc,
  saveViewRpc,
  setTicketPrefixRpc,
  ticketPrefixNote,
  PROGRESS_MCP_SERVER,
  previewTargetRpc,
  type ProgressEvent,
  type ProgressState,
  questionNotes,
  runHistoryRpc,
  shareTargetRpc,
} from "../shared/progress.js";
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
import { MediaServer, tailscaleCli } from "./media-server.js";
import { DEFAULT_ESCALATION } from "./escalations.js";
import { DEFAULT_REMINDERS, ProgressReminders } from "./reminders.js";
import { installTemplates } from "./templates.js";
import { ensureConductorMemory } from "./memory.js";
import { ConductorMonitor } from "./monitor.js";
import { resolveConductorPaths } from "./paths.js";
import { readProjectInstructions } from "./project-instructions.js";
import {
  conductorWorkspaceDirectory,
  openOnHost,
  previewFile,
  resolveTarget,
  RunHistory,
} from "./progress-files.js";
import { ProgressStore } from "./progress-store.js";
import { CAPABILITY_URL_ENV, ProgressToolServer } from "./progress-tools.js";
import { pluginBuild } from "./version.js";

const TICK_MS = 60_000;
const KICKOFF_PROMPT =
  "Conductor started. Read your instructions, notes, and global memory, then reply in one line that you are ready.";

export function contributeServer(server: PluginServerContext) {
  const paths = resolveConductorPaths();
  const monitor = new ConductorMonitor(new LedgerStore(paths.ledgerFile));
  const settings = server.registerSettings(conductorSettings);
  const history = new RunHistory(paths);
  let api: PaseoApi | undefined;
  const mirror = async (conductorId: string): Promise<void> => {
    if (!api) return;
    const directory = await conductorWorkspaceDirectory(api, conductorId);
    if (directory) {
      await history.mirror(
        conductorId,
        directory,
        await progress.currentRun(conductorId),
      );
    }
  };
  // Questions reach agents as steer notes: a worker's question goes to its conductor, which may
  // answer it; an answer goes to whoever asked, and the user's answers to the conductor too.
  const relayQuestion = async (
    conductorId: string,
    event: ProgressEvent,
  ): Promise<void> => {
    if (!api || (event.op !== "ask" && event.op !== "answer")) return;
    const question = (await progress.state(conductorId))?.questions.find(
      (candidate) => candidate.id === event.id,
    );
    if (!question) return;
    const notes = questionNotes(conductorId, event, question);
    const paseo = api;
    await Promise.all(
      [...notes].map(([agentId, note]) =>
        paseo.agents
          .ref(agentId)
          .send(formatSystemNote(note), { activeTurnBehavior: "steer" })
          .catch((error: unknown) =>
            console.warn(`Could not pass ${question.id} to ${agentId}`, error),
          ),
      ),
    );
  };
  const progress = new ProgressStore(
    paths,
    () => new Date(),
    async (conductorId, event) => {
      await Promise.all([
        mirror(conductorId),
        relayQuestion(conductorId, event),
      ]);
    },
  );
  const recordedTargets = (state: ProgressState | null): Set<string> =>
    new Set([
      ...(state?.deliverables.map((item) => item.target) ?? []),
      ...(state?.tickets.flatMap((ticket) =>
        ticket.source ? [ticket.source] : [],
      ) ?? []),
      ...(state?.questions.flatMap((question) => question.files ?? []) ?? []),
    ]);
  const tools = new ProgressToolServer(paths, progress);
  const reminders = new ProgressReminders(paths, progress, async () => {
    const state = await settings.read();
    if (state.status !== "ready")
      return { reminders: DEFAULT_REMINDERS, escalation: DEFAULT_ESCALATION };
    return {
      reminders: {
        ...DEFAULT_REMINDERS,
        enabled: state.values.checkIns,
        minutes: state.values.checkInMinutes,
      },
      escalation: {
        ...DEFAULT_ESCALATION,
        enabled: state.values.escalate,
        minutes: state.values.escalateMinutes,
      },
    };
  });
  const media = new MediaServer({ tailscale: tailscaleCli() });
  // Plugins only see Paseo inside hooks and handlers, so grab it at every chance:
  // the progress tool needs it to find an agent's conductor after a plugin reload.
  const attach = (paseo: PaseoApi): void => {
    monitor.attach(paseo);
    tools.attach(paseo);
    api ??= paseo;
  };
  void installTemplates(paths.templatesDir).catch((error: unknown) =>
    console.warn("Conductor could not install page templates", error),
  );
  console.log(
    `Conductor plugin ${pluginBuild([contributeServer, ProgressToolServer, ProgressStore])} starting`,
  );
  const toolsReady = tools.start().catch((error: unknown) => {
    console.warn("Conductor progress tool server failed to start", error);
  });

  // Every agent gets the `progress` tool; it resolves its conductor from the parent chain when called.
  server.before("agent.create", async ({ request }, { paseo }) => {
    await toolsReady;
    attach(paseo);
    if (request.config.internal) return request;
    let url: string;
    try {
      url = tools.reserve();
    } catch {
      return request;
    }
    return {
      ...request,
      env: { ...request.env, [CAPABILITY_URL_ENV]: url },
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          [PROGRESS_MCP_SERVER]: { type: "http", url },
        },
      },
    };
  });
  server.before("agent.session_open", async ({ request }, { paseo }) => {
    await toolsReady;
    attach(paseo);
    const url = request.env[CAPABILITY_URL_ENV];
    if (!url) return request;
    await tools.bind(url, request.agentId);
    void tools.warm(request.agentId);
    const { [CAPABILITY_URL_ENV]: _url, ...env } = request.env;
    return { ...request, env };
  });

  const observe = (
    event: { agent: PluginHookAgent },
    context: PluginHookContext,
  ): void => {
    attach(context.paseo);
    if (event.agent.parentAgentId) void monitor.refresh();
  };
  server.on("agent.created", (event, context) => {
    observe(event, context);
    // Now Paseo knows the agent and its parent, so its conductor can be found and cached.
    void tools.warm(event.agent.id);
  });
  server.on("agent.turn_started", observe);
  server.on("agent.turn_ended", observe);
  server.on("agent.permission_requested", observe);
  server.on("agent.permission_resolved", observe);
  server.on("agent.closed", observe);
  server.on("agent.archived", (event, context) => {
    observe(event, context);
    void tools.forget(event.agent.id);
  });

  // Covers app/SDK creations. MCP create_workspace bypasses plugin hooks, so the playbook
  // tells conductors to do the same refresh themselves.
  server.before("workspace.create", async ({ request }, { paseo }) => {
    attach(paseo);
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
    attach(paseo);
    const agentId = randomUUID();
    await ensureConductorMemory(paths, agentId);
    if (input.ticketPrefix)
      await progress.setTicketPrefix(agentId, input.ticketPrefix);
    const project = (await paseo.projects.list()).projects.find(
      (candidate) => candidate.projectId === input.projectId,
    );
    if (!project) throw new Error("Project not found. Pick another project");
    const branch = input.branch?.trim();
    const workspace = await paseo.workspaces.create(
      input.newWorktree
        ? {
            title: input.title,
            source: {
              kind: "worktree",
              projectId: project.projectId,
              cwd: project.projectRootPath,
              action: "branch-off",
              ...(branch ? { refName: branch } : {}),
            },
          }
        : {
            title: input.title,
            source: {
              kind: "directory",
              path: project.projectRootPath,
              projectId: project.projectId,
            },
          },
    );
    const projectInstructions = await readProjectInstructions(
      await workspaceDirectories(paseo, workspace.id),
    );
    const systemPrompt = buildConductorSystemPrompt({
      conductorDir: paths.conductorDir(agentId),
      sharedMemoryDir: paths.sharedMemoryDir,
      projectInstructions,
    });
    const agent = await workspace.agents.create({
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
    attach(paseo);
    return listDocuments(paths, paseo, input);
  });

  server.handle(writeDocumentRpc, async (input, { paseo }) => {
    attach(paseo);
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

  server.handle(getProgressRpc, async ({ conductorId }, { paseo }) => {
    attach(paseo);
    return {
      state: await progress.state(conductorId),
      ticketPrefix: await progress.ticketPrefix(conductorId),
      view: await progress.view(conductorId),
      escalated: await reminders.escalations(conductorId),
    };
  });

  server.handle(saveViewRpc, async ({ conductorId, view }, { paseo }) => {
    attach(paseo);
    await progress.setView(conductorId, view);
    return {};
  });

  server.handle(
    setTicketPrefixRpc,
    async ({ conductorId, ticketPrefix }, { paseo }) => {
      attach(paseo);
      if (ticketPrefix === (await progress.ticketPrefix(conductorId)))
        return { ticketPrefix };
      await progress.setTicketPrefix(conductorId, ticketPrefix);
      await paseo.agents
        .ref(conductorId)
        .send(formatSystemNote(ticketPrefixNote(ticketPrefix)), {
          activeTurnBehavior: "steer",
        })
        .catch((error: unknown) =>
          console.warn("Ticket prefix note failed", error),
        );
      return { ticketPrefix };
    },
  );

  const resolveRecorded = async (
    conductorId: string,
    target: string,
    paseo: PaseoApi,
  ) => {
    attach(paseo);
    return resolveTarget(
      target,
      recordedTargets(await progress.state(conductorId)),
      await conductorWorkspaceDirectory(paseo, conductorId),
    );
  };

  server.handle(
    previewTargetRpc,
    async ({ conductorId, target }, { paseo }) => {
      const resolved = await resolveRecorded(conductorId, target, paseo);
      return resolved.kind === "link"
        ? resolved
        : previewFile(resolved.filePath);
    },
  );

  server.handle(shareTargetRpc, async ({ conductorId, target }, { paseo }) => {
    const resolved = await resolveRecorded(conductorId, target, paseo);
    if (resolved.kind === "link")
      return { kind: "url" as const, url: resolved.url };
    const info = await stat(resolved.filePath).catch(() => null);
    if (!info?.isFile()) {
      await openOnHost(resolved.filePath);
      return { kind: "host" as const };
    }
    const url = await media.share(
      resolved.filePath,
      path.basename(resolved.filePath),
    );
    return { kind: "url" as const, url };
  });

  server.handle(runHistoryRpc, async ({ conductorId, folder }, { paseo }) => {
    attach(paseo);
    if (folder !== undefined) {
      await history.setFolder(conductorId, folder);
      await mirror(conductorId);
    }
    return { folder: await history.folder(conductorId) };
  });

  server.handle(answerQuestionRpc, async (input, { paseo }) => {
    attach(paseo);
    // Recording it relays the answer to the conductor and the agent that asked.
    await progress.record(
      input.conductorId,
      {
        op: "answer",
        id: input.id,
        ...(input.choice ? { choice: input.choice } : {}),
        ...(input.words ? { words: input.words } : {}),
      },
      "user",
    );
    return { ok: true as const };
  });

  const timer = setInterval(() => {
    void monitor.refresh();
    if (api)
      void reminders
        .tick(api)
        .catch((error: unknown) =>
          console.warn("Progress check-ins failed", error),
        );
  }, TICK_MS);
  return async () => {
    clearInterval(timer);
    await Promise.all([tools.close(), media.close()]);
  };
}
