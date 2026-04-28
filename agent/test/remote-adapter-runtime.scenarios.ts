import {
  FakeRuntimeFactory,
  InMemoryPiRuntimeFactory,
  RecordingRuntimeFactory,
  RecordingSession,
  RemoteAgentSessionRuntime,
  SequencedRecordingRuntimeFactory,
  TEST_ED25519_KEYS,
  UiPrimitivesPromptSession,
  authenticate,
  createInProcessFetch,
  createRemoteApp,
  createRemoteRuntime,
  expect,
  postSessionCommand,
  readSessionEvents,
  timedTest,
  waitForSessionEvent,
  waitForValue,
  type ExtensionFactory,
} from "./remote-adapter.shared.ts";

timedTest("milestone 3.1 snapshot includes model catalog and remote model settings", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      model: string;
      availableModels: Array<{ provider: string; id: string }>;
      modelSettings: {
        defaultProvider: string | null;
        defaultModel: string | null;
        defaultThinkingLevel: string | null;
        enabledModels: string[] | null;
      };
    };

    expect(snapshot.availableModels.length > 0).toBeTruthy();
    expect(
      snapshot.availableModels.some(
        (model) => model.provider === "pi-remote-faux" && model.id === "pi-remote-faux-1",
      ),
    ).toBe(true);
    expect(snapshot.modelSettings.defaultProvider).toBe(null);
    expect(snapshot.modelSettings.defaultModel).toBe(null);
    expect(snapshot.modelSettings.defaultThinkingLevel).toBe(null);
    expect(snapshot.modelSettings.enabledModels).toBe(null);

    const updateResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/model`,
      token,
      {
        model: snapshot.model,
        thinkingLevel: "high",
      },
    );
    expect(updateResponse.status).toBe(202);

    const updatedSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(updatedSnapshotResponse.status).toBe(200);
    const updatedSnapshot = (await updatedSnapshotResponse.json()) as {
      model: string;
      modelSettings: {
        defaultProvider: string | null;
        defaultModel: string | null;
        defaultThinkingLevel: string | null;
      };
    };

    expect(updatedSnapshot.modelSettings.defaultProvider).toBe("pi-remote-faux");
    expect(updatedSnapshot.modelSettings.defaultModel).toBe("pi-remote-faux-1");
    expect(updatedSnapshot.modelSettings.defaultThinkingLevel).toBe("high");
  } finally {
    await remote.dispose();
  }
});

timedTest("milestone 3.1 adapter hydrates catalog and syncs remote model settings", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  session.model = {
    ...session.model,
    reasoning: false,
    contextWindow: 4_096,
    maxTokens: 1_024,
  };
  session.defaultProvider = "pi-remote-faux";
  session.defaultModel = "pi-remote-faux-1";
  session.defaultThinkingLevel = "off";
  session.enabledModels = ["pi-remote-faux/*"];

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

    const availableModels = runtime.session.modelRegistry.getAvailable();
    expect(availableModels.length).toBe(1);
    expect(availableModels[0]?.provider).toBe("pi-remote-faux");
    expect(availableModels[0]?.id).toBe("pi-remote-faux-1");
    expect(runtime.session.model?.reasoning).toBe(false);
    expect(runtime.session.state.model?.provider).toBe("pi-remote-faux");
    expect(runtime.session.state.model?.id).toBe("pi-remote-faux-1");
    expect(runtime.session.state.thinkingLevel).toBe(runtime.session.thinkingLevel);
    expect(runtime.session.getAvailableThinkingLevels()).toEqual(["off"]);
    expect(runtime.session.supportsThinking()).toBe(false);
    expect(runtime.session.settingsManager.getDefaultProvider()).toBe("pi-remote-faux");
    expect(runtime.session.settingsManager.getDefaultModel()).toBe("pi-remote-faux-1");
    expect(runtime.session.settingsManager.getDefaultThinkingLevel()).toBe("off");
    expect(runtime.session.settingsManager.getEnabledModels()).toEqual(["pi-remote-faux/*"]);

    const updateResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/model`,
      token,
      {
        model: "pi-remote-faux/pi-remote-faux-1",
        thinkingLevel: "high",
      },
    );
    expect(updateResponse.status).toBe(202);

    await waitForValue(
      () => runtime.session.settingsManager.getDefaultThinkingLevel(),
      (thinkingLevel) => thinkingLevel === "high",
      20,
      10,
    );

    expect(runtime.session.settingsManager.getDefaultThinkingLevel()).toBe("high");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote settings manager changes sync across sessions", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const sharedSettingsStore = {
    global: {} as Record<string, unknown>,
    project: {} as Record<string, unknown>,
  };
  const sessionA = new RecordingSession();
  const sessionB = new RecordingSession();
  sessionA.settingsStore = sharedSettingsStore;
  sessionB.settingsStore = sharedSettingsStore;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new SequencedRecordingRuntimeFactory([sessionA, sessionB]),
  });

  let runtimeA: RemoteAgentSessionRuntime | undefined;
  let runtimeB: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponseA = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const createResponseB = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(createResponseA.status).toBe(201);
    expect(createResponseB.status).toBe(201);

    const createdA = (await createResponseA.json()) as { sessionId: string };
    const createdB = (await createResponseB.json()) as { sessionId: string };

    runtimeA = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdA.sessionId,
    });
    runtimeB = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdB.sessionId,
    });

    const beforeSnapshotResponse = await remote.app.request(
      `/v1/sessions/${createdB.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(beforeSnapshotResponse.status).toBe(200);
    const beforeSnapshot = (await beforeSnapshotResponse.json()) as {
      lastSessionStreamOffset: string;
    };

    runtimeA.session.settingsManager.setTheme("light");

    const sessionBPatch = await waitForSessionEvent(
      remote.app,
      token,
      createdB.sessionId,
      beforeSnapshot.lastSessionStreamOffset,
      (event) =>
        event.kind === "session_state_patch" && event.payload.patch?.settings?.theme === "light",
    );
    expect(sessionBPatch.event.kind).toBe("session_state_patch");
    expect(sessionBPatch.event.payload.patch.settings?.theme).toBe("light");

    await waitForValue(
      () => runtimeB.session.settingsManager.getTheme(),
      (theme) => theme === "light",
      20,
      10,
    );

    expect(runtimeA.session.settingsManager.getTheme()).toBe("light");
    expect(runtimeB.session.settingsManager.getTheme()).toBe("light");

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${createdB.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      settings?: {
        theme?: string;
      };
    };
    expect(snapshot.settings?.theme).toBe("light");
  } finally {
    await runtimeA?.dispose();
    await runtimeB?.dispose();
    await remote.dispose();
  }
});

timedTest("remote settings mutations do not rebuild resource snapshots", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const sharedSettingsStore = {
    global: {} as Record<string, unknown>,
    project: {} as Record<string, unknown>,
  };
  const sessionA = new RecordingSession();
  const sessionB = new RecordingSession();
  sessionA.settingsStore = sharedSettingsStore;
  sessionB.settingsStore = sharedSettingsStore;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new SequencedRecordingRuntimeFactory([sessionA, sessionB]),
  });

  let runtimeA: RemoteAgentSessionRuntime | undefined;
  let runtimeB: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponseA = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const createResponseB = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(createResponseA.status).toBe(201);
    expect(createResponseB.status).toBe(201);

    const createdA = (await createResponseA.json()) as { sessionId: string };
    const createdB = (await createResponseB.json()) as { sessionId: string };

    runtimeA = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdA.sessionId,
    });
    runtimeB = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdB.sessionId,
    });

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${createdB.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      lastSessionStreamOffset: string;
    };

    const resourceReadsBeforeA = sessionA.snapshotExpensiveResourceReadCounts();
    const resourceReadsBeforeB = sessionB.snapshotExpensiveResourceReadCounts();

    runtimeA.session.settingsManager.setTheme("light");

    const sessionBPatch = await waitForSessionEvent(
      remote.app,
      token,
      createdB.sessionId,
      snapshot.lastSessionStreamOffset,
      (event) =>
        event.kind === "session_state_patch" && event.payload.patch?.settings?.theme === "light",
    );
    expect(sessionBPatch.event.kind).toBe("session_state_patch");

    await waitForValue(
      () => runtimeB.session.settingsManager.getTheme(),
      (theme) => theme === "light",
      20,
      10,
    );

    expect(runtimeB.session.settingsManager.getTheme()).toBe("light");
    expect(sessionA.snapshotExpensiveResourceReadCounts()).toEqual(resourceReadsBeforeA);
    expect(sessionB.snapshotExpensiveResourceReadCounts()).toEqual(resourceReadsBeforeB);
  } finally {
    await runtimeA?.dispose();
    await runtimeB?.dispose();
    await remote.dispose();
  }
});

timedTest("remote behavior settings sync across sessions", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const sharedSettingsStore = {
    global: {} as Record<string, unknown>,
    project: {} as Record<string, unknown>,
  };
  const sessionA = new RecordingSession();
  const sessionB = new RecordingSession();
  sessionA.settingsStore = sharedSettingsStore;
  sessionB.settingsStore = sharedSettingsStore;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new SequencedRecordingRuntimeFactory([sessionA, sessionB]),
  });

  let runtimeA: RemoteAgentSessionRuntime | undefined;
  let runtimeB: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponseA = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const createResponseB = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(createResponseA.status).toBe(201);
    expect(createResponseB.status).toBe(201);

    const createdA = (await createResponseA.json()) as { sessionId: string };
    const createdB = (await createResponseB.json()) as { sessionId: string };

    runtimeA = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdA.sessionId,
    });
    runtimeB = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdB.sessionId,
    });

    const beforeSnapshotResponse = await remote.app.request(
      `/v1/sessions/${createdB.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(beforeSnapshotResponse.status).toBe(200);
    const beforeSnapshot = (await beforeSnapshotResponse.json()) as {
      lastSessionStreamOffset: string;
    };

    runtimeA.session.setSteeringMode("one-at-a-time");
    runtimeA.session.setAutoCompactionEnabled(true);

    const sessionBPatch = await waitForSessionEvent(
      remote.app,
      token,
      createdB.sessionId,
      beforeSnapshot.lastSessionStreamOffset,
      (event) =>
        event.kind === "session_state_patch" &&
        event.payload.patch?.steeringMode === "one-at-a-time" &&
        event.payload.patch?.autoCompactionEnabled === true,
    );
    expect(sessionBPatch.event.kind).toBe("session_state_patch");
    expect(sessionBPatch.event.payload.patch.steeringMode).toBe("one-at-a-time");
    expect(sessionBPatch.event.payload.patch.autoCompactionEnabled).toBe(true);

    await waitForValue(
      () => ({
        steeringMode: runtimeB.session.steeringMode,
        autoCompactionEnabled: runtimeB.session.autoCompactionEnabled,
      }),
      (value) => value.steeringMode === "one-at-a-time" && value.autoCompactionEnabled === true,
      20,
      10,
    );

    expect(runtimeA.session.steeringMode).toBe("one-at-a-time");
    expect(runtimeB.session.steeringMode).toBe("one-at-a-time");
    expect(runtimeA.session.autoCompactionEnabled).toBe(true);
    expect(runtimeB.session.autoCompactionEnabled).toBe(true);
  } finally {
    await runtimeA?.dispose();
    await runtimeB?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "remote settings mutations rollback optimistic local state on server failure",
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
      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        cwd: "/srv/settings-rollback-workspace",
      });
      const initialTheme = runtime.session.settingsManager.getTheme();

      const originalSetTheme = session.settingsManager.setTheme;
      session.settingsManager.setTheme = () => {
        throw new Error("theme write denied");
      };

      runtime.session.settingsManager.setTheme("light");

      await waitForValue(
        () => runtime.session.state.errorMessage,
        (errorMessage) =>
          typeof errorMessage === "string" && errorMessage.includes("theme write denied"),
        30,
        10,
      );

      expect(runtime.session.settingsManager.getTheme()).toBe(initialTheme);
      expect(runtime.session.state.errorMessage ?? "").toMatch(/theme write denied/);

      session.settingsManager.setTheme = originalSetTheme;
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("milestone 3.2 snapshot and adapter use authoritative server cwd", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  session.cwd = "/srv/authoritative-workspace";
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
    const created = await createResponse.json();
    if (!created || typeof created !== "object" || !("sessionId" in created)) {
      throw new Error("Missing sessionId in createSession response");
    }

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    if (!snapshot || typeof snapshot !== "object" || !("cwd" in snapshot)) {
      throw new Error("Missing cwd in session snapshot");
    }
    expect(snapshot.cwd).toBe("/srv/authoritative-workspace");

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      cwd: "/tmp/client-local-cwd",
    });

    expect(runtime.session.sessionManager.getCwd()).toBe("/srv/authoritative-workspace");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3.2 adapter handles extended remote ui bridge primitives", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new UiPrimitivesPromptSession();
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
    const created = await createResponse.json();
    if (!created || typeof created !== "object" || !("sessionId" in created)) {
      throw new Error("Missing sessionId in createSession response");
    }

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    let workingMessage: string | undefined;
    let workingIndicator:
      | {
          frames?: string[];
          intervalMs?: number;
        }
      | undefined;
    let hiddenThinkingLabel: string | undefined;
    let toolsExpanded = true;

    const uiContext = {
      setWorkingMessage: (message?: string) => {
        workingMessage = message;
      },
      setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => {
        workingIndicator = options;
      },
      setHiddenThinkingLabel: (label?: string) => {
        hiddenThinkingLabel = label;
      },
      setToolsExpanded: (expanded: boolean) => {
        toolsExpanded = expanded;
      },
      setHeader: () => {},
      setFooter: () => {},
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      setEditorText: () => {},
      select: async () => {},
      confirm: async () => false,
      input: async () => {},
      editor: async () => {},
      onTerminalInput: () => () => {},
      custom: async () => {},
      pasteToEditor: () => {},
      getEditorText: () => "",
      setEditorComponent: () => {},
      theme: {
        fg: (...parts: unknown[]) => String(parts.at(-1) ?? ""),
      },
      getAllThemes: () => [],
      getTheme: () => {},
      setTheme: () => ({ success: false }),
      getToolsExpanded: () => true,
    };

    Reflect.set(runtime.session, "uiContext", uiContext);
    await runtime.session.prompt("trigger ui primitives");

    await waitForValue(
      () => ({ workingMessage, hiddenThinkingLabel }),
      (value) => Boolean(value.workingMessage && value.hiddenThinkingLabel),
      20,
      10,
    );

    expect(workingMessage).toBe("remote-working");
    expect(workingIndicator).toEqual({ frames: ["remote-indicator"], intervalMs: 321 });
    expect(hiddenThinkingLabel).toBe("remote-hidden-thinking");
    expect(toolsExpanded).toBe(false);
    expect(session.headerError ?? "").toMatch(/setHeader\(factory\) is not supported/);
    expect(session.footerError ?? "").toMatch(/setFooter\(factory\) is not supported/);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote runtime newSession runs withSession on replacement context", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory(),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  try {
    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      cwd: "/srv/new-session-workspace",
    });

    let statusKey: string | undefined;
    let statusText: string | undefined;
    await runtime.session.bindExtensions({
      uiContext: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
        custom: async () => undefined,
        notify: () => {},
        onTerminalInput: () => () => {},
        setStatus: (nextStatusKey: string, nextStatusText: string | undefined) => {
          statusKey = nextStatusKey;
          statusText = nextStatusText;
        },
        setWorkingMessage: () => {},
        setWorkingIndicator: () => {},
        setHiddenThinkingLabel: () => {},
        setWidget: () => {},
        setFooter: () => {},
        setHeader: () => {},
        setTitle: () => {},
        pasteToEditor: () => {},
        setEditorText: () => {},
        getEditorText: () => "",
        addAutocompleteProvider: () => {},
        setEditorComponent: () => {},
        theme: sessionTheme(),
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: false }),
        getToolsExpanded: () => false,
        setToolsExpanded: () => {},
      },
    });

    const previousSessionId = runtime.session.sessionManager.getSessionId();
    let replacementSessionId: string | undefined;
    let replacementHasUi: boolean | undefined;

    const result = await runtime.newSession({
      withSession: async (ctx) => {
        replacementSessionId = ctx.sessionManager.getSessionId();
        replacementHasUi = ctx.hasUI;
        ctx.ui.setStatus("replacement", "ready");
        await ctx.sendUserMessage("replacement-session-message");
      },
    });

    expect(result.cancelled).toBe(false);
    expect(replacementSessionId).not.toBe(previousSessionId);
    expect(replacementSessionId).toBe(runtime.session.sessionManager.getSessionId());
    expect(replacementHasUi).toBe(true);
    expect(statusKey).toBe("replacement");
    expect(statusText).toBe("ready");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote runtime switchSession runs withSession on target session", async () => {
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
      body: JSON.stringify({ sessionName: "switch-target" }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
    });

    let notified = false;
    await runtime.session.bindExtensions({
      uiContext: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
        custom: async () => undefined,
        notify: () => {
          notified = true;
        },
        onTerminalInput: () => () => {},
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingIndicator: () => {},
        setHiddenThinkingLabel: () => {},
        setWidget: () => {},
        setFooter: () => {},
        setHeader: () => {},
        setTitle: () => {},
        pasteToEditor: () => {},
        setEditorText: () => {},
        getEditorText: () => "",
        addAutocompleteProvider: () => {},
        setEditorComponent: () => {},
        theme: sessionTheme(),
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: false }),
        getToolsExpanded: () => false,
        setToolsExpanded: () => {},
      },
    });

    let replacementSessionId: string | undefined;
    const result = await runtime.switchSession(created.sessionId, {
      withSession: async (ctx) => {
        replacementSessionId = ctx.sessionManager.getSessionId();
        ctx.ui.notify("switched", "info");
        await ctx.sendUserMessage("switched-session-message");
      },
    });

    expect(result.cancelled).toBe(false);
    expect(replacementSessionId).toBe(created.sessionId);
    expect(runtime.session.sessionManager.getSessionId()).toBe(created.sessionId);
    expect(notified).toBe(true);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote runtime switchSession accepts session file path from resume picker", async () => {
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

    const sessionFilePath = `/tmp/pi-remote-tests/sessions/workspace/2026-04-24T23-41-56-774Z_${created.sessionId}.jsonl`;

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
    });

    const result = await runtime.switchSession(sessionFilePath);

    expect(result.cancelled).toBe(false);
    expect(runtime.session.sessionManager.getSessionId()).toBe(created.sessionId);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote rename endpoint updates session name", async () => {
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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const renameResponse = await remote.app.request(`/v1/sessions/${created.sessionId}/rename`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionName: "renamed-via-endpoint",
      }),
    });
    expect(renameResponse.status).toBe(202);

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as { sessionName: string };
    expect(snapshot.sessionName).toBe("renamed-via-endpoint");
  } finally {
    await remote.dispose();
  }
});

timedTest("loaded remote app snapshot includes firstUserMessage in session summaries", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new InMemoryPiRuntimeFactory(),
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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const promptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/prompt`,
      token,
      {
        text: "Summarize picker parity",
      },
    );
    expect(promptResponse.status).toBe(202);

    const snapshot = await waitForValue(
      async () => {
        const appSnapshotResponse = await remote.app.request("/v1/app/snapshot", {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(appSnapshotResponse.status).toBe(200);
        return (await appSnapshotResponse.json()) as {
          sessionSummaries: Array<{
            sessionId: string;
            firstUserMessage?: string;
          }>;
        };
      },
      (appSnapshot) =>
        appSnapshot.sessionSummaries.some(
          (summary) =>
            summary.sessionId === created.sessionId &&
            summary.firstUserMessage === "Summarize picker parity",
        ),
    );

    const summary = snapshot.sessionSummaries.find(
      (sessionSummary) => sessionSummary.sessionId === created.sessionId,
    );
    expect(summary?.firstUserMessage).toBe("Summarize picker parity");
  } finally {
    await remote.dispose();
  }
});

timedTest("remote adapter keeps authoritative tree ids across repeated navigation", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new InMemoryPiRuntimeFactory(),
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
      body: JSON.stringify({ workspaceCwd: process.cwd() }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      cwd: process.cwd(),
    });

    await runtime.session.prompt("first message");
    await runtime.session.prompt("second message");
    await runtime.session.waitForIdle();

    const beforeNavigateSnapshot = await waitForValue(
      async () => {
        const snapshotResponse = await remote.app.request(
          `/v1/sessions/${created.sessionId}/snapshot`,
          {
            headers: {
              authorization: `Bearer ${token}`,
            },
          },
        );
        expect(snapshotResponse.status).toBe(200);
        return (await snapshotResponse.json()) as {
          entries: Array<{ type: string; id: string; message?: { role?: string } }>;
        };
      },
      (snapshot) =>
        snapshot.entries.some(
          (entry) => entry.type === "message" && entry.message?.role === "user",
        ),
    );

    const firstUserEntryId = beforeNavigateSnapshot.entries.find(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    )?.id;
    const secondMessageEntryIdBeforeNavigate = beforeNavigateSnapshot.entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.id)[1];
    expect(firstUserEntryId).toBeTruthy();
    expect(secondMessageEntryIdBeforeNavigate).toBeTruthy();

    const firstNavigation = await runtime.session.navigateTree(firstUserEntryId!, {});
    expect(firstNavigation.cancelled).toBe(false);
    expect(firstNavigation.editorText).toBe("first message");

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      entries: Array<{ type: string; id: string; message?: { role?: string } }>;
    };

    const localUserEntryIds = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "user")
      .map((entry) => entry.id);
    const remoteUserEntryIds = snapshot.entries
      .filter((entry) => entry.type === "message" && entry.message?.role === "user")
      .map((entry) => entry.id);

    expect(localUserEntryIds).toEqual(remoteUserEntryIds);

    await waitForValue(
      () =>
        runtime.session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "user")
          .map((entry) => entry.id),
      (nextLocalUserEntryIds) =>
        JSON.stringify(nextLocalUserEntryIds) === JSON.stringify(remoteUserEntryIds),
      20,
      10,
    );

    const secondMessageEntryId = secondMessageEntryIdBeforeNavigate;
    expect(secondMessageEntryId).toBeTruthy();

    const secondNavigation = await runtime.session.navigateTree(secondMessageEntryId!, {});
    expect(secondNavigation.cancelled).toBe(false);

    const secondSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(secondSnapshotResponse.status).toBe(200);
    const secondSnapshot = (await secondSnapshotResponse.json()) as {
      entries: Array<{ type: string; id: string; message?: { role?: string } }>;
    };
    const secondRemoteUserEntryIds = secondSnapshot.entries
      .filter((entry) => entry.type === "message" && entry.message?.role === "user")
      .map((entry) => entry.id);
    const secondLocalUserEntryIds = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "user")
      .map((entry) => entry.id);

    expect(secondLocalUserEntryIds).toEqual(secondRemoteUserEntryIds);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "remote tree summary forwards custom prompt and runs server before-tree hook",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
    const seenPreparations: Array<{
      customInstructions: string | undefined;
      replaceInstructions: boolean | undefined;
      userWantsSummary: boolean;
      entriesToSummarize: number;
    }> = [];

    const serverExtension: ExtensionFactory = (pi) => {
      pi.on("session_before_tree", (event) => {
        seenPreparations.push({
          customInstructions: event.preparation.customInstructions,
          replaceInstructions: event.preparation.replaceInstructions,
          userWantsSummary: event.preparation.userWantsSummary,
          entriesToSummarize: event.preparation.entriesToSummarize.length,
        });
        return {
          summary: {
            summary: "server hook summary",
            details: { source: "server-hook" },
          },
        };
      });
    };

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: InMemoryPiRuntimeFactory({ extensionFactories: [serverExtension] }),
    });

    try {
      const token = await authenticate(remote.app, privateKeyPem);
      const createResponse = await remote.app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspaceCwd: process.cwd() }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      const firstPromptResponse = await postSessionCommand(
        remote.app,
        `/v1/sessions/${created.sessionId}/prompt`,
        token,
        { text: "first message" },
      );
      expect(firstPromptResponse.status).toBe(202);

      await waitForValue(
        async () => {
          const snapshotResponse = await remote.app.request(
            `/v1/sessions/${created.sessionId}/snapshot`,
            {
              headers: {
                authorization: `Bearer ${token}`,
              },
            },
          );
          expect(snapshotResponse.status).toBe(200);
          return (await snapshotResponse.json()) as {
            queue: { depth: number };
            streamingState: string;
          };
        },
        (snapshot) => snapshot.queue.depth === 0 && snapshot.streamingState === "idle",
      );

      const secondPromptResponse = await postSessionCommand(
        remote.app,
        `/v1/sessions/${created.sessionId}/prompt`,
        token,
        { text: "second message" },
      );
      expect(secondPromptResponse.status).toBe(202);

      const snapshot = await waitForValue(
        async () => {
          const snapshotResponse = await remote.app.request(
            `/v1/sessions/${created.sessionId}/snapshot`,
            {
              headers: {
                authorization: `Bearer ${token}`,
              },
            },
          );
          expect(snapshotResponse.status).toBe(200);
          return (await snapshotResponse.json()) as {
            entries: Array<{ type: string; id: string; message?: { role?: string } }>;
          };
        },
        (value) => value.entries.filter((entry) => entry.type === "message").length >= 2,
      );

      const firstUserEntryId = snapshot.entries.find(
        (entry) => entry.type === "message" && entry.message?.role === "user",
      )?.id;
      expect(firstUserEntryId).toBeTruthy();

      const navigateResponse = await remote.app.request(
        `/v1/sessions/${created.sessionId}/navigate-tree`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            targetId: firstUserEntryId,
            summarize: true,
            customInstructions: "focus on diffs",
          }),
        },
      );
      expect(navigateResponse.status).toBe(200);
      const navigateResult = (await navigateResponse.json()) as {
        cancelled: boolean;
        summaryEntry?: { summary?: string };
      };

      expect(navigateResult.cancelled).toBe(false);
      expect(navigateResult.summaryEntry).toMatchObject({ summary: "server hook summary" });
      expect(seenPreparations).toEqual([
        {
          customInstructions: "focus on diffs",
          replaceInstructions: undefined,
          userWantsSummary: true,
          entriesToSummarize: seenPreparations[0]!.entriesToSummarize,
        },
      ]);
      expect(seenPreparations[0]!.entriesToSummarize > 0).toBe(true);
    } finally {
      await remote.dispose();
    }
  },
);

timedTest(
  "remote tree summary forwards replaceInstructions for custom prompt replace mode",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
    const seenPreparations: Array<{
      customInstructions: string | undefined;
      replaceInstructions: boolean | undefined;
    }> = [];

    const serverExtension: ExtensionFactory = (pi) => {
      pi.on("session_before_tree", (event) => {
        seenPreparations.push({
          customInstructions: event.preparation.customInstructions,
          replaceInstructions: event.preparation.replaceInstructions,
        });
        return {
          summary: {
            summary: "replace mode summary",
          },
        };
      });
    };

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: InMemoryPiRuntimeFactory({ extensionFactories: [serverExtension] }),
    });

    try {
      const token = await authenticate(remote.app, privateKeyPem);
      const createResponse = await remote.app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspaceCwd: process.cwd() }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      const firstPromptResponse = await postSessionCommand(
        remote.app,
        `/v1/sessions/${created.sessionId}/prompt`,
        token,
        { text: "first message" },
      );
      expect(firstPromptResponse.status).toBe(202);

      const secondPromptResponse = await postSessionCommand(
        remote.app,
        `/v1/sessions/${created.sessionId}/prompt`,
        token,
        { text: "second message" },
      );
      expect(secondPromptResponse.status).toBe(202);

      const snapshot = await waitForValue(
        async () => {
          const snapshotResponse = await remote.app.request(
            `/v1/sessions/${created.sessionId}/snapshot`,
            {
              headers: {
                authorization: `Bearer ${token}`,
              },
            },
          );
          expect(snapshotResponse.status).toBe(200);
          return (await snapshotResponse.json()) as {
            entries: Array<{ type: string; id: string; message?: { role?: string } }>;
          };
        },
        (value) => value.entries.filter((entry) => entry.type === "message").length >= 2,
      );

      const firstUserEntryId = snapshot.entries.find(
        (entry) => entry.type === "message" && entry.message?.role === "user",
      )?.id;
      expect(firstUserEntryId).toBeTruthy();

      const navigateResponse = await remote.app.request(
        `/v1/sessions/${created.sessionId}/navigate-tree`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            targetId: firstUserEntryId,
            summarize: true,
            customInstructions: "only output file changes",
            replaceInstructions: true,
          }),
        },
      );
      expect(navigateResponse.status).toBe(200);
      const navigateResult = (await navigateResponse.json()) as {
        cancelled: boolean;
        summaryEntry?: { summary?: string };
      };

      expect(navigateResult.cancelled).toBe(false);
      expect(navigateResult.summaryEntry).toMatchObject({ summary: "replace mode summary" });
      expect(seenPreparations).toEqual([
        {
          customInstructions: "only output file changes",
          replaceInstructions: true,
        },
      ]);
    } finally {
      await remote.dispose();
    }
  },
);

timedTest("remote fork returns cancelled when server before-fork hook cancels", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const seenBeforeFork: Array<{ entryId: string; position: "before" | "at" }> = [];

  const serverExtension: ExtensionFactory = (pi) => {
    pi.on("session_before_fork", (event) => {
      seenBeforeFork.push({ entryId: event.entryId, position: event.position });
      return { cancel: true };
    });
  };

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory({
      persistSessions: true,
      extensionFactories: [serverExtension],
    }),
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
      body: JSON.stringify({ workspaceCwd: process.cwd() }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const promptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/prompt`,
      token,
      { text: "fork me" },
    );
    expect(promptResponse.status).toBe(202);

    await waitForValue(
      async () => {
        const snapshotResponse = await remote.app.request(
          `/v1/sessions/${created.sessionId}/snapshot`,
          {
            headers: {
              authorization: `Bearer ${token}`,
            },
          },
        );
        expect(snapshotResponse.status).toBe(200);
        return (await snapshotResponse.json()) as {
          entries: Array<{ type: string; message?: { role?: string } }>;
          queue: { depth: number };
          streamingState: string;
        };
      },
      (snapshot) =>
        snapshot.entries.filter(
          (entry) => entry.type === "message" && entry.message?.role === "user",
        ).length >= 1 &&
        snapshot.queue.depth === 0 &&
        snapshot.streamingState === "idle",
    );

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      cwd: process.cwd(),
    });

    const forkMessages = runtime.session.getUserMessagesForForking();
    expect(forkMessages).toHaveLength(1);

    const originalSessionId = runtime.session.sessionManager.getSessionId();
    const result = await runtime.fork(forkMessages[0]!.entryId);

    expect(result).toEqual({ cancelled: true, selectedText: undefined });
    expect(runtime.session.sessionManager.getSessionId()).toBe(originalSessionId);
    expect(seenBeforeFork).toEqual([{ entryId: forkMessages[0]!.entryId, position: "before" }]);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote fork starts replacement runtime with fork reason", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const seenBeforeFork: Array<{ entryId: string; position: "before" | "at" }> = [];
  const seenSessionStarts: string[] = [];

  const serverExtension: ExtensionFactory = (pi) => {
    pi.on("session_before_fork", (event) => {
      seenBeforeFork.push({ entryId: event.entryId, position: event.position });
    });
    pi.on("session_start", (event) => {
      seenSessionStarts.push(event.reason);
    });
  };

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory({
      persistSessions: true,
      extensionFactories: [serverExtension],
    }),
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
      body: JSON.stringify({ workspaceCwd: process.cwd() }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const promptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/prompt`,
      token,
      { text: "fork me again" },
    );
    expect(promptResponse.status).toBe(202);

    await waitForValue(
      async () => {
        const snapshotResponse = await remote.app.request(
          `/v1/sessions/${created.sessionId}/snapshot`,
          {
            headers: {
              authorization: `Bearer ${token}`,
            },
          },
        );
        expect(snapshotResponse.status).toBe(200);
        return (await snapshotResponse.json()) as {
          entries: Array<{ type: string; message?: { role?: string } }>;
          queue: { depth: number };
          streamingState: string;
        };
      },
      (snapshot) =>
        snapshot.entries.filter(
          (entry) => entry.type === "message" && entry.message?.role === "user",
        ).length >= 1 &&
        snapshot.queue.depth === 0 &&
        snapshot.streamingState === "idle",
    );

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      cwd: process.cwd(),
    });

    seenSessionStarts.length = 0;

    const forkMessages = runtime.session.getUserMessagesForForking();
    expect(forkMessages).toHaveLength(1);

    const originalSessionId = runtime.session.sessionManager.getSessionId();
    const result = await runtime.fork(forkMessages[0]!.entryId);

    expect(result).toEqual({ cancelled: false, selectedText: "fork me again" });
    expect(runtime.session.sessionManager.getSessionId()).not.toBe(originalSessionId);
    expect(seenBeforeFork).toEqual([{ entryId: forkMessages[0]!.entryId, position: "before" }]);
    expect(seenSessionStarts).toContain("fork");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote fork preserves semantics across repeated forks", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const seenBeforeFork: Array<{ entryId: string; position: "before" | "at" }> = [];
  const seenSessionStarts: string[] = [];

  const serverExtension: ExtensionFactory = (pi) => {
    pi.on("session_before_fork", (event) => {
      seenBeforeFork.push({ entryId: event.entryId, position: event.position });
    });
    pi.on("session_start", (event) => {
      seenSessionStarts.push(event.reason);
    });
  };

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory({
      persistSessions: true,
      extensionFactories: [serverExtension],
    }),
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
      body: JSON.stringify({ workspaceCwd: process.cwd() }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const prompts = ["fork level 1", "fork level 2", "fork level 3"];
    for (const [index, prompt] of prompts.entries()) {
      const promptResponse = await postSessionCommand(
        remote.app,
        `/v1/sessions/${created.sessionId}/prompt`,
        token,
        { text: prompt },
      );
      expect(promptResponse.status).toBe(202);

      await waitForValue(
        async () => {
          const snapshotResponse = await remote.app.request(
            `/v1/sessions/${created.sessionId}/snapshot`,
            {
              headers: {
                authorization: `Bearer ${token}`,
              },
            },
          );
          expect(snapshotResponse.status).toBe(200);
          return (await snapshotResponse.json()) as {
            entries: Array<{ type: string; id: string; message?: { role?: string } }>;
            queue: { depth: number };
            streamingState: string;
          };
        },
        (snapshot) =>
          snapshot.entries.filter(
            (entry) => entry.type === "message" && entry.message?.role === "user",
          ).length >=
            index + 1 &&
          snapshot.queue.depth === 0 &&
          snapshot.streamingState === "idle",
      );
    }

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      cwd: process.cwd(),
    });

    seenSessionStarts.length = 0;

    for (const prompt of prompts.toReversed()) {
      const forkMessages = runtime.session.getUserMessagesForForking();
      const target = forkMessages.find((message) => message.text === prompt);
      expect(target).toBeTruthy();

      const previousSessionId = runtime.session.sessionManager.getSessionId();
      const result = await runtime.fork(target!.entryId);

      expect(result).toEqual({ cancelled: false, selectedText: prompt });
      expect(runtime.session.sessionManager.getSessionId()).not.toBe(previousSessionId);
    }

    expect(seenBeforeFork).toHaveLength(3);
    expect(seenBeforeFork.every((event) => event.position === "before")).toBe(true);
    expect(seenSessionStarts.filter((reason) => reason === "fork")).toHaveLength(3);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "remote runtime switchSession ignores abort errors from previous session shutdown",
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
      });

      const sessionAny = runtime.session as {
        activeReadAbortController?: AbortController;
        pollingTask?: Promise<void>;
      };
      const abortController = new AbortController();
      abortController.abort = () => {
        const abortError = new Error("This operation was aborted");
        abortError.name = "AbortError";
        throw abortError;
      };
      sessionAny.activeReadAbortController = abortController;
      sessionAny.pollingTask = Promise.resolve();

      await expect(runtime!.switchSession(created.sessionId)).resolves.toEqual({
        cancelled: false,
      });
      expect(runtime.session.sessionManager.getSessionId()).toBe(created.sessionId);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

function sessionTheme() {
  return {
    fg: (_style: string, text: string) => text,
    bg: (_style: string, text: string) => text,
    getBgAnsi: () => "",
  };
}

timedTest("milestone 3 adapter reads session stream via sse", async () => {
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

    const streamRequests: string[] = [];
    const baseFetch = createInProcessFetch(remote.app);

    runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      sessionId: created.sessionId,
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes(`/streams/sessions/${created.sessionId}/events`)) {
          streamRequests.push(url);
        }
        return baseFetch(input, init);
      },
    });

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (streamRequests.some((url) => url.includes("live=sse"))) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    expect(streamRequests.some((url) => url.includes("live=sse"))).toBeTruthy();
    expect(streamRequests.some((url) => url.includes("live=long-poll"))).toBe(false);

    const initialSseRequestCount = streamRequests.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(streamRequests.length).toBe(initialSseRequestCount);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter applies live sse control offsets without reconnect", async () => {
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

    const streamRequests: string[] = [];
    const baseFetch = createInProcessFetch(remote.app);
    runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      sessionId: created.sessionId,
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes(`/streams/sessions/${created.sessionId}/events`)) {
          streamRequests.push(url);
        }
        return baseFetch(input, init);
      },
    });

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (streamRequests.length > 0) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    const sessionAny = runtime.session as any;
    const initialOffset = sessionAny.streamOffset;

    const nameResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/session-name`,
      token,
      {
        sessionName: "live-sse-offset",
      },
    );
    expect(nameResponse.status).toBe(202);

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (sessionAny.streamOffset !== initialOffset) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    expect(sessionAny.streamOffset).not.toBe(initialOffset);
    expect(streamRequests.length).toBe(1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "milestone 3 adapter reauthenticates and resumes polling after token invalidation",
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

      const baseFetch = createInProcessFetch(remote.app);
      let authChallengeCalls = 0;
      let streamUnauthorizedInjected = false;
      runtime = await RemoteAgentSessionRuntime.create({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        sessionId: created.sessionId,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.includes("/v1/auth/challenge")) {
            authChallengeCalls += 1;
          }
          if (
            !streamUnauthorizedInjected &&
            url.includes(`/streams/sessions/${created.sessionId}/events`)
          ) {
            streamUnauthorizedInjected = true;
            return new Response(JSON.stringify({ error: "Invalid token" }), {
              status: 401,
              headers: {
                "content-type": "application/json",
              },
            });
          }
          return baseFetch(input, init);
        },
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (streamUnauthorizedInjected && authChallengeCalls >= 2) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      expect(streamUnauthorizedInjected).toBe(true);
      expect(authChallengeCalls >= 2).toBeTruthy();
      expect(runtime.session.state.errorMessage).toBe(undefined);

      const sessionAny = runtime.session as any;
      const initialOffset = sessionAny.streamOffset;

      const nameResponse = await postSessionCommand(
        remote.app,
        `/v1/sessions/${created.sessionId}/session-name`,
        token,
        {
          sessionName: "resume-after-reauth",
        },
      );
      expect(nameResponse.status).toBe(202);

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (sessionAny.streamOffset !== initialOffset) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      expect(sessionAny.streamOffset).not.toBe(initialOffset);

      const remoteErrorMessages = runtime.session.messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { customType?: string }).customType === "remote_error",
      );
      expect(remoteErrorMessages.length).toBe(0);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("milestone 3 adapter stops auth refresh loop when key is denied", async () => {
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

    const baseFetch = createInProcessFetch(remote.app);
    let authChallengeCalls = 0;
    runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      sessionId: created.sessionId,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/v1/auth/challenge")) {
          authChallengeCalls += 1;
          if (authChallengeCalls > 1) {
            return new Response(JSON.stringify({ error: "Unknown key" }), {
              status: 403,
              headers: {
                "content-type": "application/json",
              },
            });
          }
        }
        if (url.includes(`/streams/sessions/${created.sessionId}/events`)) {
          return new Response(JSON.stringify({ error: "Invalid token" }), {
            status: 401,
            headers: {
              "content-type": "application/json",
            },
          });
        }
        return baseFetch(input, init);
      },
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((runtime.session.state.errorMessage ?? "").includes("Remote authentication denied")) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    expect(runtime.session.state.errorMessage ?? "").toMatch(/Remote authentication denied/);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(authChallengeCalls).toBe(2);

    const remoteErrorMessages = runtime.session.messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { customType?: string }).customType === "remote_error",
    );
    expect(remoteErrorMessages.length).toBe(1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter retries failed stream batch from same offset", async () => {
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
    sessionAny.closed = true;
    sessionAny.activeReadAbortController?.abort();
    await sessionAny.pollingTask;

    sessionAny.closed = false;
    sessionAny.streamOffset = "0-0";

    const offsets: string[] = [];
    let readCalls = 0;
    sessionAny.client.readSessionEvents = async (_sessionId: string, offset: string) => {
      offsets.push(offset);
      readCalls += 1;
      if (readCalls === 1) {
        return {
          events: [
            { kind: "unknown_first", payload: { id: "first" }, streamOffset: "0-1" },
            { kind: "unknown_second", payload: { id: "second" }, streamOffset: "0-2" },
          ],
          nextOffset: "0-3",
          streamClosed: false,
        };
      }
      if (readCalls === 2) {
        return {
          events: [
            { kind: "unknown_first", payload: { id: "first" }, streamOffset: "0-1" },
            { kind: "unknown_second", payload: { id: "second" }, streamOffset: "0-2" },
          ],
          nextOffset: "0-3",
          streamClosed: true,
        };
      }
      throw new Error("unexpected readSessionEvents call");
    };

    const handled: string[] = [];
    let transientFailureInjected = false;
    sessionAny.handleEnvelope = async (envelope: { payload: { id: string } }) => {
      if (!transientFailureInjected) {
        transientFailureInjected = true;
        throw { status: 500, message: "transient" };
      }
      handled.push(envelope.payload.id);
    };

    await sessionAny.pollEvents();

    expect(offsets).toEqual(["0-0", "0-0"]);
    expect(handled).toEqual(["first", "second"]);
    expect(sessionAny.streamOffset).toBe("0-3");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter fails fast on non-http polling errors", async () => {
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
    sessionAny.closed = true;
    sessionAny.activeReadAbortController?.abort();
    await sessionAny.pollingTask;

    sessionAny.closed = false;

    let readCalls = 0;
    sessionAny.client.readSessionEvents = async () => {
      readCalls += 1;
      throw new Error("schema mismatch");
    };

    await sessionAny.pollEvents();

    expect(readCalls).toBe(1);
    expect(runtime.session.state.errorMessage ?? "").toMatch(
      /Remote stream polling failed: schema mismatch/,
    );
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});
