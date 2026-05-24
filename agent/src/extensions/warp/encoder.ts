import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { Value } from "typebox/value";
import {
  WarpCliAgentPayloadSchema,
  type WarpCliAgentEvent,
  type WarpCliAgentPayload,
  type WarpCliAgentPayloadOptions,
} from "./types.js";

const WARP_CLI_AGENT_OSC_TITLE = "warp://cli-agent";
const WARP_CLI_AGENT_PROTOCOL_VERSION = 1;

export const negotiateWarpCliAgentProtocolVersion = (
  rawVersion: string | undefined,
): number | null => {
  if (rawVersion === undefined) return null;
  const parsedVersion = Number.parseInt(rawVersion, 10);
  if (!Number.isFinite(parsedVersion) || parsedVersion < 1) return null;
  return Math.min(parsedVersion, WARP_CLI_AGENT_PROTOCOL_VERSION);
};

export const createWarpCliAgentPayload = (
  event: WarpCliAgentEvent,
  ctx: ExtensionContext,
  protocolVersion: number,
  options: WarpCliAgentPayloadOptions = {},
): WarpCliAgentPayload => {
  const payload = {
    v: protocolVersion,
    agent: "pi",
    event,
    session_id: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    project: basename(ctx.cwd),
    ...options,
  };
  return Value.Parse(WarpCliAgentPayloadSchema, payload);
};

export const createWarpCliAgentSequence = (payload: WarpCliAgentPayload): string =>
  `\u001B]777;notify;${WARP_CLI_AGENT_OSC_TITLE};${JSON.stringify(payload)}\u0007`;
