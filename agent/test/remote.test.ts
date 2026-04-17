import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { AuthService, createChallengePayload } from "../src/remote/auth.ts";
import { createRemoteApp } from "../src/remote/app.ts";
import {
  InMemoryPiRuntimeFactory,
  type RemoteRuntimeFactory,
} from "../src/remote/runtime-factory.ts";
import { StreamReadResponseSchema } from "../src/remote/schemas.ts";
import { SessionRegistry } from "../src/remote/session-registry.ts";
import { InMemoryDurableStreamStore, sessionEventsStreamId } from "../src/remote/streams.ts";
import { assertType } from "../src/remote/typebox.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

class FakeRuntimeFactory implements RemoteRuntimeFactory {
  async create() {
    return {
      dispose: async () => undefined,
    } as any;
  }

  async dispose(): Promise<void> {}
}

class SlowRuntimeFactory implements RemoteRuntimeFactory {
  readonly delayMs: number;
  createCalls = 0;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async create() {
    this.createCalls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    return {
      dispose: async () => undefined,
    } as any;
  }

  async dispose(): Promise<void> {}
}

class RecordingSession {
  model = { provider: "pi-remote-faux", id: "pi-remote-faux-1" };
  thinkingLevel = "medium";
  isStreaming = false;
  isCompacting = false;
  isRetrying = false;
  pendingMessageCount = 0;
  messages: unknown[] = [];
  state = {
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined as string | undefined,
  };
  modelRegistry = {
    find: () => this.model,
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      apiKey: "test-key",
      headers: undefined,
    }),
    isUsingOAuth: () => false,
  };
  promptCalls: Array<{ text: string; options?: Record<string, unknown> }> = [];
  promptError: Error | undefined;
  steerCalls: Array<{
    text: string;
    images?: Array<{ type: string; data: string; mimeType: string }>;
  }> = [];
  followUpCalls: Array<{
    text: string;
    images?: Array<{ type: string; data: string; mimeType: string }>;
  }> = [];
  queuedSteering: string[] = [];
  queuedFollowUp: string[] = [];
  clearQueueCalls = 0;
  bindExtensionsError: Error | undefined;
  setModelError: Error | undefined;
  extensionRunner:
    | {
        getCommand: (name: string) => unknown;
      }
    | undefined;

  getActiveToolNames(): string[] {
    return ["read", "bash", "edit", "write"];
  }

  async bindExtensions(): Promise<void> {
    if (this.bindExtensionsError) {
      throw this.bindExtensionsError;
    }
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    if (this.promptError) {
      throw this.promptError;
    }
    this.promptCalls.push({ text, options });
    if (options?.streamingBehavior === "followUp") {
      this.queuedFollowUp.push(text);
      this.pendingMessageCount += 1;
    }
  }

  async steer(
    text: string,
    images?: Array<{ type: string; data: string; mimeType: string }>,
  ): Promise<void> {
    this.steerCalls.push({ text, images });
    this.queuedSteering.push(text);
    this.pendingMessageCount += 1;
  }

  async followUp(
    text: string,
    images?: Array<{ type: string; data: string; mimeType: string }>,
  ): Promise<void> {
    this.followUpCalls.push({ text, images });
    this.queuedFollowUp.push(text);
    this.pendingMessageCount += 1;
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1;
    const steering = [...this.queuedSteering];
    const followUp = [...this.queuedFollowUp];
    this.queuedSteering = [];
    this.queuedFollowUp = [];
    this.pendingMessageCount = 0;
    return {
      steering,
      followUp,
    };
  }

  async abort(): Promise<void> {}

  async setModel(model: { provider: string; id: string }): Promise<void> {
    if (this.setModelError) {
      throw this.setModelError;
    }
    this.model = model;
  }

  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }

  setSessionName(): void {}
}

class RacyPromptSession extends RecordingSession {
  private promptInFlight = false;
  private readonly startupTurns: number;

  constructor(startupTurns = 80) {
    super();
    this.startupTurns = startupTurns;
  }

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    this.promptCalls.push({ text, options });

    if (this.isStreaming) {
      if (options?.streamingBehavior !== "followUp") {
        throw new Error("already processing");
      }
      this.pendingMessageCount += 1;
      return;
    }

    if (this.promptInFlight) {
      throw new Error("already processing");
    }

    this.promptInFlight = true;
    for (let turn = 0; turn < this.startupTurns; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.isStreaming = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    this.isStreaming = false;
    this.pendingMessageCount = 0;
    this.promptInFlight = false;
  }
}

class BlockingPromptSession extends RecordingSession {
  private releasePromptStart: (() => void) | undefined;
  abortCalls = 0;
  dispatchOrder: string[] = [];

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    this.promptCalls.push({ text, options });
    this.dispatchOrder.push("prompt");
    await new Promise<void>((resolve) => {
      this.releasePromptStart = resolve;
    });
  }

  releasePrompt(): void {
    this.releasePromptStart?.();
    this.releasePromptStart = undefined;
  }

  override async abort(): Promise<void> {
    this.dispatchOrder.push("interrupt");
    this.abortCalls += 1;
  }

  override async steer(
    text: string,
    images?: Array<{ type: string; data: string; mimeType: string }>,
  ): Promise<void> {
    this.dispatchOrder.push("steer");
    await super.steer(text, images);
  }
}

class RecordingRuntimeFactory implements RemoteRuntimeFactory {
  readonly session: RecordingSession;
  runtimeDisposeCalls = 0;

  constructor(session: RecordingSession) {
    this.session = session;
  }

  async create() {
    return {
      session: this.session,
      dispose: async () => {
        this.runtimeDisposeCalls += 1;
      },
    } as any;
  }

  async dispose(): Promise<void> {}
}

function testAuthSession() {
  return {
    token: "token-dev",
    clientId: "dev",
    keyId: "dev",
    expiresAt: Date.now() + 60_000,
  };
}

async function authenticate(app: ReturnType<typeof createRemoteApp>["app"], privateKey: string) {
  const challengeResponse = await app.request("/v1/auth/challenge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ keyId: "dev" }),
  });
  assert.equal(challengeResponse.status, 200);
  const challenge = (await challengeResponse.json()) as {
    challengeId: string;
    nonce: string;
    origin: string;
    expiresAt: number;
  };

  const signature = sign(
    null,
    Buffer.from(
      createChallengePayload({
        challengeId: challenge.challengeId,
        keyId: "dev",
        nonce: challenge.nonce,
        origin: challenge.origin,
        expiresAt: challenge.expiresAt,
      }),
    ),
    privateKey,
  ).toString("base64");

  const verifyResponse = await app.request("/v1/auth/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      keyId: "dev",
      signature,
    }),
  });

  assert.equal(verifyResponse.status, 200);
  const verified = (await verifyResponse.json()) as { token: string };
  return verified.token;
}

async function postSessionCommand(
  app: ReturnType<typeof createRemoteApp>["app"],
  path: string,
  token: string,
  body: unknown,
) {
  const response = await app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return response;
}

async function readSessionEvents(
  app: ReturnType<typeof createRemoteApp>["app"],
  token: string,
  sessionId: string,
  offset: string,
  timeoutMs = 1_000,
): Promise<{
  events: Array<{ kind: string; payload: any; streamOffset: string }>;
  nextOffset: string;
}> {
  const response = await app.request(
    `/v1/streams/sessions/${sessionId}/events?live=long-poll&offset=${encodeURIComponent(offset)}&timeoutMs=${timeoutMs}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );

  if (response.status === 204) {
    return {
      events: [],
      nextOffset: response.headers.get("Stream-Next-Offset") ?? offset,
    };
  }

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    events: Array<{ kind: string; payload: any; streamOffset: string }>;
    nextOffset: string;
  };
  return {
    events: body.events,
    nextOffset: body.nextOffset,
  };
}

async function waitForSessionEvent(
  app: ReturnType<typeof createRemoteApp>["app"],
  token: string,
  sessionId: string,
  offset: string,
  predicate: (event: { kind: string; payload: any; streamOffset: string }) => boolean,
): Promise<{
  event: { kind: string; payload: any; streamOffset: string };
  nextOffset: string;
}> {
  let nextOffset = offset;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = await readSessionEvents(app, token, sessionId, nextOffset, 1_000);
    nextOffset = read.nextOffset;
    const matched = read.events.find(predicate);
    if (matched) {
      return {
        event: matched,
        nextOffset,
      };
    }
  }
  throw new Error("Timed out waiting for session event");
}

timedTest("milestone 1 flow works end to end", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const authHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ sessionName: "Milestone Session" }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };
    assert.ok(created.sessionId);

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      sessionId: string;
      draftRevision: number;
      lastSessionStreamOffset: string;
    };
    assert.equal(snapshot.sessionId, created.sessionId);
    assert.equal(snapshot.draftRevision, 0);

    const firstAttach = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(firstAttach.status, 200);
    const firstAttachBody = (await firstAttach.json()) as {
      events: unknown[];
      nextOffset: string;
      streamClosed: boolean;
    };
    assert.deepEqual(firstAttachBody.events, []);
    assert.equal(firstAttachBody.nextOffset, "0000000000000000_0000000000000000");
    assert.equal(firstAttachBody.streamClosed, false);

    const reconnect = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(firstAttachBody.nextOffset)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(reconnect.status, 200);
    const reconnectBody = (await reconnect.json()) as {
      events: unknown[];
      nextOffset: string;
      streamClosed: boolean;
    };
    assert.deepEqual(reconnectBody.events, []);
    assert.equal(reconnectBody.nextOffset, firstAttachBody.nextOffset);
    assert.equal(reconnectBody.streamClosed, false);

    const appStream = await remote.app.request("/v1/streams/app-events", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(appStream.status, 200);
    const appStreamBody = (await appStream.json()) as {
      events: Array<{ kind: string }>;
      nextOffset: string;
      streamClosed: boolean;
    };
    assert.equal(appStreamBody.events.length, 1);
    assert.equal(appStreamBody.events[0]?.kind, "session_created");
    assert.equal(appStreamBody.nextOffset, "0000000000000000_0000000000000001");
    assert.equal(appStreamBody.streamClosed, false);

    const appReconnect = await remote.app.request(
      `/v1/streams/app-events?offset=${encodeURIComponent(appStreamBody.nextOffset)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(appReconnect.status, 200);
    const appReconnectBody = (await appReconnect.json()) as {
      events: unknown[];
      streamClosed: boolean;
    };
    assert.deepEqual(appReconnectBody.events, []);
    assert.equal(appReconnectBody.streamClosed, false);

    const openApiResponse = await remote.app.request("/openapi.json");
    assert.equal(openApiResponse.status, 200);
    const openApi = (await openApiResponse.json()) as { paths: Record<string, unknown> };
    assert.ok(openApi.paths["/v1/auth/challenge"]);
    assert.ok(openApi.paths["/v1/auth/verify"]);
    assert.ok(openApi.paths["/v1/app/snapshot"]);
    assert.ok(openApi.paths["/v1/sessions"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/snapshot"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/prompt"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/steer"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/follow-up"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/interrupt"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/draft"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/model"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/session-name"]);
    const appStreamResponses = (openApi.paths["/v1/streams/app-events"] as any)?.get?.responses;
    assert.ok(appStreamResponses?.["200"]?.content?.["application/json"]);
    assert.ok(appStreamResponses?.["200"]?.content?.["text/event-stream"]);
  } finally {
    await remote.dispose();
  }
});

timedTest("stream endpoints reject malformed offsets", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const appStream = await remote.app.request("/v1/streams/app-events?offset=bad-offset", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(appStream.status, 400);

    const sessionStream = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=bad-offset`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(sessionStream.status, 400);
  } finally {
    await remote.dispose();
  }
});

timedTest("readAndSubscribe includes replay and post-subscribe events", () => {
  const streams = new InMemoryDurableStreamStore();
  const streamId = "app-events";
  streams.ensureStream(streamId);

  const first = streams.append(streamId, {
    sessionId: null,
    kind: "server_notice",
    payload: { message: "first" },
  });

  const seen: string[] = [];
  const subscription = streams.readAndSubscribe(streamId, first.streamOffset, (event) => {
    seen.push(event.kind);
  });

  const second = streams.append(streamId, {
    sessionId: null,
    kind: "auth_notice",
    payload: { message: "second" },
  });

  assert.equal(subscription.read.events.length, 0);
  assert.equal(subscription.read.nextOffset, first.streamOffset);
  assert.deepEqual(seen, ["auth_notice"]);
  assert.equal(second.kind, "auth_notice");
  subscription.unsubscribe();
});

timedTest("stream endpoints accept durable protocol sentinel offsets", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(createResponse.status, 201);

    const fromStart = await remote.app.request("/v1/streams/app-events?offset=-1", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(fromStart.status, 200);
    const fromStartBody = (await fromStart.json()) as {
      events: Array<{ kind: string }>;
      fromOffset: string;
    };
    assert.equal(fromStartBody.fromOffset, "-1");
    assert.equal(fromStartBody.events.length, 1);
    assert.equal(fromStartBody.events[0]?.kind, "session_created");

    const fromNow = await remote.app.request("/v1/streams/app-events?offset=now", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(fromNow.status, 200);
    const fromNowBody = (await fromNow.json()) as {
      events: unknown[];
      fromOffset: string;
      nextOffset: string;
    };
    assert.deepEqual(fromNowBody.events, []);
    assert.equal(fromNowBody.fromOffset, fromNowBody.nextOffset);
  } finally {
    await remote.dispose();
  }
});

timedTest("live stream modes require offset", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const appSse = await remote.app.request("/v1/streams/app-events?live=sse", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(appSse.status, 400);

    const sessionLongPoll = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?live=long-poll`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(sessionLongPoll.status, 400);
  } finally {
    await remote.dispose();
  }
});

timedTest("long-poll timeout returns 204 with stream headers", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const longPoll = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?live=long-poll&offset=${encodeURIComponent("0000000000000000_0000000000000000")}&timeoutMs=250`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );

    assert.equal(longPoll.status, 204);
    assert.equal(longPoll.headers.get("Stream-Next-Offset"), "0000000000000000_0000000000000000");
    assert.equal(longPoll.headers.get("Stream-Up-To-Date"), "true");
    assert.equal(longPoll.headers.get("Stream-Closed"), null);
    assert.match(longPoll.headers.get("Stream-Cursor") ?? "", /^\d+$/);
  } finally {
    await remote.dispose();
  }
});

timedTest("long-poll with offset=now returns newly appended events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const headers = { authorization: `Bearer ${token}` };

    const longPollPromise = remote.app.request(
      "/v1/streams/app-events?live=long-poll&offset=now&timeoutMs=1000",
      {
        headers,
      },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(createResponse.status, 201);

    const longPoll = await longPollPromise;
    assert.equal(longPoll.status, 200);
    const body = (await longPoll.json()) as {
      events: Array<{ kind: string }>;
      timedOut?: boolean;
    };

    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]?.kind, "session_created");
  } finally {
    await remote.dispose();
  }
});

timedTest("sse uses data and control events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(createResponse.status, 201);

    const sse = await remote.app.request(
      "/v1/streams/app-events?live=sse&offset=0000000000000000_0000000000000000",
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );

    assert.equal(sse.status, 200);
    assert.equal(sse.headers.get("content-type"), "text/event-stream");
    assert.equal(sse.headers.get("Stream-Next-Offset"), "0000000000000000_0000000000000001");
    assert.match(sse.headers.get("Stream-Cursor") ?? "", /^\d+$/);

    const reader = sse.body?.getReader();
    assert.ok(reader);
    let payload = "";
    for (let index = 0; index < 4; index += 1) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
      payload += new TextDecoder().decode(chunk.value);
      if (payload.includes("event: control")) {
        break;
      }
    }

    await reader?.cancel();
    assert.match(payload, /event: data/);
    assert.match(payload, /event: control/);
    assert.match(payload, /"streamNextOffset":"0000000000000000_0000000000000001"/);
    assert.match(payload, /"streamCursor":"\d+"/);
    assert.doesNotMatch(payload, /event: ready/);
  } finally {
    await remote.dispose();
  }
});

timedTest("auth service prunes expired and consumed records", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  let now = 0;
  const auth = new AuthService({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    challengeTtlMs: 10,
    tokenTtlMs: 10,
    now: () => now,
  });

  const challenge = auth.createChallenge("dev");
  const signature = sign(
    null,
    Buffer.from(
      createChallengePayload({
        challengeId: challenge.challengeId,
        keyId: "dev",
        nonce: challenge.nonce,
        origin: challenge.origin,
        expiresAt: challenge.expiresAt,
      }),
    ),
    privateKeyPem,
  ).toString("base64");

  auth.verifyChallenge({
    challengeId: challenge.challengeId,
    keyId: "dev",
    signature,
  });

  assert.equal((auth as any).challenges.size, 0);
  assert.equal((auth as any).tokens.size, 1);

  now = 100;
  auth.createChallenge("dev");
  assert.equal((auth as any).tokens.size, 0);
  assert.equal((auth as any).challenges.size, 1);
});

timedTest("auth service rejects non-ed25519 public keys", () => {
  const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPublicKeyPem = rsaKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

  assert.throws(
    () =>
      new AuthService({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "rsa", publicKey: rsaPublicKeyPem }],
      }),
    /ed25519/,
  );

  const ed25519Keys = generateKeyPairSync("ed25519");
  const ed25519PublicKeyPem = ed25519Keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  const auth = new AuthService({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "ed", publicKey: ed25519PublicKeyPem }],
  });
  const challenge = auth.createChallenge("ed");
  assert.equal(challenge.algorithm, "ed25519");
});

timedTest("session creation remains single-session under concurrent requests", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const runtimeFactory = new SlowRuntimeFactory(75);
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory,
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const [first, second] = await Promise.all([
      remote.app.request("/v1/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionName: "one" }),
      }),
      remote.app.request("/v1/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionName: "two" }),
      }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(runtimeFactory.createCalls, 1);

    const snapshotResponse = await remote.app.request("/v1/app/snapshot", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      sessionSummaries: Array<{ sessionId: string }>;
    };
    assert.equal(snapshot.sessionSummaries.length, 1);
  } finally {
    await remote.dispose();
  }
});

timedTest("presence tracks concurrent tokens independently", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const tokenA = await authenticate(remote.app, privateKeyPem);
    const tokenB = await authenticate(remote.app, privateKeyPem);

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotB = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });

    assert.equal(snapshotB.status, 200);
    const snapshot = (await snapshotB.json()) as {
      presence: Array<{ clientId: string; connectionId: string }>;
    };
    assert.equal(snapshot.presence.length, 2);
    assert.equal(snapshot.presence[0]?.clientId, "dev");
    assert.equal(snapshot.presence[1]?.clientId, "dev");
    assert.notEqual(snapshot.presence[0]?.connectionId, snapshot.presence[1]?.connectionId);
  } finally {
    await remote.dispose();
  }
});

timedTest("presence tracks concurrent connections for the same token", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-pi-connection-id": "conn-a",
      },
      body: JSON.stringify({}),
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const streamA = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent("0000000000000000_0000000000000000")}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-pi-connection-id": "conn-a",
        },
      },
    );
    assert.equal(streamA.status, 200);

    const streamB = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent("0000000000000000_0000000000000000")}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-pi-connection-id": "conn-b",
        },
      },
    );
    assert.equal(streamB.status, 200);

    const snapshot = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-pi-connection-id": "conn-a",
      },
    });

    assert.equal(snapshot.status, 200);
    const body = (await snapshot.json()) as {
      presence: Array<{ clientId: string; connectionId: string }>;
    };
    assert.equal(body.presence.length, 2);
    const connectionIds = body.presence.map((presence) => presence.connectionId).sort();
    assert.deepEqual(connectionIds, ["conn-a", "conn-b"]);
    assert.equal(body.presence[0]?.clientId, "dev");
    assert.equal(body.presence[1]?.clientId, "dev");
  } finally {
    await remote.dispose();
  }
});

timedTest("presence does not grow when connection header is omitted", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotA = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    assert.equal(snapshotA.status, 200);

    const snapshotB = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    assert.equal(snapshotB.status, 200);

    const body = (await snapshotB.json()) as {
      presence: Array<{ connectionId: string }>;
    };
    assert.equal(body.presence.length, 1);
  } finally {
    await remote.dispose();
  }
});

timedTest("session registry prunes stale presence and supports detach", async () => {
  const streams = new InMemoryDurableStreamStore();
  let now = 0;
  const registry = new SessionRegistry({
    streams,
    runtimeFactory: new FakeRuntimeFactory(),
    presenceTtlMs: 50,
    now: () => now,
  });
  const authSession = {
    token: "token-a",
    clientId: "dev",
    keyId: "dev",
    expiresAt: 1_000,
  };

  try {
    const created = await registry.createSession({}, authSession, "conn-a");
    now = 10;
    registry.touchPresence(created.sessionId, authSession, "conn-b");

    const activeSnapshot = registry.getSessionSnapshot(created.sessionId, authSession, "conn-a");
    assert.equal(activeSnapshot.presence.length, 2);

    now = 100;
    const prunedSnapshot = registry.getSessionSnapshot(created.sessionId, authSession, "conn-c");
    assert.equal(prunedSnapshot.presence.length, 1);
    assert.equal(prunedSnapshot.presence[0]?.connectionId, "conn-c");

    registry.touchPresence(created.sessionId, authSession, "conn-d");
    registry.detachPresence(created.sessionId, "conn-d");
    const detachedSnapshot = registry.getSessionSnapshot(created.sessionId, authSession, "conn-c");
    assert.equal(detachedSnapshot.presence.length, 1);
    assert.equal(detachedSnapshot.presence[0]?.connectionId, "conn-c");
  } finally {
    await registry.dispose();
  }
});

timedTest("accepted command failure persists error state in snapshots", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.promptError = new Error("missing API key");
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const accepted = await registry.prompt(
      created.sessionId,
      {
        text: "run",
      },
      auth,
      "conn-a",
    );
    assert.equal(accepted.sequence, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    const firstSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(firstSnapshot.status, "error");
    assert.equal(firstSnapshot.errorMessage, "missing API key");

    const secondSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(secondSnapshot.status, "error");
    assert.equal(secondSnapshot.errorMessage, "missing API key");

    const events = streams.read(sessionEventsStreamId(created.sessionId), "-1").events;
    assert.ok(events.some((event) => event.kind === "command_accepted"));
    assert.ok(events.some((event) => event.kind === "extension_error"));
  } finally {
    await registry.dispose();
  }
});

timedTest("snapshot and summary polling keeps updatedAt stable", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  let now = 0;
  const registry = new SessionRegistry({
    streams,
    runtimeFactory: new RecordingRuntimeFactory(session),
    now: () => {
      now += 1;
      return now;
    },
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const initialSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    const initialUpdatedAt = initialSnapshot.updatedAt;

    const polledSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(polledSnapshot.updatedAt, initialUpdatedAt);

    const summariesA = registry.listSessionSummaries();
    const summariesB = registry.listSessionSummaries();
    assert.equal(summariesA[0]?.updatedAt, initialUpdatedAt);
    assert.equal(summariesB[0]?.updatedAt, initialUpdatedAt);
  } finally {
    await registry.dispose();
  }
});

timedTest("stream read schema rejects unknown kinds and malformed payloads", () => {
  assert.throws(
    () =>
      assertType(StreamReadResponseSchema, {
        streamId: "app-events",
        fromOffset: "0000000000000000_0000000000000000",
        nextOffset: "0000000000000000_0000000000000001",
        upToDate: true,
        streamClosed: false,
        events: [
          {
            eventId: "evt-1",
            sessionId: null,
            streamOffset: "0000000000000000_0000000000000001",
            ts: Date.now(),
            kind: "unknown_kind",
            payload: {},
          },
        ],
      }),
    /Schema validation failed/,
  );

  assert.throws(
    () =>
      assertType(StreamReadResponseSchema, {
        streamId: "app-events",
        fromOffset: "0000000000000000_0000000000000000",
        nextOffset: "0000000000000000_0000000000000001",
        upToDate: true,
        streamClosed: false,
        events: [
          {
            eventId: "evt-1",
            sessionId: null,
            streamOffset: "0000000000000000_0000000000000001",
            ts: Date.now(),
            kind: "session_created",
            payload: {
              sessionId: "sess-1",
            },
          },
        ],
      }),
    /Schema validation failed/,
  );
});

timedTest("failed model update does not emit command_accepted or consume sequence", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.modelRegistry = {
    find: () => ({ provider: "openai", id: "gpt-4o" }),
  };
  session.setModelError = new Error("No API key for openai/gpt-4o");
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const beforeOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    await assert.rejects(
      registry.updateModel(
        created.sessionId,
        {
          model: "openai/gpt-4o",
        },
        auth,
        "conn-a",
      ),
      /No API key for openai\/gpt-4o/,
    );

    const replay = streams.read(sessionEventsStreamId(created.sessionId), beforeOffset);
    assert.ok(replay.events.every((event) => event.kind !== "command_accepted"));

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(snapshot.queue.nextSequence, 1);
  } finally {
    await registry.dispose();
  }
});

timedTest("invalid thinkingLevel is rejected before command acceptance", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const beforeOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    await assert.rejects(
      registry.updateModel(
        created.sessionId,
        {
          model: "pi-remote-faux/pi-remote-faux-1",
          thinkingLevel: "ultra",
        },
        auth,
        "conn-a",
      ),
      /Invalid thinkingLevel/,
    );

    const replay = streams.read(sessionEventsStreamId(created.sessionId), beforeOffset);
    assert.ok(replay.events.every((event) => event.kind !== "command_accepted"));

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(snapshot.queue.nextSequence, 1);
    assert.equal(snapshot.thinkingLevel, "medium");
  } finally {
    await registry.dispose();
  }
});

timedTest("prompt preflight rejects missing auth before command acceptance", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.modelRegistry = {
    find: () => session.model,
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      apiKey: undefined,
      headers: undefined,
    }),
    isUsingOAuth: () => false,
  };
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const beforeOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    await assert.rejects(
      registry.prompt(
        created.sessionId,
        {
          text: "prompt",
        },
        auth,
        "conn-a",
      ),
      /No API key found for pi-remote-faux/,
    );

    const replay = streams.read(sessionEventsStreamId(created.sessionId), beforeOffset);
    assert.ok(replay.events.every((event) => event.kind !== "command_accepted"));
    assert.ok(replay.events.every((event) => event.kind !== "extension_error"));

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(snapshot.queue.nextSequence, 1);
    assert.equal(session.promptCalls.length, 0);
  } finally {
    await registry.dispose();
  }
});

timedTest("prompt skips preflight when already streaming and queues follow-up", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.isStreaming = true;
  session.modelRegistry = {
    find: () => session.model,
    getApiKeyAndHeaders: async () => ({
      ok: false as const,
      error: "transient auth failure",
    }),
    isUsingOAuth: () => false,
  };
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const accepted = await registry.prompt(
      created.sessionId,
      {
        text: "queued while streaming",
      },
      auth,
      "conn-a",
    );

    assert.equal(accepted.sequence, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.promptCalls.length, 1);
    assert.equal(session.promptCalls[0]?.text, "queued while streaming");
    assert.equal(session.promptCalls[0]?.options?.streamingBehavior, "followUp");

    const events = streams.read(sessionEventsStreamId(created.sessionId), "-1").events;
    assert.ok(events.some((event) => event.kind === "command_accepted"));
    assert.ok(events.every((event) => event.kind !== "extension_error"));
  } finally {
    await registry.dispose();
  }
});

timedTest("registered slash commands bypass prompt preflight", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.modelRegistry = {
    find: () => session.model,
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      apiKey: undefined,
      headers: undefined,
    }),
    isUsingOAuth: () => false,
  };
  session.extensionRunner = {
    getCommand: (name: string) => (name === "login" ? { name } : undefined),
  };

  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const accepted = await registry.prompt(
      created.sessionId,
      {
        text: "/login openai",
      },
      auth,
      "conn-a",
    );

    assert.equal(accepted.sequence, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.promptCalls.length, 1);
    assert.equal(session.promptCalls[0]?.text, "/login openai");

    const events = streams.read(sessionEventsStreamId(created.sessionId), "-1").events;
    assert.ok(events.some((event) => event.kind === "command_accepted"));
    assert.ok(events.every((event) => event.kind !== "extension_error"));
  } finally {
    await registry.dispose();
  }
});

timedTest("runtime dispatch serializes prompt start ordering", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RacyPromptSession(96);
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");

    const [first, second] = await Promise.all([
      registry.prompt(
        created.sessionId,
        {
          text: "first",
        },
        auth,
        "conn-a",
      ),
      registry.prompt(
        created.sessionId,
        {
          text: "second",
        },
        auth,
        "conn-a",
      ),
    ]);

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.equal(session.promptCalls.length, 2);
    assert.equal(session.promptCalls[0]?.text, "first");
    assert.equal(session.promptCalls[1]?.text, "second");
    assert.equal(session.promptCalls[1]?.options?.streamingBehavior, "followUp");

    const events = streams.read(sessionEventsStreamId(created.sessionId), "-1").events;
    assert.ok(events.filter((event) => event.kind === "command_accepted").length >= 2);
    assert.ok(events.every((event) => event.kind !== "extension_error"));
  } finally {
    await registry.dispose();
  }
});

timedTest("interrupt stays ordered behind queued commands during prompt startup", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new BlockingPromptSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");

    const promptAccepted = await registry.prompt(
      created.sessionId,
      {
        text: "long startup",
      },
      auth,
      "conn-a",
    );
    assert.equal(promptAccepted.sequence, 1);

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "queued steer",
      },
      auth,
      "conn-a",
    );
    assert.equal(steerAccepted.sequence, 2);

    const interruptAccepted = await registry.interrupt(created.sessionId, {}, auth, "conn-a");
    assert.equal(interruptAccepted.sequence, 3);

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(session.steerCalls.length, 0);
    assert.equal(session.abortCalls, 0);

    session.releasePrompt();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    assert.equal(session.steerCalls.length, 1);
    assert.equal(session.abortCalls, 1);
    assert.deepEqual(session.dispatchOrder, ["prompt", "steer", "interrupt"]);
  } finally {
    session.releasePrompt();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await registry.dispose();
  }
});

timedTest("snapshot queue depth includes accepted-but-undispatched commands", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new BlockingPromptSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");

    const promptAccepted = await registry.prompt(
      created.sessionId,
      {
        text: "long startup",
      },
      auth,
      "conn-a",
    );
    assert.equal(promptAccepted.sequence, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "queued steer",
      },
      auth,
      "conn-a",
    );
    assert.equal(steerAccepted.sequence, 2);

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    const headOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    assert.equal(snapshot.lastSessionStreamOffset, headOffset);
    assert.ok(snapshot.queue.depth >= 1);
  } finally {
    session.releasePrompt();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await registry.dispose();
  }
});

timedTest("interrupt clears queued steering and follow-up before aborting", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.isStreaming = true;
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "queued steer",
      },
      auth,
      "conn-a",
    );
    assert.equal(steerAccepted.sequence, 1);

    const followUpAccepted = await registry.followUp(
      created.sessionId,
      {
        text: "queued follow-up",
      },
      auth,
      "conn-a",
    );
    assert.equal(followUpAccepted.sequence, 2);

    const interruptAccepted = await registry.interrupt(created.sessionId, {}, auth, "conn-a");
    assert.equal(interruptAccepted.sequence, 3);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.clearQueueCalls, 1);
    assert.deepEqual(session.queuedSteering, []);
    assert.deepEqual(session.queuedFollowUp, []);
  } finally {
    await registry.dispose();
  }
});

timedTest("prompt, steer, and follow-up forward attachments", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const attachments = ["data:image/png;base64,AAAA", "BBBB"];

    const promptAccepted = await registry.prompt(
      created.sessionId,
      {
        text: "prompt",
        attachments,
      },
      auth,
      "conn-a",
    );
    assert.equal(promptAccepted.sequence, 1);

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "steer",
        attachments,
      },
      auth,
      "conn-a",
    );
    assert.equal(steerAccepted.sequence, 2);

    const followUpAccepted = await registry.followUp(
      created.sessionId,
      {
        text: "follow-up",
        attachments,
      },
      auth,
      "conn-a",
    );
    assert.equal(followUpAccepted.sequence, 3);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.promptCalls.length, 1);
    assert.equal(session.steerCalls.length, 1);
    assert.equal(session.followUpCalls.length, 1);

    assert.deepEqual(session.promptCalls[0]?.options?.images, [
      {
        type: "image",
        mimeType: "image/png",
        data: "AAAA",
      },
      {
        type: "image",
        mimeType: "application/octet-stream",
        data: "BBBB",
      },
    ]);
    assert.deepEqual(session.steerCalls[0]?.images, [
      {
        type: "image",
        mimeType: "image/png",
        data: "AAAA",
      },
      {
        type: "image",
        mimeType: "application/octet-stream",
        data: "BBBB",
      },
    ]);
    assert.deepEqual(session.followUpCalls[0]?.images, [
      {
        type: "image",
        mimeType: "image/png",
        data: "AAAA",
      },
      {
        type: "image",
        mimeType: "application/octet-stream",
        data: "BBBB",
      },
    ]);
  } finally {
    await registry.dispose();
  }
});

timedTest("createSession disposes runtime when session initialization fails", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.bindExtensionsError = new Error("bind failed");
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    await assert.rejects(registry.createSession({}, auth, "conn-a"), /bind failed/);
    assert.equal(runtimeFactory.runtimeDisposeCalls, 1);

    const snapshot = registry.getAppSnapshot(auth);
    assert.equal(snapshot.sessionSummaries.length, 0);
  } finally {
    await registry.dispose();
  }
});

timedTest("open stream responses omit Stream-Closed header", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(createResponse.status, 201);

    const streamResponse = await remote.app.request("/v1/streams/app-events?offset=-1", {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get("Stream-Closed"), null);
  } finally {
    await remote.dispose();
  }
});

timedTest("milestone 2 command surface sequences commands and replays session events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
  });

  try {
    const tokenA = await authenticate(remote.app, privateKeyPem);
    const tokenB = await authenticate(remote.app, privateKeyPem);

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "x-pi-connection-id": "device-a",
      },
      body: JSON.stringify({ sessionName: "Milestone 2" }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const initialSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${tokenA}`,
          "x-pi-connection-id": "device-a",
        },
      },
    );
    assert.equal(initialSnapshotResponse.status, 200);
    const initialSnapshot = (await initialSnapshotResponse.json()) as {
      model: string;
      thinkingLevel: string;
      lastSessionStreamOffset: string;
    };

    const [draftAResponse, draftBResponse] = await Promise.all([
      postSessionCommand(remote.app, `/v1/sessions/${created.sessionId}/draft`, tokenA, {
        text: "draft from a",
        attachments: ["a.txt"],
      }),
      postSessionCommand(remote.app, `/v1/sessions/${created.sessionId}/draft`, tokenB, {
        text: "draft from b",
        attachments: ["b.txt"],
      }),
    ]);

    assert.equal(draftAResponse.status, 202);
    assert.equal(draftBResponse.status, 202);
    const draftAcceptedA = (await draftAResponse.json()) as {
      sequence: number;
    };
    const draftAcceptedB = (await draftBResponse.json()) as {
      sequence: number;
    };
    const draftSequences = [draftAcceptedA.sequence, draftAcceptedB.sequence].sort((a, b) => a - b);
    assert.deepEqual(draftSequences, [1, 2]);

    const draftReplayResponse = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(initialSnapshot.lastSessionStreamOffset)}`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
    );
    assert.equal(draftReplayResponse.status, 200);
    const draftReplay = (await draftReplayResponse.json()) as {
      events: Array<{ kind: string; payload: any }>;
      nextOffset: string;
    };
    const draftUpdatedEvents = draftReplay.events.filter((event) => event.kind === "draft_updated");
    assert.equal(draftUpdatedEvents.length, 2);
    const revisions = draftUpdatedEvents
      .map((event) => event.payload?.draft?.revision as number)
      .sort((a, b) => a - b);
    assert.deepEqual(revisions, [1, 2]);
    const replayOffset = draftReplay.nextOffset;

    const nameResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/session-name`,
      tokenA,
      {
        sessionName: "Milestone 2 Renamed",
      },
    );
    assert.equal(nameResponse.status, 202);
    const nameAccepted = (await nameResponse.json()) as { sequence: number };
    assert.equal(nameAccepted.sequence, 3);

    const modelResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/model`,
      tokenA,
      {
        model: initialSnapshot.model,
        thinkingLevel: initialSnapshot.thinkingLevel,
      },
    );
    assert.equal(modelResponse.status, 202);
    const modelAccepted = (await modelResponse.json()) as { sequence: number };
    assert.equal(modelAccepted.sequence, 4);

    const promptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/prompt`,
      tokenA,
      {
        text: "Say hello in one sentence.",
      },
    );
    assert.equal(promptResponse.status, 202);
    const promptAccepted = (await promptResponse.json()) as { sequence: number };
    assert.equal(promptAccepted.sequence, 5);

    const steerResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/steer`,
      tokenB,
      {
        text: "Keep it very short.",
      },
    );
    assert.equal(steerResponse.status, 202);
    const steerAccepted = (await steerResponse.json()) as { sequence: number };
    assert.equal(steerAccepted.sequence, 6);

    const followUpResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/follow-up`,
      tokenB,
      {
        text: "Then add one more short sentence.",
      },
    );
    assert.equal(followUpResponse.status, 202);
    const followUpAccepted = (await followUpResponse.json()) as { sequence: number };
    assert.equal(followUpAccepted.sequence, 7);

    const interruptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/interrupt`,
      tokenA,
      {},
    );
    assert.equal(interruptResponse.status, 202);
    const interruptAccepted = (await interruptResponse.json()) as { sequence: number };
    assert.equal(interruptAccepted.sequence, 8);

    const waited = await waitForSessionEvent(
      remote.app,
      tokenA,
      created.sessionId,
      replayOffset,
      (event) =>
        event.kind === "agent_session_event" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        (event.payload as { type?: string }).type === "agent_end",
    );
    assert.equal(waited.event.kind, "agent_session_event");
    assert.equal((waited.event.payload as { type: string }).type, "agent_end");

    const resumedResponse = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(replayOffset)}`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
    );
    assert.equal(resumedResponse.status, 200);
    const resumed = (await resumedResponse.json()) as {
      events: Array<{ kind: string; payload: any }>;
      nextOffset: string;
    };
    assert.ok(resumed.events.some((event) => event.kind === "command_accepted"));
    assert.ok(resumed.events.some((event) => event.kind === "agent_session_event"));
    assert.ok(!resumed.events.some((event) => event.kind === "extension_error"));

    const postPromptSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
    );
    assert.equal(postPromptSnapshotResponse.status, 200);
    const postPromptSnapshot = (await postPromptSnapshotResponse.json()) as {
      transcript: Array<{ role?: string }>;
    };
    assert.ok(postPromptSnapshot.transcript.some((message) => message.role === "assistant"));

    const secondDeviceSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${tokenB}`,
          "x-pi-connection-id": "device-b",
        },
      },
    );
    assert.equal(secondDeviceSnapshotResponse.status, 200);
    const secondDeviceSnapshot = (await secondDeviceSnapshotResponse.json()) as {
      sessionName: string;
      draftRevision: number;
      presence: Array<{ connectionId: string }>;
      transcript: Array<{ role?: string }>;
    };
    assert.equal(secondDeviceSnapshot.sessionName, "Milestone 2 Renamed");
    assert.equal(secondDeviceSnapshot.draftRevision, 2);
    assert.ok(secondDeviceSnapshot.transcript.some((message) => message.role === "assistant"));
    assert.ok(
      secondDeviceSnapshot.presence.some((presence) => presence.connectionId === "device-a"),
    );
    assert.ok(
      secondDeviceSnapshot.presence.some((presence) => presence.connectionId === "device-b"),
    );

    const secondDeviceResume = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(resumed.nextOffset)}`,
      {
        headers: { authorization: `Bearer ${tokenB}` },
      },
    );
    assert.equal(secondDeviceResume.status, 200);
    const secondDeviceResumeBody = (await secondDeviceResume.json()) as {
      events: unknown[];
    };
    assert.deepEqual(secondDeviceResumeBody.events, []);
  } finally {
    await remote.dispose();
  }
});

timedTest("default runtime factory hosts an in-memory Pi runtime", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };
    assert.ok(created.sessionId);
  } finally {
    await remote.dispose();
  }
});

timedTest("in-memory runtime factory preserves explicit null fauxApiKey", async () => {
  const defaultFactory = new InMemoryPiRuntimeFactory();
  const defaultRuntime = await defaultFactory.create();
  const defaultKey = await defaultRuntime.services.authStorage.getApiKey("pi-remote-faux");

  assert.equal(defaultKey, "pi-remote-faux-local-key");

  await defaultRuntime.dispose();
  await defaultFactory.dispose();

  const nullFactory = new InMemoryPiRuntimeFactory({
    fauxApiKey: null,
  });
  const nullRuntime = await nullFactory.create();
  const nullKey = await nullRuntime.services.authStorage.getApiKey("pi-remote-faux");

  assert.equal(nullKey, undefined);

  await nullRuntime.dispose();
  await nullFactory.dispose();
});
