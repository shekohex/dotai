import { expect, test } from "vitest";
import { createRemoteApp } from "../src/remote/app.ts";
import { createInProcessFetch } from "../src/remote/client-runtime.ts";
import { SessionLiveEventBus } from "../src/remote/live-events.ts";
import { RemoteApiClient } from "../src/remote/runtime-api/client.ts";
import { BundledPiRuntimeFactory } from "../src/remote/runtime-factory.ts";
import { bufferPatchEvent } from "../src/remote/routes/session-sync.ts";
import { flushPersistedSessionManagerToDisk } from "../src/remote/session-manager-storage.ts";
import { SessionRegistry } from "../src/remote/session-registry.ts";
import {
  persistDurableRuntimeDomainState,
  restoreDurableRuntimeDomainState,
} from "../src/remote/session/durable-runtime-state.ts";
import { createSessionRecord } from "../src/remote/session/command-registry.ts";
import type { SessionRecord } from "../src/remote/session/deps.ts";
import type { SessionSyncEvent } from "../src/remote/schemas.ts";
import { TEST_ED25519_KEYS } from "./remote-test-keys.ts";

class InspectableSessionRegistry extends SessionRegistry {
  readLoadedRecord(sessionId: string) {
    return this.getLoadedSessions().get(sessionId);
  }

  buildSnapshot(record: SessionRecord) {
    return this.toSessionSnapshot(record);
  }
}

test("session sync stays snapshot-first across reconnect", async () => {
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: TEST_ED25519_KEYS.publicKeyPem }],
  });

  try {
    const client = await createClient(remote.app);
    const created = await client.createSession({ persistence: "persistent" });

    const initialEvents = await collectSyncEvents(client, created.sessionId, 2);
    expect(initialEvents.map((event) => event.type)).toEqual(["server.connected", "snapshot"]);

    await client.emitSessionCustomEvent(created.sessionId, {
      channel: "panel.state",
      data: { sync: "durable", replaceKey: "panel", value: "ready" },
    });

    const reconnectEvents = await collectSyncEvents(client, created.sessionId, 2);
    expect(reconnectEvents.map((event) => event.type)).toEqual(["server.connected", "snapshot"]);
    expect(reconnectEvents[1]?.type).toBe("snapshot");
    if (reconnectEvents[1]?.type !== "snapshot") {
      throw new Error("missing reconnect snapshot");
    }
    expect(reconnectEvents[1].snapshot.durableExtensionState).toContainEqual({
      channel: "panel.state",
      data: { sync: "durable", replaceKey: "panel", value: "ready" },
    });
  } finally {
    await remote.dispose();
  }
}, 15_000);

test("live patches deliver to multiple clients and converge after reconnect", async () => {
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: TEST_ED25519_KEYS.publicKeyPem }],
  });

  try {
    const clientA = await createClient(remote.app);
    const clientB = await createClient(remote.app);
    const created = await clientA.createSession({ persistence: "persistent" });

    const patchPromiseA = collectSyncEvents(
      clientA,
      created.sessionId,
      3,
      (event) => event.type === "patch",
    );
    const patchPromiseB = collectSyncEvents(
      clientB,
      created.sessionId,
      3,
      (event) => event.type === "patch",
    );

    await clientA.emitSessionCustomEvent(created.sessionId, {
      channel: "shared.state",
      data: { sync: "durable", replaceKey: "shared", value: { count: 1 } },
    });

    const [eventsA, eventsB] = await Promise.all([patchPromiseA, patchPromiseB]);
    const patchA = eventsA.at(-1);
    const patchB = eventsB.at(-1);
    expect(patchA).toEqual(patchB);
    expect(patchA?.type).toBe("patch");

    const reconnectA = await collectSyncEvents(clientA, created.sessionId, 2);
    const reconnectB = await collectSyncEvents(clientB, created.sessionId, 2);
    expect(reconnectA[1]?.type).toBe("snapshot");
    expect(reconnectB[1]?.type).toBe("snapshot");
    if (reconnectA[1]?.type !== "snapshot" || reconnectB[1]?.type !== "snapshot") {
      throw new Error("missing reconnect snapshot");
    }
    expect(reconnectA[1].snapshot.version).toBe(reconnectB[1].snapshot.version);
    expect(reconnectA[1].snapshot.durableExtensionState).toEqual(
      reconnectB[1].snapshot.durableExtensionState,
    );
  } finally {
    await remote.dispose();
  }
}, 15_000);

test("extension sync keeps ephemeral live-only and durable snapshot-backed", async () => {
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: TEST_ED25519_KEYS.publicKeyPem }],
  });

  try {
    const client = await createClient(remote.app);
    const created = await client.createSession({ persistence: "persistent" });

    const livePatchPromise = collectSyncEvents(
      client,
      created.sessionId,
      3,
      (event) => event.type === "patch",
    );
    await client.emitSessionCustomEvent(created.sessionId, {
      channel: "toast.state",
      data: { sync: "ephemeral", replaceKey: "toast", value: "hot" },
    });
    const livePatchEvents = await livePatchPromise;
    const livePatch = livePatchEvents.at(-1);
    expect(livePatch?.type).toBe("patch");

    await client.emitSessionCustomEvent(created.sessionId, {
      channel: "workspace.state",
      data: { sync: "durable", replaceKey: "workspace", value: { ready: true } },
    });

    const reconnectEvents = await collectSyncEvents(client, created.sessionId, 2);
    if (reconnectEvents[1]?.type !== "snapshot") {
      throw new Error("missing reconnect snapshot");
    }

    expect(reconnectEvents[1].snapshot.durableExtensionState).toContainEqual({
      channel: "workspace.state",
      data: { sync: "durable", replaceKey: "workspace", value: { ready: true } },
    });
    expect(reconnectEvents[1].snapshot.durableExtensionState).not.toContainEqual({
      channel: "toast.state",
      data: { sync: "ephemeral", replaceKey: "toast", value: "hot" },
    });
  } finally {
    await remote.dispose();
  }
}, 15_000);

test("restart recovery rebuilds interrupted runtime domains from durable state", async () => {
  const runtimeFactory = new BundledPiRuntimeFactory();
  const authSession = {
    token: "token",
    clientId: "client",
    keyId: "dev",
    expiresAt: Date.now() + 60_000,
  };

  const registry = new InspectableSessionRegistry({
    runtimeFactory,
    liveEvents: new SessionLiveEventBus(),
  });

  let sessionId = "";
  try {
    const created = await registry.createSession({ persistence: "persistent" }, authSession);
    sessionId = created.sessionId;
    const record = registry.readLoadedRecord(created.sessionId);
    if (!record) {
      throw new Error("missing loaded record");
    }

    record.queue.depth = 2;
    record.retry.status = "running";
    record.compaction.status = "running";
    record.streamingState = "streaming";
    record.isBashRunning = true;
    record.hasPendingBashMessages = true;
    record.lastDurableSessionVersion = 7;
    persistDurableRuntimeDomainState({ record, updatedAt: Date.now() });
    if (record.runtime.session !== undefined) {
      flushPersistedSessionManagerToDisk(record.runtime.session.sessionManager);
    }
    const sessionPath = record.runtime.session?.sessionManager.getSessionFile();
    const cwd = record.runtime.session?.sessionManager.getCwd();
    if (sessionPath === undefined || cwd === undefined) {
      throw new Error("missing persisted session path");
    }

    const loadedRuntime = await runtimeFactory.load?.({ sessionId, sessionPath, cwd });
    if (loadedRuntime === undefined) {
      throw new Error("runtime load unavailable");
    }

    const restoredRecord = createSessionRecord({
      sessionId,
      sessionName: record.sessionName,
      persistence: "persistent",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      runtime: loadedRuntime,
      readRuntimeExtensionMetadata: () => [],
    });
    restoreDurableRuntimeDomainState(restoredRecord, Date.now());
    const snapshot = registry.buildSnapshot(restoredRecord);
    expect(snapshot.interruptedRuntimeDomains).toEqual({
      queue: true,
      retry: true,
      compaction: true,
      bash: true,
      streaming: true,
    });
    expect(snapshot.streamingState).toBe("interrupted");
    expect(snapshot.retry.status).toBe("interrupted");
    expect(snapshot.compaction.status).toBe("interrupted");
    expect(snapshot.activeRun?.status).toBe("interrupted");
  } finally {
    await registry.dispose();
  }
});

test("pre-snapshot patch buffering stays bounded under high-volume replaceable updates", () => {
  const bufferedPatchEvents: Array<Awaited<ReturnType<typeof createReplaceablePatchEvent>>> = [];
  const bufferedPatchEventIndexesByKey = new Map<string, number>();

  for (let index = 0; index < 10_000; index += 1) {
    bufferPatchEvent(
      bufferedPatchEvents,
      bufferedPatchEventIndexesByKey,
      createReplaceablePatchEvent(index),
    );
  }

  expect(bufferedPatchEvents.length).toBe(1);
  expect(bufferedPatchEventIndexesByKey.size).toBe(1);
  expect(bufferedPatchEvents[0]?.patch.payload.data).toEqual({
    sync: "replaceable",
    replaceKey: "status",
    value: 9_999,
  });
});

test("sync payloads and snapshots expose no legacy stream offsets or envelopes", async () => {
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: TEST_ED25519_KEYS.publicKeyPem }],
  });

  try {
    const client = await createClient(remote.app);
    const created = await client.createSession({ persistence: "persistent" });

    const syncEvents = await collectSyncEvents(client, created.sessionId, 2);
    expect(syncEvents[1]?.type).toBe("snapshot");
    if (syncEvents[1]?.type !== "snapshot") {
      throw new Error("missing snapshot event");
    }

    const serializedSnapshot = JSON.stringify(syncEvents[1].snapshot);
    const serializedEvents = JSON.stringify(syncEvents);
    expect(serializedSnapshot).not.toContain("lastSessionStreamOffset");
    expect(serializedSnapshot).not.toContain("lastAppStreamOffset");
    expect(serializedEvents).not.toContain("streamOffset");
    expect(serializedEvents).not.toContain("eventId");
    for (const syncEvent of syncEvents) {
      expect(Object.prototype.hasOwnProperty.call(syncEvent, "kind")).toBe(false);
    }
  } finally {
    await remote.dispose();
  }
}, 15_000);

async function createClient(
  app: ReturnType<typeof createRemoteApp>["app"],
): Promise<RemoteApiClient> {
  const client = new RemoteApiClient({
    origin: "http://localhost:3000",
    auth: {
      keyId: "dev",
      privateKey: TEST_ED25519_KEYS.privateKeyPem,
    },
    fetchImpl: createInProcessFetch(app),
  });
  await client.authenticate();
  return client;
}

async function collectSyncEvents(
  client: RemoteApiClient,
  sessionId: string,
  minimumCount: number,
  stopWhen?: (event: SessionSyncEvent) => boolean,
) {
  const events: SessionSyncEvent[] = [];
  const controller = new AbortController();

  try {
    await client.readSessionSync(sessionId, {
      signal: controller.signal,
      onSyncEvent: (event) => {
        events.push(event);
        if (events.length >= minimumCount && (stopWhen === undefined || stopWhen(event))) {
          controller.abort();
        }
      },
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  }

  return events;
}

function createReplaceablePatchEvent(index: number) {
  return {
    type: "patch" as const,
    sessionId: "session-1",
    version: String(index + 1),
    patch: {
      patchType: "extension.custom" as const,
      payload: {
        channel: "status.channel",
        data: {
          sync: "replaceable" as const,
          replaceKey: "status",
          value: index,
        },
      },
    },
  };
}
