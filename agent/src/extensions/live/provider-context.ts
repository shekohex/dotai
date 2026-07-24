import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isUnknownRecord } from "../../utils/unknown-value.js";
import { appendLiveDiagnostic } from "./diagnostics.js";

const LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation";

export interface LiveProviderPayloadRewrite {
  payload: unknown;
  promoted: number;
}

interface ProviderModelIdentity {
  provider?: string;
  id?: string;
  api?: string;
}

function payloadMessageText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return undefined;
  const text: string[] = [];
  for (const part of content) {
    if (!isUnknownRecord(part)) continue;
    if ((part.type === "input_text" || part.type === "text") && typeof part.text === "string") {
      text.push(part.text);
    }
  }
  return text.join("\n").trim();
}

/**
 * OMP serializes agent-attributed custom messages as developer messages. Pi 0.82 serializes every
 * custom message as a user message, so promote only known Pi Live delegations in the already-built
 * OpenAI Responses payload. This keeps the custom TUI renderer without misattributing the turn.
 *
 * @param {unknown} payload Provider-specific request payload.
 * @param {ReadonlySet<string>} delegationRequests Exact Pi Live requests eligible for promotion.
 * @returns {LiveProviderPayloadRewrite} Rewritten payload and promoted-message count.
 */
export function promoteLiveDelegationsInOpenAIResponsesPayload(
  payload: unknown,
  delegationRequests: ReadonlySet<string>,
): LiveProviderPayloadRewrite {
  if (!isUnknownRecord(payload) || !Array.isArray(payload.input) || delegationRequests.size === 0) {
    return { payload, promoted: 0 };
  }
  let promoted = 0;
  const originalInput = payload.input as unknown[];
  const input = originalInput.map((item): unknown => {
    if (!isUnknownRecord(item) || item.role !== "user") return item;
    const text = payloadMessageText(item);
    if (text === undefined || !delegationRequests.has(text)) return item;
    promoted += 1;
    return { ...item, role: "developer" };
  });
  return promoted === 0 ? { payload, promoted } : { payload: { ...payload, input }, promoted };
}

function assistantHasSubstantiveOutput(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.content.some((content) => {
    if (content.type === "text") return content.text.trim().length > 0;
    return content.type === "toolCall";
  });
}

/**
 * Removes provider-successful but content-empty assistant turns from live-delegation context.
 * Session history remains untouched; only the next provider request is repaired for bounded retry.
 *
 * @param {readonly AgentMessage[]} messages Agent context before provider conversion.
 * @returns {AgentMessage[] | undefined} Filtered context, or undefined when unchanged.
 */
export function omitEmptyLiveDelegationAssistantTurns(
  messages: readonly AgentMessage[],
): AgentMessage[] | undefined {
  let inLiveDelegation = false;
  let changed = false;
  const next: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "custom" && message.customType === LIVE_DELEGATION_MESSAGE_TYPE) {
      inLiveDelegation = true;
      next.push(message);
      continue;
    }
    if (message.role === "user") inLiveDelegation = false;
    if (message.role === "assistant" && inLiveDelegation) {
      const substantive = assistantHasSubstantiveOutput(message);
      const terminal = message.stopReason !== "toolUse";
      if (!substantive && terminal) {
        changed = true;
        inLiveDelegation = false;
        continue;
      }
      if (terminal) inLiveDelegation = false;
    }
    next.push(message);
  }
  return changed ? next : undefined;
}

export class LiveProviderContext {
  readonly #sessionId: string;
  readonly #delegationRequests = new Set<string>();

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  rememberDelegation(request: string): void {
    this.#delegationRequests.add(request);
  }

  prepareProviderPayload(payload: unknown, model: ProviderModelIdentity | undefined): unknown {
    if (model?.api !== "openai-responses" && model?.api !== "openai-codex-responses") {
      return undefined;
    }
    const rewritten = promoteLiveDelegationsInOpenAIResponsesPayload(
      payload,
      this.#delegationRequests,
    );
    if (rewritten.promoted === 0) return undefined;
    appendLiveDiagnostic(this.#sessionId, "delegation.provider-role-promoted", {
      provider: model.provider,
      model: model.id,
      api: model.api,
      promoted: rewritten.promoted,
    });
    return rewritten.payload;
  }

  prepareAgentContext(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
    return omitEmptyLiveDelegationAssistantTurns(messages);
  }
}
