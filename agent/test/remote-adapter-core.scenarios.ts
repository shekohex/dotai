import {
  FakeRuntimeFactory,
  InMemoryPiRuntimeFactory,
  PassiveExtensionEventsPromptSession,
  RecordingRuntimeFactory,
  RecordingSession,
  RemoteAgentSessionRuntime,
  RuntimeExtensionEventsPromptSession,
  SessionManager,
  TEST_ED25519_KEYS,
  UiRequestPromptSession,
  authenticate,
  createInProcessFetch,
  createRemoteApp,
  createRemoteRuntime,
  dirname,
  expect,
  join,
  mkdir,
  mkdtemp,
  postSessionCommand,
  rm,
  test,
  timedTest,
  tmpdir,
  waitForSessionEvent,
  waitForValue,
  type ExtensionFactory,
} from "./remote-adapter.shared.ts";
import { initializeMirroredSessionManager } from "../src/remote/client/session-manager-mirror.ts";
import { readResourceLoaderEventBus } from "../src/remote/event-bus-bridge.ts";

class CustomExtensionEventsPromptSession extends RecordingSession {
  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    await super.prompt(text, options);
    readResourceLoaderEventBus(this.resourceLoader)?.emit("openusage:updated", {
      providerId: "codex",
      active: true,
      snapshot: {
        providerId: "codex",
        displayName: "Codex",
        source: "cliproxy",
        fetchedAt: 1_700_000_000_000,
        summary: "cliproxy account",
      },
    });
  }
}

class RefreshRequestRoundTripPromptSession extends RecordingSession {
  constructor() {
    super();
    readResourceLoaderEventBus(this.resourceLoader)?.on("openusage:refresh-requested", (data) => {
      const providerId =
        data !== null && typeof data === "object" && "providerId" in data
          ? String(data.providerId)
          : "codex";
      readResourceLoaderEventBus(this.resourceLoader)?.emit("openusage:updated", {
        providerId,
        active: providerId === "codex",
        snapshot: {
          providerId,
          displayName: providerId === "google" ? "Gemini" : "Codex",
          source: "cliproxy",
          fetchedAt: 1_700_000_000_001,
          summary: "refreshed from server",
        },
      });
    });
  }
}

timedTest("in-memory runtime load preserves source session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-load-session-dir-"));
  const workspaceDir = join(root, "workspace");
  const agentDir = join(root, "agent");
  const defaultSessionDir = join(root, "default-sessions");
  const sourceSessionDir = join(root, "source-sessions");

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const sourceManager = SessionManager.create(workspaceDir, sourceSessionDir);
  const sourceSessionPath = sourceManager.getSessionFile();
  expect(sourceSessionPath).toBeTruthy();

  const runtimeFactory = InMemoryPiRuntimeFactory({
    cwd: workspaceDir,
    agentDir,
    sessionDir: defaultSessionDir,
    persistSessions: true,
  });
  const runtime = await runtimeFactory.load?.({
    sessionId: sourceManager.getSessionId(),
    sessionPath: sourceSessionPath,
    cwd: workspaceDir,
  });

  expect(runtime).toBeTruthy();

  try {
    expect(runtime.session.sessionManager.getSessionDir()).toBe(sourceSessionDir);

    const next = await runtime.newSession();
    expect(next.cancelled).toBe(false);
    expect(runtime.session.sessionManager.getSessionDir()).toBe(sourceSessionDir);
    expect(dirname(runtime.session.sessionManager.getSessionFile() ?? "")).toBe(sourceSessionDir);
  } finally {
    await runtime.dispose();
    await runtimeFactory.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("milestone 3 remote runtime adapter replays snapshot and streams events", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory(),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionName: "milestone3" }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const beforePromptSnapshot = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(beforePromptSnapshot.status).toBe(200);
    const snapshot = (await beforePromptSnapshot.json()) as { lastSessionStreamOffset: string };

    const promptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/prompt`,
      token,
      {
        text: "hello from milestone 3",
      },
    );
    expect(promptResponse.status).toBe(202);

    await waitForSessionEvent(
      remote.app,
      token,
      created.sessionId,
      snapshot.lastSessionStreamOffset,
      (event) =>
        event.kind === "agent_session_event" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        (event.payload as { type?: string }).type === "agent_end",
    );

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    expect(
      runtime.session.messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { role?: string }).role === "assistant",
      ),
    ).toBe(true);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for remote adapter agent_end"));
      }, 5_000);

      const unsubscribe = runtime!.session.subscribe((event) => {
        if (event.type !== "agent_end") {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });

      void runtime!.session.prompt("second prompt through adapter");
    });
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter routes extension ui requests through ui-response", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new UiRequestPromptSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    let inputCalls = 0;
    await runtime.session.bindExtensions({
      uiContext: {
        input: async () => {
          inputCalls += 1;
          return "client-answer";
        },
      } as any,
    } as any);

    await runtime.session.prompt("prompt requiring ui response");

    await waitForValue(
      () => session.uiAnswers.length,
      (answerCount) => answerCount > 0,
      20,
      10,
    );

    expect(inputCalls).toBe(1);
    expect(session.uiAnswers.length).toBe(1);
    expect(session.uiAnswers[0]).toBe("client-answer");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter forwards turn_end to client extensions", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new InMemoryPiRuntimeFactory(),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  let turnEndCount = 0;
  const turnEndExtension: ExtensionFactory = (pi) => {
    pi.on("turn_end", () => {
      turnEndCount += 1;
    });
  };

  try {
    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      cwd: "/srv/turn-end-workspace",
      clientExtensionMetadata: [
        {
          id: "test-turn-end",
          runtime: "client",
          path: "client:test-turn-end",
        },
      ],
      clientExtensionFactories: [turnEndExtension],
    });

    await runtime.session.bindExtensions({});

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for agent_end while forwarding turn_end"));
      }, 5_000);

      const unsubscribe = runtime!.session.subscribe((event) => {
        if (event.type !== "agent_end") {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });

      void runtime!.session.prompt("forward turn end");
    });

    await waitForValue(
      () => turnEndCount,
      (count) => count > 0,
      20,
      10,
    );

    expect(turnEndCount).toBe(1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "milestone 3 adapter passes message_end object by reference to client extensions",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: InMemoryPiRuntimeFactory(),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
    const mutatingExtension: ExtensionFactory = (pi) => {
      pi.on("message_end", (event) => {
        const message = event.message as { role?: string; content?: unknown };
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
          return;
        }
        message.content.length = 0;
      });
    };

    try {
      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        cwd: "/srv/message-end-workspace",
        clientExtensionMetadata: [
          {
            id: "test-mutating-message-end",
            runtime: "client",
            path: "client:test-mutating-message-end",
          },
        ],
        clientExtensionFactories: [mutatingExtension],
      });

      await runtime.session.bindExtensions({});

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("Timed out waiting for agent_end in mutation pass-through test"));
        }, 5_000);

        const unsubscribe = runtime!.session.subscribe((event) => {
          if (event.type !== "agent_end") {
            return;
          }
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        });

        void runtime!.session.prompt("verify message mutation pass-through");
      });

      const assistant = [...runtime.session.messages]
        .toReversed()
        .find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { role?: string }).role === "assistant",
        ) as
        | {
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
          }
        | undefined;

      expect(assistant).toBeTruthy();
      expect(Array.isArray(assistant.content)).toBeTruthy();
      expect((assistant.content ?? []).length).toBe(0);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("milestone 3 adapter forwards queue, compaction, and retry events", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RuntimeExtensionEventsPromptSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  let queueUpdateCount = 0;
  let compactionStartCount = 0;
  let compactionEndCount = 0;
  let autoRetryStartCount = 0;
  let autoRetryEndCount = 0;

  const extension: ExtensionFactory = (pi) => {
    pi.on("queue_update", () => {
      queueUpdateCount += 1;
    });
    pi.on("compaction_start", () => {
      compactionStartCount += 1;
    });
    pi.on("compaction_end", () => {
      compactionEndCount += 1;
    });
    pi.on("auto_retry_start", () => {
      autoRetryStartCount += 1;
    });
    pi.on("auto_retry_end", () => {
      autoRetryEndCount += 1;
    });
  };

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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      clientExtensionMetadata: [
        {
          id: "test-runtime-events",
          runtime: "client",
          path: "client:test-runtime-events",
        },
      ],
      clientExtensionFactories: [extension],
    });

    await runtime.session.bindExtensions({});
    await runtime.session.prompt("trigger runtime extension events");

    await waitForValue(
      () => ({
        queueUpdateCount,
        compactionStartCount,
        compactionEndCount,
        autoRetryStartCount,
        autoRetryEndCount,
      }),
      (value) =>
        value.queueUpdateCount > 0 &&
        value.compactionStartCount > 0 &&
        value.compactionEndCount > 0 &&
        value.autoRetryStartCount > 0 &&
        value.autoRetryEndCount > 0,
      20,
      10,
    );

    expect(queueUpdateCount).toBe(1);
    expect(compactionStartCount).toBe(1);
    expect(compactionEndCount).toBe(1);
    expect(autoRetryStartCount).toBe(1);
    expect(autoRetryEndCount).toBe(1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter forwards passive extension events", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new PassiveExtensionEventsPromptSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  let modelSelectCount = 0;
  let sessionCompactCount = 0;
  let sessionTreeCount = 0;
  let modelSeenByExtension: string | undefined;

  const extension: ExtensionFactory = (pi) => {
    pi.on("model_select", (_event, ctx) => {
      modelSelectCount += 1;
      modelSeenByExtension = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    });
    pi.on("session_compact", () => {
      sessionCompactCount += 1;
    });
    pi.on("session_tree", () => {
      sessionTreeCount += 1;
    });
  };

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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      clientExtensionMetadata: [
        {
          id: "test-passive-events",
          runtime: "client",
          path: "client:test-passive-events",
        },
      ],
      clientExtensionFactories: [extension],
    });

    await runtime.session.bindExtensions({});
    await runtime.session.setModel({
      ...session.model,
      provider: "test-provider",
      id: "updated-model",
      name: "test-provider/updated-model",
    });
    await runtime.session.prompt("trigger passive extension events");

    await waitForValue(
      () => ({ modelSelectCount, sessionCompactCount, sessionTreeCount }),
      (value) =>
        value.modelSelectCount > 0 && value.sessionCompactCount > 0 && value.sessionTreeCount > 0,
      20,
      10,
    );

    expect(modelSelectCount).toBe(1);
    expect(modelSeenByExtension).toBe("test-provider/updated-model");
    expect(sessionCompactCount).toBe(1);
    expect(sessionTreeCount).toBe(1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter forwards custom extension bus events", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new CustomExtensionEventsPromptSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  let receivedCount = 0;
  let lastPayload: unknown;

  const extension: ExtensionFactory = (pi) => {
    pi.events.on("openusage:updated", (data) => {
      receivedCount += 1;
      lastPayload = data;
    });
  };

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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      clientExtensionMetadata: [
        {
          id: "test-custom-events",
          runtime: "client",
          path: "client:test-custom-events",
        },
      ],
      clientExtensionFactories: [extension],
    });

    await runtime.session.bindExtensions({});
    await runtime.session.prompt("trigger custom extension events");

    await waitForValue(
      () => ({ receivedCount, lastPayload }),
      (value) => value.receivedCount > 0,
      20,
      10,
    );

    expect(receivedCount).toBe(1);
    expect(lastPayload).toEqual({
      providerId: "codex",
      active: true,
      snapshot: {
        providerId: "codex",
        displayName: "Codex",
        source: "cliproxy",
        fetchedAt: 1_700_000_000_000,
        summary: "cliproxy account",
      },
    });
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter forwards client custom bus events to server and back", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RefreshRequestRoundTripPromptSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  let receivedCount = 0;
  let lastPayload: unknown;

  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", () => {
      pi.events.emit("openusage:refresh-requested", {
        providerId: "google",
        force: true,
      });
    });
    pi.events.on("openusage:updated", (data) => {
      receivedCount += 1;
      lastPayload = data;
    });
  };

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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      clientExtensionMetadata: [
        {
          id: "test-custom-event-roundtrip",
          runtime: "client",
          path: "client:test-custom-event-roundtrip",
        },
      ],
      clientExtensionFactories: [extension],
    });

    await runtime.session.bindExtensions({});

    await waitForValue(
      () => ({ receivedCount, lastPayload }),
      (value) => value.receivedCount > 0,
      20,
      10,
    );

    expect(lastPayload).toEqual({
      providerId: "google",
      active: false,
      snapshot: {
        providerId: "google",
        displayName: "Gemini",
        source: "cliproxy",
        fetchedAt: 1_700_000_000_001,
        summary: "refreshed from server",
      },
    });
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote tree navigation uses authoritative server entry ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-tree-nav-"));
  const workspaceDir = join(root, "workspace");

  await mkdir(workspaceDir, { recursive: true });

  const sourceManager = SessionManager.inMemory(workspaceDir);
  sourceManager.appendMessage({ role: "user", content: "first message" });
  sourceManager.appendMessage({ role: "user", content: "second message" });

  try {
    const authoritativeEntries = sourceManager.getEntries();
    const authoritativeUserEntryId = authoritativeEntries.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    )?.id;

    expect(authoritativeUserEntryId).toBeTruthy();

    const legacyMirroredManager = SessionManager.inMemory(workspaceDir);
    legacyMirroredManager.newSession({ id: sourceManager.getSessionId() });
    legacyMirroredManager.appendSessionInfo(sourceManager.getSessionName() ?? "");
    for (const entry of authoritativeEntries) {
      if (entry.type === "message") {
        legacyMirroredManager.appendMessage(entry.message);
      }
    }

    const legacyMirroredUserEntryId = legacyMirroredManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;

    expect(legacyMirroredUserEntryId).toBeTruthy();
    expect(legacyMirroredUserEntryId).not.toBe(authoritativeUserEntryId);

    const mirroredManager = SessionManager.inMemory(workspaceDir);
    initializeMirroredSessionManager({
      sessionManager: mirroredManager,
      sessionId: sourceManager.getSessionId(),
      sessionName: sourceManager.getSessionName() ?? "",
      entries: authoritativeEntries,
      leafId: sourceManager.getLeafId(),
    });

    const mirroredUserEntryId = mirroredManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;

    expect(mirroredUserEntryId).toBe(authoritativeUserEntryId);
    expect(mirroredManager.getLeafId()).toBe(sourceManager.getLeafId());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

timedTest(
  "milestone 3 adapter rolls back optimistic thinkingLevel on rejected update",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    const session = new RecordingSession();

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new RecordingRuntimeFactory(session),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
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
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      const inProcessFetch = createInProcessFetch(remote.app);
      runtime = await RemoteAgentSessionRuntime.create({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        sessionId: created.sessionId,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.includes("/model") && init?.method === "POST") {
            return new Response(JSON.stringify({ message: "simulated transport failure" }), {
              status: 500,
              headers: {
                "content-type": "application/json",
              },
            });
          }
          return inProcessFetch(input, init);
        },
      });

      runtime.session.setThinkingLevel("high");

      await waitForValue(
        () => runtime.session.state.errorMessage,
        (errorMessage) => typeof errorMessage === "string" && errorMessage.length > 0,
        20,
        10,
      );

      expect(runtime.session.thinkingLevel).toBe("medium");
      expect(runtime.session.state.errorMessage ?? "").toMatch(/Failed to update thinking level/);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("milestone 3 adapter surfaces extension_error stream events", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  session.promptError = new Error("simulated runtime prompt failure");

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    await runtime.session.prompt("trigger runtime failure");

    await waitForValue(
      () => runtime.session.state.errorMessage,
      (errorMessage) => typeof errorMessage === "string" && errorMessage.length > 0,
      20,
      10,
    );

    expect(runtime.session.state.errorMessage ?? "").toMatch(/simulated runtime prompt failure/);
    expect(
      runtime.session.messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { customType?: string }).customType === "remote_error",
      ),
    ).toBe(true);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter clearQueue clears authoritative remote queue", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    await postSessionCommand(remote.app, `/v1/sessions/${created.sessionId}/steer`, token, {
      text: "queued steer",
    });
    await postSessionCommand(remote.app, `/v1/sessions/${created.sessionId}/follow-up`, token, {
      text: "queued follow-up",
    });

    await waitForValue(
      () => ({
        queuedSteeringLength: session.queuedSteering.length,
        queuedFollowUpLength: session.queuedFollowUp.length,
      }),
      (value) => value.queuedSteeringLength > 0 && value.queuedFollowUpLength > 0,
      20,
      10,
    );

    expect(session.queuedSteering.length).toBe(1);
    expect(session.queuedFollowUp.length).toBe(1);

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    runtime.session.clearQueue();

    await waitForValue(
      () => session.clearQueueCalls,
      (clearQueueCalls) => clearQueueCalls > 0,
      20,
      10,
    );

    expect(session.clearQueueCalls).toBe(1);
    expect(session.queuedSteering).toEqual([]);
    expect(session.queuedFollowUp).toEqual([]);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter does not double-append user/custom messages", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const sessionAny = runtime.session as any;
    const baseline = runtime.session.messages.length;
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    };
    sessionAny.applyAgentSessionEvent({ type: "message_start", message: userMessage });
    sessionAny.applyAgentSessionEvent({ type: "message_end", message: userMessage });

    const customMessage = {
      role: "custom",
      customType: "remote_error",
      content: "err",
      display: true,
      timestamp: Date.now(),
    };
    sessionAny.applyAgentSessionEvent({ type: "message_start", message: customMessage });
    sessionAny.applyAgentSessionEvent({ type: "message_end", message: customMessage });

    expect(runtime.session.messages.length).toBe(baseline + 2);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "milestone 3 adapter emits session listeners synchronously without backlog queue",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new FakeRuntimeFactory(),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
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
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        sessionId: created.sessionId,
      });

      const observed: string[] = [];
      runtime.session.subscribe((event) => {
        observed.push(event.type);
      });

      const sessionAny = runtime.session as any;
      sessionAny.applyAgentSessionEvent({
        type: "message_start",
        message: assistantMessageWithText("a"),
      });

      expect(observed).toEqual(["message_start"]);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest(
  "milestone 3 adapter coalesces pending assistant message_update events for local extensions",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    let releaseFirstUpdate: (() => void) | undefined;
    const seenTexts: string[] = [];

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new FakeRuntimeFactory(),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
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
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        sessionId: created.sessionId,
      });

      await runtime.session.bindExtensions({});

      const sessionAny = runtime.session as any;
      const originalEmit = sessionAny.localExtensionRunner.emit.bind(
        sessionAny.localExtensionRunner,
      );
      let firstUpdate = true;
      sessionAny.localExtensionRunner.emit = async (event: {
        type: string;
        message?: { content?: Array<{ type: string; text?: string }> };
      }) => {
        if (event.type === "message_update") {
          const text = (event.message?.content ?? [])
            .filter((content) => content.type === "text")
            .map((content) => content.text ?? "")
            .join("");
          seenTexts.push(text);
          if (firstUpdate) {
            firstUpdate = false;
            await new Promise<void>((resolve) => {
              releaseFirstUpdate = resolve;
            });
          }
        }
        return originalEmit(event);
      };

      sessionAny.applyAgentSessionEvent({
        type: "message_start",
        message: assistantMessageWithText("a"),
      });
      sessionAny.applyAgentSessionEvent({
        type: "message_update",
        message: assistantMessageWithText("ab"),
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "b",
          partial: { type: "text", text: "ab" },
        },
      });

      await waitForValue(
        () => seenTexts.length,
        (value) => value === 1,
      );

      sessionAny.applyAgentSessionEvent({
        type: "message_update",
        message: assistantMessageWithText("abc"),
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "c",
          partial: { type: "text", text: "abc" },
        },
      });
      sessionAny.applyAgentSessionEvent({
        type: "message_update",
        message: assistantMessageWithText("abcd"),
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "d",
          partial: { type: "text", text: "abcd" },
        },
      });

      releaseFirstUpdate?.();

      await waitForValue(
        () => seenTexts.length,
        (value) => value === 2,
      );
      expect(seenTexts).toEqual(["ab", "abcd"]);
    } finally {
      releaseFirstUpdate?.();
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest(
  "milestone 3 adapter preserves message_update before message_end for local extensions",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    let releaseFirstUpdate: (() => void) | undefined;
    const seenEvents: string[] = [];

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new FakeRuntimeFactory(),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
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
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        sessionId: created.sessionId,
      });

      await runtime.session.bindExtensions({});

      const sessionAny = runtime.session as any;
      const originalEmit = sessionAny.localExtensionRunner.emit.bind(
        sessionAny.localExtensionRunner,
      );
      let firstUpdate = true;
      sessionAny.localExtensionRunner.emit = async (event: {
        type: string;
        message?: { content?: Array<{ type: string; text?: string }> };
      }) => {
        if (event.type === "message_update") {
          const text = (event.message?.content ?? [])
            .filter((content) => content.type === "text")
            .map((content) => content.text ?? "")
            .join("");
          seenEvents.push(`update:${text}`);
          if (firstUpdate) {
            firstUpdate = false;
            await new Promise<void>((resolve) => {
              releaseFirstUpdate = resolve;
            });
          }
        }
        if (event.type === "message_end") {
          const text = (event.message?.content ?? [])
            .filter((content) => content.type === "text")
            .map((content) => content.text ?? "")
            .join("");
          seenEvents.push(`end:${text}`);
        }
        return originalEmit(event);
      };

      sessionAny.applyAgentSessionEvent({
        type: "message_start",
        message: assistantMessageWithText("a"),
      });
      sessionAny.applyAgentSessionEvent({
        type: "message_update",
        message: assistantMessageWithText("ab"),
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "b",
          partial: { type: "text", text: "ab" },
        },
      });

      await waitForValue(
        () => seenEvents.length,
        (value) => value === 1,
      );

      sessionAny.applyAgentSessionEvent({
        type: "message_update",
        message: assistantMessageWithText("abcd"),
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "cd",
          partial: { type: "text", text: "abcd" },
        },
      });
      sessionAny.applyAgentSessionEvent({
        type: "message_end",
        message: assistantMessageWithText("abcd"),
      });

      releaseFirstUpdate?.();

      await waitForValue(
        () => seenEvents.length,
        (value) => value === 3,
      );
      expect(seenEvents).toEqual(["update:ab", "update:abcd", "end:abcd"]);
    } finally {
      releaseFirstUpdate?.();
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest(
  "milestone 3 adapter coalesces pending tool_execution_update events per tool call",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    let releaseFirstUpdate: (() => void) | undefined;
    const seenUpdates: string[] = [];

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new FakeRuntimeFactory(),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
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
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        sessionId: created.sessionId,
      });

      await runtime.session.bindExtensions({});

      const sessionAny = runtime.session as any;
      const originalEmit = sessionAny.localExtensionRunner.emit.bind(
        sessionAny.localExtensionRunner,
      );
      let firstUpdate = true;
      sessionAny.localExtensionRunner.emit = async (event: {
        type: string;
        toolCallId?: string;
        partialResult?: { content?: Array<{ type: string; text?: string }> };
      }) => {
        if (event.type === "tool_execution_update") {
          const text = (event.partialResult?.content ?? [])
            .filter((content) => content.type === "text")
            .map((content) => content.text ?? "")
            .join("");
          seenUpdates.push(`${event.toolCallId}:${text}`);
          if (firstUpdate) {
            firstUpdate = false;
            await new Promise<void>((resolve) => {
              releaseFirstUpdate = resolve;
            });
          }
        }
        return originalEmit(event);
      };

      sessionAny.applyAgentSessionEvent({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "read",
        args: {},
        partialResult: {
          content: [{ type: "text", text: "a" }],
        },
      });

      await waitForValue(
        () => seenUpdates.length,
        (value) => value === 1,
      );

      sessionAny.applyAgentSessionEvent({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "read",
        args: {},
        partialResult: {
          content: [{ type: "text", text: "ab" }],
        },
      });
      sessionAny.applyAgentSessionEvent({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "read",
        args: {},
        partialResult: {
          content: [{ type: "text", text: "abc" }],
        },
      });

      releaseFirstUpdate?.();

      await waitForValue(
        () => seenUpdates.length,
        (value) => value === 2,
      );
      expect(seenUpdates).toEqual(["call-1:a", "call-1:abc"]);
    } finally {
      releaseFirstUpdate?.();
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("milestone 3 adapter sendCustomMessage appends custom messages", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const baseline = runtime.session.messages.length;
    await runtime.session.sendCustomMessage({
      customType: "pi-mermaid",
      content: "graph TD;A-->B",
      display: true,
    });

    expect(runtime.session.messages.length).toBe(baseline + 1);
    const appended = runtime.session.messages.at(-1);
    expect(appended?.role).toBe("custom");
    if (appended?.role === "custom") {
      expect(appended.customType).toBe("pi-mermaid");
    }
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

function assistantMessageWithText(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    api: "responses",
    provider: "pi-remote-faux",
    model: "pi-remote-faux-1",
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}
