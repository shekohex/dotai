import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { AuthService, createChallengePayload } from "../src/remote/auth.ts";
import { createRemoteApp } from "../src/remote/app.ts";
import type { RemoteRuntimeFactory } from "../src/remote/runtime-factory.ts";
import { SessionRegistry } from "../src/remote/session-registry.ts";
import { InMemoryDurableStreamStore } from "../src/remote/streams.ts";

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
    kind: "first",
    payload: { sequence: 1 },
  });

  const seen: string[] = [];
  const subscription = streams.readAndSubscribe(streamId, first.streamOffset, (event) => {
    seen.push(event.kind);
  });

  const second = streams.append(streamId, {
    sessionId: null,
    kind: "second",
    payload: { sequence: 2 },
  });

  assert.equal(subscription.read.events.length, 0);
  assert.equal(subscription.read.nextOffset, first.streamOffset);
  assert.deepEqual(seen, ["second"]);
  assert.equal(second.kind, "second");
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
