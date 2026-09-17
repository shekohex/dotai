import {
  createPaseoClient,
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
  mode?: string;
  thinking?: string;
}

export interface RemoteAgentReference {
  agentId: string;
  workspaceId: string;
}

export interface RemotePaseoConnection {
  readonly serverId: string;
  createAgent(input: RemoteAgentInput): Promise<RemoteAgentReference>;
  sendPrompt(agentId: string, prompt: string): Promise<void>;
  hasBusyAgent(agentIds: string[]): Promise<boolean>;
  close(): Promise<void>;
}

export interface RemotePaseoConnector {
  connect(pairingUrl: string): Promise<RemotePaseoConnection>;
}

async function selectProvider(
  paseo: PaseoApi,
  input: Pick<RemoteAgentInput, "provider" | "model" | "workspacePath">,
): Promise<string> {
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
  return `${selectedEntry.provider}/${selectedModel.id}`;
}

class PaseoSdkConnection implements RemotePaseoConnection {
  constructor(
    readonly serverId: string,
    private readonly client: PaseoClient,
  ) {}

  async createAgent(input: RemoteAgentInput): Promise<RemoteAgentReference> {
    const provider = await selectProvider(this.client, input);
    const workspace = await this.client.workspaces.create({
      title: `${input.projectId} · ${input.workId.slice(0, 8)} · ${input.ordinal}`,
      source: {
        kind: "worktree",
        cwd: input.workspacePath,
        action: "branch-off",
        refName: input.defaultRef,
        branchName: `cube/${input.workId}/${input.ordinal}`,
      },
    });
    const agent = await workspace.agents.create({
      config: {
        provider,
        ...(input.mode ? { modeId: input.mode } : {}),
        ...(input.thinking ? { thinkingOptionId: input.thinking } : {}),
      },
      prompt: input.prompt,
    });
    return { agentId: agent.id, workspaceId: workspace.id };
  }

  async sendPrompt(agentId: string, prompt: string): Promise<void> {
    const agent = this.client.agents.ref(agentId);
    const current = await agent.refresh();
    if (!current) throw new Error(`Remote agent not found: ${agentId}`);
    await agent.send(prompt);
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
    return new PaseoSdkConnection(offer.serverId, client);
  }
}
