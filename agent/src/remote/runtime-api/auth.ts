import { hc } from "hono/client";
import type { createV1Routes } from "../routes.js";
import { sign } from "node:crypto";
import { createChallengePayload } from "../auth.js";
import { toRemoteHttpError } from "./utils.js";
import { AuthChallengeResponseSchema, AuthVerifyResponseSchema } from "../schemas.js";
import { assertType } from "../typebox.js";

export interface RemoteApiClientAuthOptions {
  keyId: string;
  privateKey: string;
}

type RemoteV1Routes = ReturnType<typeof createV1Routes>;
export type RemoteAuthRpcClient = ReturnType<typeof hc<RemoteV1Routes>>["auth"];

export async function requestRemoteAuthToken(input: {
  rpcAuthClient: RemoteAuthRpcClient;
  auth: RemoteApiClientAuthOptions;
  captureConnectionId: (response: Response) => void;
}): Promise<string> {
  const challengeResponse = await input.rpcAuthClient.challenge.$post({
    json: { keyId: input.auth.keyId },
  });
  input.captureConnectionId(challengeResponse);
  if (challengeResponse.status !== 200) throw await toRemoteHttpError(challengeResponse);

  const challengePayload: unknown = await challengeResponse.json();
  assertType(AuthChallengeResponseSchema, challengePayload);
  const challenge = challengePayload;
  const signature = sign(
    null,
    Buffer.from(
      createChallengePayload({
        challengeId: challenge.challengeId,
        keyId: input.auth.keyId,
        nonce: challenge.nonce,
        origin: challenge.origin,
        expiresAt: challenge.expiresAt,
      }),
    ),
    input.auth.privateKey,
  ).toString("base64");

  const verifyResponse = await input.rpcAuthClient.verify.$post({
    json: { challengeId: challenge.challengeId, keyId: input.auth.keyId, signature },
  });
  input.captureConnectionId(verifyResponse);
  if (verifyResponse.status !== 200) throw await toRemoteHttpError(verifyResponse);

  const verifiedPayload: unknown = await verifyResponse.json();
  assertType(AuthVerifyResponseSchema, verifiedPayload);
  return verifiedPayload.token;
}
