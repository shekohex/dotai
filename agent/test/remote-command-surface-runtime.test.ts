import { mkdir } from "node:fs/promises";
import {
  AgentLifecyclePromptSession,
  BlockingPromptSession,
  ImmediateAssistantPromptSession,
  InMemoryDurableStreamStore,
  InMemoryPiRuntimeFactory,
  RecordingRuntimeFactory,
  RecordingSession,
  RemoteAgentSessionRuntime,
  RemoteApiClient,
  SessionRegistry,
  authenticate,
  createBashToolOverrideDefinition,
  createInProcessFetch,
  createReadToolOverrideDefinition,
  createRemoteApp,
  createRemoteRuntime,
  createRemoteThemeFromContent,
  expect,
  join,
  loadThemeFromPath,
  mkdtemp,
  postSessionCommand,
  readFile,
  readSessionEvents,
  rm,
  writeFile,
  test,
  testAuthSession,
  TEST_ED25519_KEYS,
  timedTest,
  tmpdir,
  waitForSessionEvent,
  waitForValue,
  type ExtensionFactory,
} from "./remote-command-surface.shared.ts";

timedTest("milestone 2 command surface sequences commands and replays session events", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(new ImmediateAssistantPromptSession()),
  });

  try {
    const tokenA = await authenticate(remote.app, privateKeyPem);
    const tokenB = tokenA;

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "x-pi-connection-id": "device-a",
      },
      body: JSON.stringify({ sessionName: "Milestone 2" }),
    });
    expect(createResponse.status).toBe(201);
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
    expect(initialSnapshotResponse.status).toBe(200);
    const initialSnapshot = (await initialSnapshotResponse.json()) as {
      model: string;
      thinkingLevel: string;
      lastSessionStreamOffset: string;
    };

    const [nameAResponse, nameBResponse] = await Promise.all([
      remote.app.request(`/v1/sessions/${created.sessionId}/session-name`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "content-type": "application/json",
          "x-pi-connection-id": "device-a",
        },
        body: JSON.stringify({
          sessionName: "Milestone 2 A",
        }),
      }),
      remote.app.request(`/v1/sessions/${created.sessionId}/session-name`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenB}`,
          "content-type": "application/json",
          "x-pi-connection-id": "device-b",
        },
        body: JSON.stringify({
          sessionName: "Milestone 2 B",
        }),
      }),
    ]);

    expect(nameAResponse.status).toBe(202);
    expect(nameBResponse.status).toBe(202);
    const nameAcceptedA = (await nameAResponse.json()) as {
      sequence: number;
    };
    const nameAcceptedB = (await nameBResponse.json()) as {
      sequence: number;
    };
    const firstSequences = [nameAcceptedA.sequence, nameAcceptedB.sequence].toSorted(
      (a, b) => a - b,
    );
    expect(firstSequences).toEqual([1, 2]);

    const commandReplayResponse = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(initialSnapshot.lastSessionStreamOffset)}`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
    );
    expect(commandReplayResponse.status).toBe(200);
    const commandReplay = (await commandReplayResponse.json()) as {
      events: Array<{ kind: string; payload: any }>;
      nextOffset: string;
    };
    const sessionNamePatchEvents = commandReplay.events.filter(
      (event) =>
        event.kind === "session_state_patch" &&
        typeof event.payload?.patch?.sessionName === "string",
    );
    expect(sessionNamePatchEvents.length).toBe(2);
    const patchedNames = sessionNamePatchEvents
      .map((event) => event.payload?.patch?.sessionName as string)
      .toSorted((a, b) => a.localeCompare(b));
    expect(patchedNames).toEqual(["Milestone 2 A", "Milestone 2 B"]);
    const replayOffset = commandReplay.nextOffset;

    const nameResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/session-name`,
      tokenA,
      {
        sessionName: "Milestone 2 Renamed",
      },
    );
    expect(nameResponse.status).toBe(202);
    const nameAccepted = (await nameResponse.json()) as { sequence: number };
    expect(nameAccepted.sequence).toBe(3);

    const modelResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/model`,
      tokenA,
      {
        model: initialSnapshot.model,
        thinkingLevel: initialSnapshot.thinkingLevel,
      },
    );
    expect(modelResponse.status).toBe(202);
    const modelAccepted = (await modelResponse.json()) as { sequence: number };
    expect(modelAccepted.sequence).toBe(4);

    const promptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/prompt`,
      tokenA,
      {
        text: "Say hello in one sentence.",
      },
    );
    expect(promptResponse.status).toBe(202);
    const promptAccepted = (await promptResponse.json()) as { sequence: number };
    expect(promptAccepted.sequence).toBe(5);

    const steerResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/steer`,
      tokenB,
      {
        text: "Keep it very short.",
      },
    );
    expect(steerResponse.status).toBe(202);
    const steerAccepted = (await steerResponse.json()) as { sequence: number };
    expect(steerAccepted.sequence).toBe(6);

    const followUpResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/follow-up`,
      tokenB,
      {
        text: "Then add one more short sentence.",
      },
    );
    expect(followUpResponse.status).toBe(202);
    const followUpAccepted = (await followUpResponse.json()) as { sequence: number };
    expect(followUpAccepted.sequence).toBe(7);

    const interruptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/interrupt`,
      tokenA,
      {},
    );
    expect(interruptResponse.status).toBe(202);
    const interruptAccepted = (await interruptResponse.json()) as { sequence: number };
    expect(interruptAccepted.sequence).toBe(8);

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
    expect(waited.event.kind).toBe("agent_session_event");
    expect((waited.event.payload as { type: string }).type).toBe("agent_end");

    const resumedResponse = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(replayOffset)}`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
    );
    expect(resumedResponse.status).toBe(200);
    const resumed = (await resumedResponse.json()) as {
      events: Array<{ kind: string; payload: any }>;
      nextOffset: string;
    };
    expect(resumed.events.some((event) => event.kind === "command_accepted")).toBeTruthy();
    expect(resumed.events.some((event) => event.kind === "agent_session_event")).toBeTruthy();
    expect(!resumed.events.some((event) => event.kind === "extension_error")).toBeTruthy();

    const postPromptSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
    );
    expect(postPromptSnapshotResponse.status).toBe(200);
    const postPromptSnapshot = (await postPromptSnapshotResponse.json()) as {
      transcript: Array<{ role?: string }>;
    };
    expect(
      postPromptSnapshot.transcript.some((message) => message.role === "assistant"),
    ).toBeTruthy();

    const secondDeviceSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${tokenB}`,
          "x-pi-connection-id": "device-b",
        },
      },
    );
    expect(secondDeviceSnapshotResponse.status).toBe(200);
    const secondDeviceSnapshot = (await secondDeviceSnapshotResponse.json()) as {
      sessionName: string;
      presence: Array<{ connectionId: string }>;
      transcript: Array<{ role?: string }>;
    };
    expect(secondDeviceSnapshot.sessionName).toBe("Milestone 2 Renamed");
    expect(
      secondDeviceSnapshot.transcript.some((message) => message.role === "assistant"),
    ).toBeTruthy();
    expect(
      secondDeviceSnapshot.presence.some((presence) => presence.connectionId === "device-a"),
    ).toBe(true);
    expect(
      secondDeviceSnapshot.presence.some((presence) => presence.connectionId === "device-b"),
    ).toBe(true);

    const secondDeviceResume = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(resumed.nextOffset)}`,
      {
        headers: { authorization: `Bearer ${tokenB}` },
      },
    );
    expect(secondDeviceResume.status).toBe(200);
    const secondDeviceResumeBody = (await secondDeviceResume.json()) as {
      events: unknown[];
    };
    expect(secondDeviceResumeBody.events).toEqual([]);
  } finally {
    await remote.dispose();
  }
});

timedTest("default runtime factory hosts an in-memory Pi runtime", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const cwd = await mkdtemp(join(tmpdir(), "pi-remote-default-runtime-"));

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
      body: JSON.stringify({ workspaceCwd: cwd }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };
    expect(created.sessionId).toBeTruthy();

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as { sessionId: string; cwd: string };
    expect(snapshot.sessionId).toBe(created.sessionId);
    expect(snapshot.cwd).toBe(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await remote.dispose();
  }
});

timedTest("remote theme parser matches bundled theme examples", async () => {
  const bundledThemePaths = [
    join(process.cwd(), "src", "resources", "themes", "catppuccin-latte.json"),
    join(process.cwd(), "src", "resources", "themes", "catppuccin-mocha.json"),
  ];

  for (const themePath of bundledThemePaths) {
    const content = await readFile(themePath, "utf8");
    const remoteTheme = createRemoteThemeFromContent({
      sourcePath: themePath,
      content,
    });
    const upstreamTheme = loadThemeFromPath(themePath);

    expect(remoteTheme.name).toBe(upstreamTheme.name);
    expect(remoteTheme.sourcePath).toBe(themePath);
    expect(remoteTheme.getColorMode()).toBe(upstreamTheme.getColorMode());
    expect(remoteTheme.getFgAnsi("accent")).toBe(upstreamTheme.getFgAnsi("accent"));
    expect(remoteTheme.getFgAnsi("text")).toBe(upstreamTheme.getFgAnsi("text"));
    expect(remoteTheme.getFgAnsi("mdCode")).toBe(upstreamTheme.getFgAnsi("mdCode"));
    expect(remoteTheme.getFgAnsi("thinkingHigh")).toBe(upstreamTheme.getFgAnsi("thinkingHigh"));
    expect(remoteTheme.getBgAnsi("selectedBg")).toBe(upstreamTheme.getBgAnsi("selectedBg"));
    expect(remoteTheme.getBgAnsi("toolSuccessBg")).toBe(upstreamTheme.getBgAnsi("toolSuccessBg"));
  }
});

timedTest(
  "remote runtime exposes client tool override definitions for mirrored built-in tools",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: InMemoryPiRuntimeFactory(),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
    const overrideExtension: ExtensionFactory = (pi) => {
      pi.registerTool(createBashToolOverrideDefinition());
      pi.registerTool(createReadToolOverrideDefinition());
    };

    try {
      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        cwd: "/srv/tool-override-workspace",
        clientExtensionMetadata: [
          {
            id: "test-bash-override",
            runtime: "client",
            path: "client:test-bash-override",
          },
        ],
        clientExtensionFactories: [overrideExtension],
      });

      await runtime.session.bindExtensions({});

      for (const toolName of ["bash", "read"]) {
        const toolDefinition = runtime.session.getToolDefinition(toolName);

        expect(toolDefinition).toBeTruthy();
        expect(toolDefinition?.name).toBe(toolName);
        expect(typeof toolDefinition?.renderCall).toBe("function");
        expect(typeof toolDefinition?.renderResult).toBe("function");
      }
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("remote tools endpoint includes authoritative tool definition metadata", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  try {
    const client = new RemoteApiClient({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      fetchImpl: createInProcessFetch(remote.app),
    });
    await client.authenticate();

    const created = await client.createSession({ workspaceCwd: session.cwd });
    const tools = await client.getSessionTools(created.sessionId);
    const readTool = tools.tools.find((tool) => tool.name === "read");

    expect(readTool?.definition).toBeTruthy();
    expect(readTool.definition?.name).toBe("read");
    expect(readTool.definition?.label).toBe("read");
  } finally {
    await remote.dispose();
  }
});

timedTest("remote session supports compact bash and navigateTree", async () => {
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
      cwd: session.cwd,
    });

    const compactResult = await runtime.session.compact("focus");
    expect(compactResult.summary).toBe("focus");
    expect(session.compactCalls).toEqual(["focus"]);

    runtime.session.abortCompaction();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(session.abortCompactionCalls).toBe(1);

    const bashResult = await runtime.session.executeBash("pwd", undefined, {
      excludeFromContext: true,
    });
    expect(bashResult.output).toBe("ran:pwd");
    expect(session.bashCalls).toEqual([{ command: "pwd", options: { excludeFromContext: true } }]);

    runtime.session.abortBash();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(session.abortBashCalls).toBe(1);

    const navigateResult = await runtime.session.navigateTree("entry-123", {
      summarize: true,
      customInstructions: "sum",
      replaceInstructions: true,
      label: "branch",
    });
    expect(navigateResult.cancelled).toBe(false);
    expect(navigateResult.editorText).toBe("navigated:entry-123");
    expect(navigateResult.summaryEntry).toMatchObject({
      type: "branch_summary",
      id: "summary-1",
      summary: "summary-1",
    });
    expect(session.navigateTreeCalls).toEqual([
      {
        targetId: "entry-123",
        summarize: true,
        customInstructions: "sum",
        replaceInstructions: true,
        label: "branch",
      },
    ]);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote abort failures surface to session error state", async () => {
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

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const client = (
      runtime.session as unknown as {
        client: {
          abortBash: (sessionId: string) => Promise<unknown>;
          abortCompaction: (sessionId: string) => Promise<unknown>;
        };
        sessionId: string;
      }
    ).client;

    client.abortBash = async () => {
      throw new Error("remote bash abort failed");
    };
    client.abortCompaction = async () => {
      throw new Error("remote compaction abort failed");
    };

    runtime.session.abortBash();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runtime.session.state.errorMessage).toBe("remote bash abort failed");

    runtime.session.abortCompaction();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runtime.session.state.errorMessage).toBe("remote compaction abort failed");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote bash execute honors timeout from api request", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const cwd = await mkdtemp(join(tmpdir(), "pi-remote-bash-timeout-"));

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory(),
  });

  try {
    const client = new RemoteApiClient({
      origin: "http://localhost:3000",
      auth: { keyId: "dev", privateKey: privateKeyPem },
      fetchImpl: createInProcessFetch(remote.app),
    });
    await client.authenticate();
    const { sessionId } = await client.createSession({ workspaceCwd: cwd });

    await expect(
      client.executeBash(sessionId, {
        command: "sleep 1",
        timeout: 0.1,
      }),
    ).rejects.toThrow(/Command timed out after 0.1 seconds/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await remote.dispose();
  }
});

timedTest("remote executeBash streams durable chunks to client callback", async () => {
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

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const chunks: string[] = [];
    const bashPromise = runtime.session.executeBash("pwd", (chunk) => {
      chunks.push(chunk);
    });

    await waitForValue(
      () => chunks.length,
      (chunkCount) => chunkCount > 0,
      20,
      5,
    );

    expect(chunks).toEqual(["ran:"]);

    const bashResult = await bashPromise;

    expect(bashResult.output).toBe("ran:pwd");
    expect(chunks).toEqual(["ran:", "pwd"]);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote bash stream state is visible to all attached clients", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtimeA: RemoteAgentSessionRuntime | undefined;
  let runtimeB: RemoteAgentSessionRuntime | undefined;
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

    runtimeA = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });
    runtimeB = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const bashPromise = runtimeA.session.executeBash("pwd");

    await waitForValue(
      () => runtimeB.session.getActiveBashExecutions(),
      (activeExecutions) => activeExecutions.length > 0 && activeExecutions[0]?.output === "ran:",
      20,
      5,
    );

    const activeExecutions = runtimeB.session.getActiveBashExecutions();
    expect(activeExecutions.length).toBe(1);
    expect(activeExecutions[0]?.command).toBe("pwd");
    expect(activeExecutions[0]?.output).toBe("ran:");

    await bashPromise;

    await waitForValue(
      () => runtimeB.session.getActiveBashExecutions().length,
      (activeExecutionCount) => activeExecutionCount === 0,
      20,
      5,
    );

    expect(runtimeB.session.getActiveBashExecutions()).toEqual([]);
  } finally {
    await runtimeA?.dispose();
    await runtimeB?.dispose();
    await remote.dispose();
  }
});

timedTest("remote compact does not replay client extension reload lifecycle", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  const lifecycleEvents: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (event) => {
      lifecycleEvents.push(`start:${event.reason}`);
    });
    pi.on("session_shutdown", (event) => {
      lifecycleEvents.push(`shutdown:${event.reason}`);
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
          id: "test-compact-lifecycle",
          runtime: "client",
          path: "client:test-compact-lifecycle",
        },
      ],
      clientExtensionFactories: [extension],
    });

    await runtime.session.bindExtensions({});
    expect(lifecycleEvents).toEqual(["start:startup"]);

    await runtime.session.compact("focus");

    expect(lifecycleEvents).toEqual(["start:startup"]);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote recordBashResult mirrors local immediate and pending semantics", async () => {
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

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    runtime.session.recordBashResult(
      "pwd",
      {
        output: "ran:pwd",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
      { excludeFromContext: true },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(session.recordedBashResults).toEqual([
      {
        command: "pwd",
        result: {
          output: "ran:pwd",
          exitCode: 0,
          cancelled: false,
          truncated: false,
        },
        options: { excludeFromContext: true },
      },
    ]);
    expect(runtime.session.hasPendingBashMessages).toBe(false);
    expect(
      runtime.session.messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "bashExecution",
      ),
    ).toBe(true);

    session.isStreaming = true;
    runtime.session.recordBashResult("ls", {
      output: "ran:ls",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(runtime.session.hasPendingBashMessages).toBe(true);
    expect(
      runtime.session.messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "bashExecution",
      ).length,
    ).toBe(1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote deferred bash message flushes before next prompt for all clients", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new AgentLifecyclePromptSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtimeA: RemoteAgentSessionRuntime | undefined;
  let runtimeB: RemoteAgentSessionRuntime | undefined;
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

    runtimeA = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });
    runtimeB = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    session.isStreaming = true;
    runtimeA.session.recordBashResult("ls", {
      output: "ran:ls",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(runtimeA.session.hasPendingBashMessages).toBe(true);
    expect(runtimeB.session.hasPendingBashMessages).toBe(true);

    session.isStreaming = false;
    (runtimeA.session as unknown as { state: { isStreaming: boolean } }).state.isStreaming = false;
    (runtimeB.session as unknown as { state: { isStreaming: boolean } }).state.isStreaming = false;
    await runtimeA.session.prompt("next turn");

    const streamEvents = await waitForValue(
      () => readSessionEvents(remote.app, token, created.sessionId, "-1", 1_000),
      (value) => value.events.some((event) => event.kind === "bash_flush"),
      20,
      25,
    );
    const flushEvent = streamEvents.events.find((event) => event.kind === "bash_flush");
    expect(flushEvent).toBeTruthy();
    expect(flushEvent.payload.messages.length).toBe(1);
    expect(flushEvent.payload.messages[0]?.role).toBe("bashExecution");
    expect(flushEvent.payload.messages[0]?.command).toBe("ls");
    expect(flushEvent.payload.messages[0]?.output).toBe("ran:ls");

    await waitForValue(
      () => ({
        bashCount: runtimeB.session.messages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "role" in message &&
            message.role === "bashExecution",
        ).length,
        hasPendingBashMessages: runtimeB.session.hasPendingBashMessages,
      }),
      (value) => value.bashCount > 0 && value.hasPendingBashMessages === false,
      60,
      5,
    );

    expect(runtimeA.session.hasPendingBashMessages).toBe(false);
    expect(runtimeB.session.hasPendingBashMessages).toBe(false);
    const runtimeABashMessages = runtimeA.session.messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "bashExecution",
    );
    const runtimeBBashMessages = runtimeB.session.messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "bashExecution",
    );
    expect(runtimeABashMessages.length).toBe(1);
    expect(runtimeBBashMessages.length).toBe(1);
    expect((runtimeABashMessages[0] as { command: string }).command).toBe("ls");
    expect((runtimeBBashMessages[0] as { command: string }).command).toBe("ls");
  } finally {
    await runtimeA?.dispose();
    await runtimeB?.dispose();
    await remote.dispose();
  }
});

timedTest("remote abort surfaces transport failures to session error state", async () => {
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

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const client = (
      runtime.session as unknown as {
        client: { abortBash: () => Promise<void>; abortCompaction: () => Promise<void> };
      }
    ).client;
    client.abortBash = async () => {
      throw new Error("abort bash denied");
    };
    runtime.session.abortBash();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runtime.session.state.errorMessage ?? "").toMatch(/abort bash denied/);

    client.abortCompaction = async () => {
      throw new Error("abort compaction denied");
    };
    runtime.session.abortCompaction();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runtime.session.state.errorMessage ?? "").toMatch(/abort compaction denied/);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("refreshForkMessages keeps cached entries on transient failure", async () => {
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

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    (
      runtime.session as unknown as {
        forkMessages: Array<{ entryId: string; text: string }>;
        client: { getSessionForkMessages: (sessionId: string) => Promise<unknown> };
      }
    ).forkMessages = [{ entryId: "entry-1", text: "cached" }];

    const client = (
      runtime.session as unknown as {
        client: { getSessionForkMessages: (sessionId: string) => Promise<unknown> };
      }
    ).client;
    client.getSessionForkMessages = async () => {
      throw new Error("temporary failure");
    };

    await (
      runtime.session as unknown as { refreshForkMessages: () => Promise<void> }
    ).refreshForkMessages();

    expect(runtime.session.getUserMessagesForForking()).toEqual([
      { entryId: "entry-1", text: "cached" },
    ]);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote snapshot and reload stream include server modes", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const cwd = await mkdtemp(join(tmpdir(), "pi-remote-modes-"));

  const session = new RecordingSession();
  session.enableVersionedResources();
  session.cwd = cwd;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "modes.json"),
      JSON.stringify(
        {
          version: 1,
          currentMode: "builder",
          modes: {
            builder: {
              provider: "pi-remote-faux",
              modelId: "pi-remote-faux-1",
              thinkingLevel: "medium",
            },
          },
        },
        null,
        2,
      ),
    );

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
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      resources?: {
        modes?: {
          currentMode?: string;
          modes: Record<string, { provider?: string; modelId?: string }>;
        };
      };
      lastSessionStreamOffset: string;
    };

    expect(snapshot.resources?.modes?.currentMode).toBe("builder");
    expect(snapshot.resources?.modes?.modes.builder?.provider).toBe("pi-remote-faux");

    await writeFile(
      join(cwd, ".pi", "modes.json"),
      JSON.stringify(
        {
          version: 1,
          currentMode: "reviewer",
          modes: {
            reviewer: {
              provider: "pi-remote-faux",
              modelId: "pi-remote-faux-1",
              thinkingLevel: "high",
            },
          },
        },
        null,
        2,
      ),
    );

    const reloadResponse = await remote.app.request(`/v1/sessions/${created.sessionId}/reload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reloadResponse.status).toBe(200);

    const replayResponse = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(snapshot.lastSessionStreamOffset)}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(replayResponse.status).toBe(200);
    const replay = (await replayResponse.json()) as {
      events: Array<{
        kind: string;
        payload: {
          patch?: {
            resources?: {
              modes?: {
                currentMode?: string;
                modes: Record<string, { thinkingLevel?: string }>;
              };
            };
          };
        };
      }>;
    };

    expect(
      replay.events.some(
        (event) =>
          event.kind === "session_state_patch" &&
          event.payload.patch?.resources?.modes?.currentMode === "reviewer" &&
          event.payload.patch.resources.modes.modes.reviewer?.thinkingLevel === "high",
      ),
    ).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await remote.dispose();
  }
});

timedTest("remote slash mode command persists on server and emits resources patch", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const cwd = await mkdtemp(join(tmpdir(), "pi-remote-mode-command-"));

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory(),
  });

  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "modes.json"),
      JSON.stringify(
        {
          version: 1,
          currentMode: "builder",
          modes: {
            builder: {
              provider: "pi-remote-faux",
              modelId: "pi-remote-faux-1",
              thinkingLevel: "medium",
            },
            reviewer: {
              provider: "pi-remote-faux",
              modelId: "pi-remote-faux-1",
              thinkingLevel: "high",
            },
          },
        },
        null,
        2,
      ),
    );

    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceCwd: cwd }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as { lastSessionStreamOffset: string };

    const modeResponse = await remote.app.request(`/v1/sessions/${created.sessionId}/prompt`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "/mode reviewer" }),
    });
    expect(modeResponse.status).toBe(202);

    const updatedSnapshot = await waitForValue(
      async () => {
        const updatedSnapshotResponse = await remote.app.request(
          `/v1/sessions/${created.sessionId}/snapshot`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        expect(updatedSnapshotResponse.status).toBe(200);
        return (await updatedSnapshotResponse.json()) as {
          resources?: {
            modes?: {
              currentMode?: string;
            };
          };
        };
      },
      (value) => value.resources?.modes?.currentMode === "reviewer",
    );

    expect(updatedSnapshot.resources?.modes?.currentMode).toBe("reviewer");

    const persisted = await waitForValue(
      async () => {
        return JSON.parse(await readFile(join(cwd, ".pi", "modes.json"), "utf8")) as {
          currentMode?: string;
        };
      },
      (value) => value.currentMode === "reviewer",
    );
    expect(persisted.currentMode).toBe("reviewer");

    const replayResponse = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(snapshot.lastSessionStreamOffset)}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(replayResponse.status).toBe(200);
    const replay = (await replayResponse.json()) as {
      events: Array<{
        kind: string;
        payload: {
          patch?: {
            resources?: {
              modes?: {
                currentMode?: string;
              };
            };
          };
        };
      }>;
    };

    expect(
      replay.events.some(
        (event) =>
          event.kind === "session_state_patch" &&
          event.payload.patch?.resources?.modes?.currentMode === "reviewer",
      ),
    ).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await remote.dispose();
  }
});

timedTest(
  "remote reload refreshes server resources and replays client extension lifecycle",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    const session = new RecordingSession();
    session.enableVersionedResources();
    const events: string[] = [];
    const eventRecorderExtension: ExtensionFactory = (pi) => {
      pi.on("session_start", (event) => {
        events.push(`start:${event.reason}`);
      });
      pi.on("session_shutdown", () => {
        events.push("shutdown");
      });
    };

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
        clientExtensionFactories: [eventRecorderExtension],
      });

      await runtime.session.bindExtensions({});

      const initialExtensions = runtime.services.resourceLoader.getExtensions().extensions;
      const initialSkills = runtime.services.resourceLoader.getSkills().skills;
      const initialPrompts = runtime.services.resourceLoader.getPrompts().prompts;
      const initialThemes = runtime.services.resourceLoader.getThemes().themes;

      expect(session.reloadCalls).toBe(0);
      expect(initialExtensions[0]?.path).toBe("extension-v1");
      expect(initialSkills[0]?.name).toBe("skill-v1");
      expect(initialPrompts[0]?.name).toBe("prompt-v1");
      expect(initialThemes[0]?.name).toBe("dark");
      expect(initialSkills.length).toBe(1);
      expect(initialPrompts.length).toBe(1);
      expect(initialThemes.length).toBe(1);
      expect(events).toEqual(["start:startup"]);

      await runtime.session.reload();

      const reloadedExtensions = runtime.services.resourceLoader.getExtensions().extensions;
      const reloadedSkills = runtime.services.resourceLoader.getSkills().skills;
      const reloadedPrompts = runtime.services.resourceLoader.getPrompts().prompts;
      const reloadedThemes = runtime.services.resourceLoader.getThemes().themes;

      expect(session.reloadCalls).toBe(1);
      expect(reloadedExtensions[0]?.path).toBe("extension-v2");
      expect(reloadedSkills[0]?.name).toBe("skill-v2");
      expect(reloadedPrompts[0]?.name).toBe("prompt-v2");
      expect(reloadedThemes[0]?.name).toBe("light");
      expect(reloadedSkills.length).toBe(1);
      expect(reloadedPrompts.length).toBe(1);
      expect(reloadedThemes.length).toBe(1);
      expect(events).toEqual(["start:startup", "shutdown", "start:reload"]);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest(
  "remote runtime session exposes server prompt templates before and after reload",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    const session = new RecordingSession();
    session.enableVersionedResources();

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

      expect(runtime.session.promptTemplates.length).toBe(1);
      expect(runtime.session.promptTemplates[0]?.name).toBe("prompt-v1");

      await runtime.session.reload();

      expect(runtime.session.promptTemplates.length).toBe(1);
      expect(runtime.session.promptTemplates[0]?.name).toBe("prompt-v2");
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("reload rejects while queued commands are still pending", async () => {
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

    await expect(registry.reload(created.sessionId, auth, "conn-a")).rejects.toThrow(
      /Wait for queued commands to finish before reloading\./,
    );

    expect(session.reloadCalls).toBe(0);
  } finally {
    session.releasePrompt();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await registry.dispose();
  }
});

timedTest("in-memory runtime factory preserves explicit null fauxApiKey", async () => {
  const defaultFactory = InMemoryPiRuntimeFactory();
  const defaultRuntime = await defaultFactory.create();
  const defaultKey = await defaultRuntime.services.authStorage.getApiKey("pi-remote-faux");

  expect(defaultKey).toBe("pi-remote-faux-local-key");

  await defaultRuntime.dispose();
  await defaultFactory.dispose();

  const nullFactory = InMemoryPiRuntimeFactory({
    fauxApiKey: null,
  });
  const nullRuntime = await nullFactory.create();
  const nullKey = await nullRuntime.services.authStorage.getApiKey("pi-remote-faux");

  expect(nullKey).toBe(undefined);

  await nullRuntime.dispose();
  await nullFactory.dispose();
});
