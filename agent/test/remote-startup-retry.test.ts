import {
  RecordingRuntimeFactory,
  RecordingSession,
  RemoteAgentSessionRuntime,
  TEST_ED25519_KEYS,
  authenticate,
  createInProcessFetch,
  createRemoteApp,
  expect,
  test,
} from "./remote-adapter.shared.ts";

test("remote bind retries transient tool catalog fetch failures", async () => {
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

    const baseFetch = createInProcessFetch(remote.app);
    let failedToolsFetch = false;

    runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      sessionId: created.sessionId,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (!failedToolsFetch && url.includes(`/v1/sessions/${created.sessionId}/tools`)) {
          failedToolsFetch = true;
          throw new TypeError("fetch failed");
        }
        return baseFetch(input, init);
      },
    });

    await runtime.session.bindExtensions({});

    expect(failedToolsFetch).toBe(true);
    expect(runtime.session.getActiveToolNames().length > 0).toBeTruthy();
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});
