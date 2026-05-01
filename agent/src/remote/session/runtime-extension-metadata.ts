import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { Value } from "typebox/value";
import type { RuntimeExtensionRuntime } from "../runtime-factory.js";
import { RemoteExtensionMetadataSchema } from "../schemas.js";
import { readHiddenProperty } from "../runtime-api/capabilities.js";

function readRemoteExtensionMetadataCandidate(runtime: AgentSessionRuntime): unknown {
  return readHiddenProperty(runtime, "remoteExtensionMetadata");
}

export function readRuntimeRemoteExtensionMetadata(
  runtime: AgentSessionRuntime,
): RuntimeExtensionRuntime["remoteExtensionMetadata"] {
  const metadataCandidate = readRemoteExtensionMetadataCandidate(runtime);
  if (!Array.isArray(metadataCandidate)) {
    return undefined;
  }

  if (!metadataCandidate.every((entry) => Value.Check(RemoteExtensionMetadataSchema, entry))) {
    return undefined;
  }

  return metadataCandidate.map((entry) => Value.Parse(RemoteExtensionMetadataSchema, entry));
}
