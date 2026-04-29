import { SessionSyncEventSchema, type SessionSyncEvent } from "../schemas.js";
import { parseSseStream } from "../sse.js";
import { assertType } from "../typebox.js";
import { toRemoteHttpError } from "./utils.js";

export async function readRemoteSessionSync(input: {
  fetchImpl: typeof fetch;
  origin: string;
  sessionId: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  captureConnectionId: (response: Response) => void;
  onSyncEvent: (event: SessionSyncEvent) => Promise<void> | void;
}): Promise<void> {
  const response = await input.fetchImpl(
    `${input.origin}/v1/sessions/${encodeURIComponent(input.sessionId)}/sync`,
    {
      method: "GET",
      headers: input.headers,
      signal: input.signal,
    },
  );
  input.captureConnectionId(response);
  if (!response.ok) {
    throw await toRemoteHttpError(response);
  }

  const stream = response.body;
  if (!stream) {
    return;
  }

  for await (const event of parseSseStream(stream, input.signal)) {
    if (event.type !== "data") {
      continue;
    }
    const payload: unknown = JSON.parse(event.data);
    assertType(SessionSyncEventSchema, payload);
    await input.onSyncEvent(payload);
  }
}
