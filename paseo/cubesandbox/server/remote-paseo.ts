import {
  createPaseoClient,
  type PaseoAgentHandle,
  type PaseoAgentTimelineRefetchOptions,
  type PaseoApi,
  type PaseoClient,
} from "@getpaseo/client";
import {
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { z } from "zod";

const providerSnapshotSchema = z
  .object({
    entries: z.array(
      z
        .object({
          provider: z.string().min(1),
          status: z.string(),
          models: z
            .array(
              z
                .object({
                  id: z.string().min(1),
                  isDefault: z.boolean().optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const agentActivitySchema = z
  .object({
    status: z.enum(["initializing", "idle", "running", "error", "closed"]),
    activeTurn: z.unknown().nullable().optional(),
  })
  .passthrough();

export interface RemoteAgentInput {
  prompt: string;
  workspacePath: string;
  defaultRef: string;
  projectId: string;
  workId: string;
  ordinal: number;
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export interface RemoteAgentReference {
  agentId: string;
  workspaceId: string;
}

export type RemoteAgentTimeline = Awaited<
  ReturnType<PaseoAgentHandle["timeline"]["refetch"]>
>;
export type RemoteAgentTimelineOptions = PaseoAgentTimelineRefetchOptions;

export interface RemotePaseoConnection {
  readonly serverId: string;
  createAgent(input: RemoteAgentInput): Promise<RemoteAgentReference>;
  discardAgent(reference: RemoteAgentReference): Promise<void>;
  sendPrompt(agentId: string, prompt: string): Promise<void>;
  getAgentTimeline(
    agentId: string,
    options: RemoteAgentTimelineOptions,
  ): Promise<RemoteAgentTimeline>;
  hasBusyAgent(agentIds: string[]): Promise<boolean>;
  close(): Promise<void>;
}

export interface RemotePaseoConnector {
  connect(pairingUrl: string): Promise<RemotePaseoConnection>;
}

export function remoteBranchName(workId: string, ordinal: number): string {
  return `cube/${workId}/${ordinal}`;
}

async function selectProvider(
  paseo: PaseoApi,
  input: Pick<RemoteAgentInput, "provider" | "model" | "workspacePath">,
): Promise<{ configValue: string; provider: string }> {
  const snapshot = providerSnapshotSchema.parse(
    await paseo.providers.waitForReady({
      cwd: input.workspacePath,
      timeoutMs: 60_000,
    }),
  );
  const entries = snapshot.entries.filter(
    (entry) => entry.status === "ready" && entry.models?.length,
  );
  const selectedEntry = input.provider
    ? entries.find((entry) => entry.provider === input.provider)
    : input.model
      ? entries.find((entry) =>
          entry.models?.some((model) => model.id === input.model),
        )
      : entries[0];
  if (!selectedEntry)
    throw new Error(
      `Requested Paseo provider is unavailable: ${input.provider ?? "default"}`,
    );
  const selectedModel = input.model
    ? selectedEntry.models?.find((model) => model.id === input.model)
    : (selectedEntry.models?.find((model) => model.isDefault) ??
      selectedEntry.models?.[0]);
  if (!selectedModel)
    throw new Error(
      `Requested model is unavailable: ${input.model ?? "default"}`,
    );
  return {
    configValue: `${selectedEntry.provider}/${selectedModel.id}`,
    provider: selectedEntry.provider,
  };
}

class PaseoSdkConnection implements RemotePaseoConnection {
  constructor(
    readonly serverId: string,
    private readonly client: PaseoClient,
  ) {}

  async createAgent(input: RemoteAgentInput): Promise<RemoteAgentReference> {
    const selectedProvider = await selectProvider(this.client, input);
    if (input.modeId) {
      const modes = await this.client.providers.listModes(
        selectedProvider.provider,
        { cwd: input.workspacePath },
      );
      if (modes.error) {
        throw new Error(
          `Unable to discover modes for Paseo provider ${selectedProvider.provider}: ${modes.error}`,
        );
      }
      if (!modes.modes?.some((mode) => mode.id === input.modeId)) {
        throw new Error(
          `Requested mode is unavailable for Paseo provider ${selectedProvider.provider}: ${input.modeId}`,
        );
      }
    }
    const workspace = await this.client.workspaces.create({
      title: `${input.projectId} · ${input.workId.slice(0, 8)} · ${input.ordinal}`,
      source: {
        kind: "worktree",
        cwd: input.workspacePath,
        action: "branch-off",
        refName: input.defaultRef,
        branchName: remoteBranchName(input.workId, input.ordinal),
      },
    });
    let agent;
    try {
      agent = await workspace.agents.create({
        config: {
          provider: selectedProvider.configValue,
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.thinkingOptionId
            ? { thinkingOptionId: input.thinkingOptionId }
            : {}),
          ...(input.featureValues
            ? { featureValues: input.featureValues }
            : {}),
        },
        prompt: input.prompt,
      });
    } catch (creationError) {
      try {
        const result = await this.client.workspaces.archive(workspace.id);
        if (result.error) throw new Error(result.error);
      } catch (rollbackError) {
        throw new AggregateError(
          [creationError, rollbackError],
          "Remote agent creation and workspace rollback both failed",
        );
      }
      throw creationError;
    }
    return { agentId: agent.id, workspaceId: workspace.id };
  }

  async sendPrompt(agentId: string, prompt: string): Promise<void> {
    const agent = this.client.agents.ref(agentId);
    const current = await agent.refresh();
    if (!current) throw new Error(`Remote agent not found: ${agentId}`);
    await agent.send(prompt);
  }

  getAgentTimeline(
    agentId: string,
    options: RemoteAgentTimelineOptions,
  ): Promise<RemoteAgentTimeline> {
    return this.client.agents.ref(agentId).timeline.refetch(options);
  }

  async discardAgent(reference: RemoteAgentReference): Promise<void> {
    const result = await this.client.workspaces.archive(reference.workspaceId);
    if (result.error) {
      throw new Error(
        `Failed to archive remote workspace ${reference.workspaceId}: ${result.error}`,
      );
    }
  }

  async hasBusyAgent(agentIds: string[]): Promise<boolean> {
    const agents = await Promise.all(
      agentIds.map(async (agentId) => {
        const result = await this.client.agents.ref(agentId).refresh();
        return result ? agentActivitySchema.parse(result.agent) : null;
      }),
    );
    return agents.some(
      (agent) =>
        agent?.activeTurn != null ||
        agent?.status === "initializing" ||
        agent?.status === "running",
    );
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export function createRemotePaseoConnection(
  serverId: string,
  client: PaseoClient,
): RemotePaseoConnection {
  return new PaseoSdkConnection(serverId, client);
}

export class PaseoSdkConnector implements RemotePaseoConnector {
  async connect(pairingUrl: string): Promise<RemotePaseoConnection> {
    const offer = parseConnectionOfferFromUrl(pairingUrl);
    if (!offer) throw new Error("Pairing URL does not contain an offer");
    const relayUrl = buildRelayWebSocketUrl({
      endpoint: offer.relay.endpoint,
      serverId: offer.serverId,
      role: "client",
      useTls:
        offer.relay.useTls ??
        shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
    });
    const client = createPaseoClient({
      url: relayUrl,
      appVersion: "0.8.0",
      connectTimeoutMs: 15_000,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 5_000 },
      e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    });
    await client.connect();
    return createRemotePaseoConnection(offer.serverId, client);
  }
}
