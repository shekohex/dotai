import {
  BlockingPromptSession,
  FakeRuntimeFactory,
  InMemoryDurableStreamStore,
  RacyPromptSession,
  RecordingRuntimeFactory,
  RecordingSession,
  RemoteAgentSessionRuntime,
  RemoteApiClient,
  SessionCatalog,
  SessionRegistry,
  assertType,
  authenticate,
  cancelRemoteUiRequest,
  createRemoteApp,
  createRemoteRuntime,
  createRemoteUiContext,
  expect,
  handleRemoteUiRequest,
  hasSessionPrimitiveCapability,
  join,
  mkdir,
  mkdtemp,
  rm,
  sessionEventsStreamId,
  testAuthSession,
  TEST_ED25519_KEYS,
  timedTest,
  tmpdir,
  writeFile,
  type ClientCapabilities,
  type ExtensionUIContext,
  type Presence,
} from "./remote-command-surface.shared.ts";

timedTest("session primitive capability requires advertised support", () => {
  const falseCapabilities: ClientCapabilities = {
    protocolVersion: "1.0",
    primitives: {
      select: false,
      confirm: false,
      input: false,
      editor: false,
      custom: false,
      setWidget: false,
      setHeader: false,
      setFooter: false,
      setEditorComponent: false,
      onTerminalInput: false,
    },
  };
  const trueCapabilities: ClientCapabilities = {
    ...falseCapabilities,
    primitives: {
      ...falseCapabilities.primitives,
      select: true,
    },
  };

  const noPresence = new Map<string, Presence>();
  expect(hasSessionPrimitiveCapability(noPresence, "select")).toBe(false);

  const falseOnlyPresence = new Map<string, Presence>([
    [
      "a",
      {
        clientId: "client-a",
        connectionId: "connection-a",
        connectedAt: 1,
        lastSeenAt: 1,
        clientCapabilities: falseCapabilities,
        lastSeenSessionOffset: "0000000000000000_0000000000000000",
        lastSeenAppOffset: "0000000000000000_0000000000000000",
      },
    ],
  ]);
  expect(hasSessionPrimitiveCapability(falseOnlyPresence, "select")).toBe(false);

  const mixedPresence = new Map<string, Presence>([
    ...falseOnlyPresence,
    [
      "b",
      {
        clientId: "client-b",
        connectionId: "connection-b",
        connectedAt: 1,
        lastSeenAt: 1,
        clientCapabilities: trueCapabilities,
        lastSeenSessionOffset: "0000000000000000_0000000000000000",
        lastSeenAppOffset: "0000000000000000_0000000000000000",
      },
    ],
  ]);
  expect(hasSessionPrimitiveCapability(mixedPresence, "select")).toBe(true);
});

timedTest("authoritative cwd update refreshes local extension runner context", async () => {
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
    const beforeRunner = sessionAny.localExtensionRunner;
    expect(beforeRunner).toBeTruthy();
    const beforeContext = beforeRunner.createCommandContext();
    const nextCwd = `${beforeContext.cwd}-updated`;

    sessionAny.applyAuthoritativeCwdUpdate(nextCwd);

    const afterRunner = sessionAny.localExtensionRunner;
    expect(afterRunner).toBeTruthy();
    expect(afterRunner).not.toBe(beforeRunner);
    const afterContext = afterRunner.createCommandContext();
    expect(afterContext.cwd).toBe(nextCwd);
    expect(afterContext.sessionManager.getCwd()).toBe(nextCwd);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote server ui getEditorText returns empty string fallback", () => {
  const uiContext = createRemoteUiContext({
    record: {
      presence: new Map(),
    } as any,
    now: () => Date.now(),
    publishUiEvent: () => {},
  });

  expect(uiContext.getEditorText()).toBe("");
});

timedTest("remote server ui addAutocompleteProvider fails loudly", () => {
  const uiContext = createRemoteUiContext({
    record: {
      presence: new Map(),
      uiState: {
        statuses: new Map(),
        widgets: new Map(),
        workingMessage: undefined,
        hiddenThinkingLabel: undefined,
        title: undefined,
        toolsExpanded: undefined,
        editorText: undefined,
      },
    } as any,
    now: () => Date.now(),
    publishUiEvent: () => {},
  });

  expect(() => {
    uiContext.addAutocompleteProvider((current) => current);
  }).toThrow(/addAutocompleteProvider\(\) is not supported/);
});

timedTest("remote server ui coalesces identical stateful ui writes", () => {
  const published: Array<{ method: string; statusText?: string; widgetKey?: string }> = [];
  const uiContext = createRemoteUiContext({
    record: {
      presence: new Map(),
      uiState: {
        statuses: new Map(),
        widgets: new Map(),
        workingMessage: undefined,
        hiddenThinkingLabel: undefined,
        title: undefined,
        toolsExpanded: undefined,
        editorText: undefined,
      },
    } as any,
    now: () => Date.now(),
    publishUiEvent: (_record, payload) => {
      published.push(payload as { method: string; statusText?: string; widgetKey?: string });
    },
  });

  uiContext.setStatus("openusage", "same");
  uiContext.setStatus("openusage", "same");
  uiContext.setWidget("review", ["same"]);
  uiContext.setWidget("review", ["same"]);
  uiContext.setEditorText("draft");
  uiContext.setEditorText("draft");

  expect(published.map((payload) => payload.method)).toEqual([
    "setStatus",
    "setWidget",
    "set_editor_text",
  ]);
});

timedTest("editor ui request ignores late response after remote cancellation", async () => {
  const pendingInteractiveRequests = new Map<string, AbortController>();
  const postedResponses: Array<unknown> = [];
  let resolveEditor: ((value: string | undefined) => void) | undefined;
  const editorResult = new Promise<string | undefined>((resolve) => {
    resolveEditor = resolve;
  });

  const uiContext = {
    editor: async () => editorResult,
  } as unknown as ExtensionUIContext;
  const client = {
    postUiResponse: async (_sessionId: string, response: unknown) => {
      postedResponses.push(response);
    },
  } as unknown as RemoteApiClient;

  const requestTask = handleRemoteUiRequest({
    uiContext,
    request: {
      id: "editor-request-1",
      method: "editor",
      title: "Edit",
      prefill: "abc",
    },
    client,
    sessionId: "session-1",
    pendingInteractiveRequests,
  });

  cancelRemoteUiRequest(pendingInteractiveRequests, "editor-request-1");
  resolveEditor?.("late-value");
  await requestTask;

  expect(postedResponses).toEqual([]);
  expect(pendingInteractiveRequests.size).toBe(0);
});

timedTest("presence tracks concurrent connections for the same token", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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

    const streamA = await remote.app.request(`/v1/sessions/${created.sessionId}/sync`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-pi-connection-id": "conn-a",
      },
    });
    expect(streamA.status).toBe(200);

    const streamB = await remote.app.request(`/v1/sessions/${created.sessionId}/sync`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-pi-connection-id": "conn-b",
      },
    });
    expect(streamB.status).toBe(200);

    const snapshot = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-pi-connection-id": "conn-a",
      },
    });

    expect(snapshot.status).toBe(200);
    const body = (await snapshot.json()) as {
      presence: Array<{ clientId: string; connectionId: string }>;
    };
    expect(body.presence.length).toBe(2);
    const connectionIds = body.presence.map((presence) => presence.connectionId).toSorted();
    expect(connectionIds).toEqual(["conn-a", "conn-b"]);
    expect(body.presence[0]?.clientId).toBe("dev");
    expect(body.presence[1]?.clientId).toBe("dev");
  } finally {
    await remote.dispose();
  }
});

timedTest("presence does not grow when connection header is omitted", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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
    expect(snapshotA.status).toBe(200);

    const snapshotB = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    expect(snapshotB.status).toBe(200);

    const body = (await snapshotB.json()) as {
      presence: Array<{ connectionId: string }>;
    };
    expect(body.presence.length).toBe(1);
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
    expect(activeSnapshot.presence.length).toBe(2);

    now = 100;
    const prunedSnapshot = registry.getSessionSnapshot(created.sessionId, authSession, "conn-c");
    expect(prunedSnapshot.presence.length).toBe(1);
    expect(prunedSnapshot.presence[0]?.connectionId).toBe("conn-c");

    registry.touchPresence(created.sessionId, authSession, "conn-d");
    registry.detachPresence(created.sessionId, "conn-d");
    const detachedSnapshot = registry.getSessionSnapshot(created.sessionId, authSession, "conn-c");
    expect(detachedSnapshot.presence.length).toBe(1);
    expect(detachedSnapshot.presence[0]?.connectionId).toBe("conn-c");
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
  const registryAny = registry as any;
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
    expect(accepted.sequence).toBe(1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    const firstSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    expect(firstSnapshot.status).toBe("error");
    expect(firstSnapshot.errorMessage).toBe("missing API key");

    const secondSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    expect(secondSnapshot.status).toBe("error");
    expect(secondSnapshot.errorMessage).toBe("missing API key");
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
    expect(polledSnapshot.updatedAt).toBe(initialUpdatedAt);

    const summariesA = registry.listSessionSummaries();
    const summariesB = registry.listSessionSummaries();
    expect(summariesA[0]?.updatedAt).toBe(initialUpdatedAt);
    expect(summariesB[0]?.updatedAt).toBe(initialUpdatedAt);
  } finally {
    await registry.dispose();
  }
});

timedTest("failed model update does not emit command_accepted or consume sequence", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.modelRegistry = {
    find: () => ({ provider: "openai", id: "gpt-4o" }),
    getAvailable: () => [session.model],
  };
  session.setModelError = new Error("No API key for openai/gpt-4o");
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const registryAny = registry as any;
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const beforeOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    await expect(
      registry.updateModel(
        created.sessionId,
        {
          model: "openai/gpt-4o",
        },
        auth,
        "conn-a",
      ),
    ).rejects.toThrow(/No API key for openai\/gpt-4o/);

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    expect(snapshot.queue.nextSequence).toBe(1);
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
  const registryAny = registry as any;
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const beforeOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    await expect(
      registry.updateModel(
        created.sessionId,
        {
          model: "pi-remote-faux/pi-remote-faux-1",
          thinkingLevel: "ultra",
        },
        auth,
        "conn-a",
      ),
    ).rejects.toThrow(/Invalid thinkingLevel/);

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    expect(snapshot.queue.nextSequence).toBe(1);
    expect(snapshot.thinkingLevel).toBe("medium");
  } finally {
    await registry.dispose();
  }
});

timedTest("prompt preflight rejects missing auth before command acceptance", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.modelRegistry = {
    find: () => session.model,
    getAvailable: () => [session.model],
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

    await expect(
      registry.prompt(
        created.sessionId,
        {
          text: "prompt",
        },
        auth,
        "conn-a",
      ),
    ).rejects.toThrow(/No API key found for pi-remote-faux/);

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    expect(snapshot.queue.nextSequence).toBe(1);
    expect(session.promptCalls.length).toBe(0);
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
    getAvailable: () => [session.model],
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

    expect(accepted.sequence).toBe(1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(session.promptCalls.length).toBe(1);
    expect(session.promptCalls[0]?.text).toBe("queued while streaming");
    expect(session.promptCalls[0]?.options?.streamingBehavior).toBe("followUp");
  } finally {
    await registry.dispose();
  }
});

timedTest("registered slash commands bypass prompt preflight", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.modelRegistry = {
    find: () => session.model,
    getAvailable: () => [session.model],
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

    expect(accepted.sequence).toBe(1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(session.promptCalls.length).toBe(1);
    expect(session.promptCalls[0]?.text).toBe("/login openai");
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

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(session.promptCalls.length).toBe(2);
    expect(session.promptCalls[0]?.text).toBe("first");
    expect(session.promptCalls[1]?.text).toBe("second");
    expect(session.promptCalls[1]?.options?.streamingBehavior).toBe("followUp");
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
    expect(promptAccepted.sequence).toBe(1);

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "queued steer",
      },
      auth,
      "conn-a",
    );
    expect(steerAccepted.sequence).toBe(2);

    const interruptAccepted = await registry.interrupt(created.sessionId, {}, auth, "conn-a");
    expect(interruptAccepted.sequence).toBe(3);

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(session.steerCalls.length).toBe(0);
    expect(session.abortCalls).toBe(0);

    session.releasePrompt();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(session.steerCalls.length).toBe(1);
    expect(session.abortCalls).toBe(1);
    expect(session.dispatchOrder).toEqual(["prompt", "steer", "interrupt"]);
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
    expect(promptAccepted.sequence).toBe(1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "queued steer",
      },
      auth,
      "conn-a",
    );
    expect(steerAccepted.sequence).toBe(2);

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    const headOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    expect(Number(snapshot.version)).toBeGreaterThan(0);
    expect(snapshot.queue.depth >= 1).toBeTruthy();
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
    expect(steerAccepted.sequence).toBe(1);

    const followUpAccepted = await registry.followUp(
      created.sessionId,
      {
        text: "queued follow-up",
      },
      auth,
      "conn-a",
    );
    expect(followUpAccepted.sequence).toBe(2);

    const interruptAccepted = await registry.interrupt(created.sessionId, {}, auth, "conn-a");
    expect(interruptAccepted.sequence).toBe(3);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(session.clearQueueCalls).toBe(1);
    expect(session.queuedSteering).toEqual([]);
    expect(session.queuedFollowUp).toEqual([]);
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
    expect(promptAccepted.sequence).toBe(1);

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "steer",
        attachments,
      },
      auth,
      "conn-a",
    );
    expect(steerAccepted.sequence).toBe(2);

    const followUpAccepted = await registry.followUp(
      created.sessionId,
      {
        text: "follow-up",
        attachments,
      },
      auth,
      "conn-a",
    );
    expect(followUpAccepted.sequence).toBe(3);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(session.promptCalls.length).toBe(1);
    expect(session.steerCalls.length).toBe(1);
    expect(session.followUpCalls.length).toBe(1);

    expect(session.promptCalls[0]?.options?.images).toEqual([
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
    expect(session.steerCalls[0]?.images).toEqual([
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
    expect(session.followUpCalls[0]?.images).toEqual([
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
    await expect(registry.createSession({}, auth, "conn-a")).rejects.toThrow(/bind failed/);
    expect(runtimeFactory.runtimeDisposeCalls).toBe(1);

    const snapshot = registry.getAppSnapshot(auth);
    expect(snapshot.sessionSummaries.length).toBe(0);
  } finally {
    await registry.dispose();
  }
});

timedTest("lazy-loaded session disposes runtime when initialization fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-lazy-load-failure-"));
  const catalogDir = join(root, "catalog");
  const workspaceDir = join(root, "workspace");
  const sessionId = "lazy-load-bind-failure";
  const sessionPath = join(catalogDir, "session.jsonl");

  await mkdir(catalogDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: workspaceDir,
    })}\n`,
  );

  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.bindExtensionsError = new Error("bind failed");
  session.sessionStats = {
    ...session.sessionStats,
    sessionId,
    sessionFile: sessionPath,
  };
  session.sessionManager = {
    getCwd: () => workspaceDir,
    getSessionId: () => sessionId,
    isPersisted: () => true,
    getSessionFile: () => sessionPath,
    getSessionDir: () => catalogDir,
  };

  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
    catalog: new SessionCatalog({ rootDir: catalogDir }),
  });
  const auth = testAuthSession();

  try {
    const firstSnapshot = await registry.loadSessionSnapshot(sessionId, auth, "conn-a");
    const secondSnapshot = await registry.loadSessionSnapshot(sessionId, auth, "conn-a");

    expect(firstSnapshot.sessionId).toBe(sessionId);
    expect(secondSnapshot.sessionId).toBe(sessionId);
    expect(runtimeFactory.loadCalls).toBe(0);
    expect(runtimeFactory.runtimeDisposeCalls).toBe(0);

    const summary = registry.getSessionSummary(sessionId);
    expect(summary.lifecycle.loaded).toBe(false);
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
