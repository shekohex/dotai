import { hc } from "hono/client";
import type { createV1Routes } from "../routes.js";
import type { ClientCapabilities, ConnectionCapabilitiesResponse } from "../schemas.js";
import { ClientCapabilitiesSchema, ConnectionCapabilitiesResponseSchema } from "../schemas.js";
import { assertType } from "../typebox.js";
import { toRemoteHttpError } from "./utils.js";

type RemoteV1Routes = ReturnType<typeof createV1Routes>;

export async function registerRemoteConnectionCapabilities(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  connectionId: string;
  headers: Record<string, string>;
  capabilities: ClientCapabilities;
  captureConnectionId: (response: Response) => void;
}): Promise<ConnectionCapabilitiesResponse> {
  assertType(ClientCapabilitiesSchema, input.capabilities);
  const post = resolveCapabilitiesPostMethod(input.rpcClient);
  const response = await post(
    {
      param: { connectionId: input.connectionId },
      json: input.capabilities,
    },
    {
      headers: input.headers,
    },
  );
  input.captureConnectionId(response);
  if (response.status !== 200) {
    throw await toRemoteHttpError(response);
  }
  const payload: unknown = await response.json();
  assertType(ConnectionCapabilitiesResponseSchema, payload);
  return payload;
}

function resolveCapabilitiesPostMethod(
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>,
): (
  input: { param: { connectionId: string }; json: ClientCapabilities },
  options: { headers: Record<string, string> },
) => Promise<Response> {
  const connections = readObject(readProperty(rpcClient, "connections"));
  const connectionRoute = readObject(readProperty(connections, ":connectionId"));
  const capabilitiesRoute = readObject(readProperty(connectionRoute, "capabilities"));
  const postCandidate = readProperty(capabilitiesRoute, "$post");
  if (!isCapabilitiesPostMethod(postCandidate)) {
    throw new TypeError("Capabilities RPC route is not available");
  }

  return async (input, options) => {
    const candidate = postCandidate(input, options);
    if (!isPromise(candidate)) {
      throw new TypeError("Capabilities RPC route returned an invalid response");
    }
    const responseCandidate: unknown = await candidate;
    if (!(responseCandidate instanceof Response)) {
      throw new TypeError("Capabilities RPC route returned an invalid response");
    }
    return responseCandidate;
  };
}

function isPromise(value: unknown): value is Promise<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return typeof Reflect.get(value, "then") === "function";
}

function isCapabilitiesPostMethod(
  value: unknown,
): value is (
  input: { param: { connectionId: string }; json: ClientCapabilities },
  options: { headers: Record<string, string> },
) => unknown {
  return typeof value === "function";
}

function readProperty(target: object, key: string): unknown {
  return Reflect.get(target, key);
}

function readObject(value: unknown): object {
  if (!isReflectTarget(value)) {
    throw new TypeError("Capabilities RPC route is not available");
  }
  return value;
}

function isReflectTarget(value: unknown): value is object {
  if (value === null || Array.isArray(value)) {
    return false;
  }

  return typeof value === "object" || typeof value === "function";
}
