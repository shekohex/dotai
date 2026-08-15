import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { defaultSettings } from "../src/default-settings.js";
import {
  _test as liteLLMResponsesTest,
  streamLiteLLMOpenAIResponses,
} from "../src/extensions/litellm/openai-responses.js";
import { createLiteLLMProviderRegistrations } from "../src/extensions/litellm.js";
import { isUnknownRecord, parseUnknownJson } from "../src/utils/unknown-value.js";

function responseEvents(responseId: string, messageId: string, model: string, text: string) {
  const item = {
    type: "message",
    id: messageId,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
    status: "completed",
  };
  return [
    {
      type: "response.created",
      response: { id: responseId, status: "in_progress", model },
    },
    {
      type: "response.output_item.added",
      item: { ...item, content: [], status: "in_progress" },
      output_index: 0,
    },
    {
      type: "response.content_part.added",
      part: { type: "output_text", text: "", annotations: [] },
      item_id: messageId,
      output_index: 0,
      content_index: 0,
    },
    {
      type: "response.output_text.delta",
      delta: text,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
    },
    {
      type: "response.output_text.done",
      text,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
    },
    { type: "response.output_item.done", item, output_index: 0 },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        model,
        output: [item],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
    },
  ];
}

describe("LiteLLM OpenAI Responses provider", () => {
  it("registers the custom Responses stream", () => {
    const registration = createLiteLLMProviderRegistrations(
      {
        healthy: true,
        label: "test",
        baseUrl: "https://litellm.example.test/v1",
      },
      "TEST_KEY",
    ).find((candidate) => candidate.provider === "codex-openai");

    expect(registration?.config.streamSimple).toBe(streamLiteLLMOpenAIResponses);
  });

  it("uses cached WebSockets by default", () => {
    expect(defaultSettings.transport).toBe("auto");
  });

  it("adds the selected model to the LiteLLM WebSocket URL", () => {
    expect(
      liteLLMResponsesTest.resolveWebSocketUrl(
        "https://litellm.example.test/v1/responses",
        "gpt-5.6-sol",
      ),
    ).toBe("wss://litellm.example.test/v1/responses?model=gpt-5.6-sol");
  });

  it("preserves existing query parameters when adding the model", () => {
    expect(
      liteLLMResponsesTest.resolveWebSocketUrl(
        "http://127.0.0.1:4000/v1/responses?route=codex",
        "gpt-5.6 luna",
      ),
    ).toBe("ws://127.0.0.1:4000/v1/responses?route=codex&model=gpt-5.6+luna");
  });

  it("builds a previous-response delta when context extends the cached turn", () => {
    const previousUser = { role: "user", content: [{ type: "input_text", text: "first" }] };
    const previousAssistant = {
      type: "message",
      role: "assistant",
      id: "msg_1",
      status: "completed",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    };
    const nextUser = { role: "user", content: [{ type: "input_text", text: "second" }] };
    const previousBody = { model: "gpt-5.6-sol", input: [previousUser], store: false };
    const nextBody = {
      model: "gpt-5.6-sol",
      input: [previousUser, previousAssistant, nextUser],
      store: false,
    };

    expect(
      liteLLMResponsesTest.buildCachedRequestBody(
        {
          lastRequestBody: previousBody,
          lastResponseId: "resp_1",
          lastResponseItems: [previousAssistant],
        },
        nextBody,
      ),
    ).toEqual({
      model: "gpt-5.6-sol",
      input: [nextUser],
      previous_response_id: "resp_1",
      store: false,
    });
  });

  it("sends full context when cached request configuration changes", () => {
    const previousBody = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "first" }],
      store: false,
      service_tier: "auto",
    };
    const nextBody = {
      ...previousBody,
      input: [...previousBody.input, { role: "user", content: "second" }],
      service_tier: "priority",
    };

    expect(
      liteLLMResponsesTest.buildCachedRequestBody(
        {
          lastRequestBody: previousBody,
          lastResponseId: "resp_1",
          lastResponseItems: [],
        },
        nextBody,
      ),
    ).toBe(nextBody);
  });

  it("normalizes WebSocket handshake headers", () => {
    const headers: ProviderHeaders = {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
      Connection: "keep-alive",
      originator: "codex_cli_rs",
    };

    expect(liteLLMResponsesTest.webSocketHeaders(headers)).toEqual({
      Authorization: "Bearer secret",
      originator: "codex_cli_rs",
    });
  });

  it("reuses a LiteLLM socket and sends cached continuation deltas", async () => {
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    const requests: Record<string, unknown>[] = [];
    const upgradeHeaders: Array<{ originator?: string; routingHint?: string; url?: string }> = [];
    let connections = 0;

    server.on("upgrade", (request, socket, head) => {
      upgradeHeaders.push({
        originator: request.headers.originator,
        routingHint: request.headers["x-codex-routing-hint"],
        url: request.url,
      });
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", (socket) => {
      connections += 1;
      socket.on("message", (data) => {
        const parsed = parseUnknownJson(data.toString());
        if (!isUnknownRecord(parsed)) throw new Error("Expected Responses request object");
        requests.push(parsed);
        const requestNumber = requests.length;
        for (const event of responseEvents(
          `resp_${requestNumber}`,
          `msg_${requestNumber}`,
          "gpt-5.6-sol",
          requestNumber === 1
            ? "first answer"
            : requestNumber === 2
              ? "second answer"
              : "third answer",
        )) {
          socket.send(JSON.stringify(event));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    const builtin = getBuiltinModels("openai-codex").find(
      (candidate) => candidate.id === "gpt-5.6-sol",
    );
    if (builtin === undefined) throw new Error("Missing gpt-5.6-sol model");
    const model: Model<"openai-responses"> = {
      ...builtin,
      provider: "codex-openai",
      api: "openai-responses",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    };

    try {
      const firstUser = { role: "user" as const, content: "first" };
      const firstAssistant = await streamLiteLLMOpenAIResponses(
        model,
        { messages: [firstUser] },
        {
          apiKey: "TEST_KEY",
          transport: "auto",
          sessionId: "litellm-websocket-test",
          headers: {
            originator: "codex_cli_rs",
            "x-codex-routing-hint": "model=gpt-5.6-sol;tier=priority",
          },
        },
      ).result();
      const secondAssistant = await streamLiteLLMOpenAIResponses(
        model,
        {
          messages: [firstUser, firstAssistant, { role: "user", content: "second" }],
        },
        {
          apiKey: "TEST_KEY",
          transport: "auto",
          sessionId: "litellm-websocket-test",
          headers: {
            originator: "codex_cli_rs",
            "x-codex-routing-hint": "model=gpt-5.6-sol;tier=priority",
          },
        },
      ).result();
      const thirdAssistant = await streamLiteLLMOpenAIResponses(
        model,
        {
          messages: [
            firstUser,
            firstAssistant,
            { role: "user", content: "second" },
            secondAssistant,
            { role: "user", content: "third" },
          ],
        },
        {
          apiKey: "TEST_KEY",
          transport: "auto",
          sessionId: "litellm-websocket-test",
          headers: { originator: "codex_cli_rs" },
        },
      ).result();

      expect(firstAssistant.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "first answer" }),
      );
      expect(secondAssistant.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "second answer" }),
      );
      expect(thirdAssistant.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "third answer" }),
      );
      expect(connections).toBe(2);
      expect(upgradeHeaders).toEqual([
        {
          originator: "codex_cli_rs",
          routingHint: "model=gpt-5.6-sol;tier=priority",
          url: "/v1/responses?model=gpt-5.6-sol",
        },
        {
          originator: "codex_cli_rs",
          routingHint: undefined,
          url: "/v1/responses?model=gpt-5.6-sol",
        },
      ]);
      expect(requests[0]?.type).toBe("response.create");
      expect(requests[0]?.previous_response_id).toBeUndefined();
      expect(requests[1]?.previous_response_id).toBe("resp_1");
      expect(requests[1]?.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "second" }] },
      ]);
      expect(requests[2]?.previous_response_id).toBeUndefined();
    } finally {
      liteLLMResponsesTest.closeWebSocketSessions("litellm-websocket-test");
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("keeps SSE fallback sticky for the session after WebSocket handshake failure", async () => {
    let upgradeAttempts = 0;
    let httpRequests = 0;
    const server = createServer((_request, response) => {
      httpRequests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of responseEvents(
        `resp_http_${httpRequests}`,
        `msg_http_${httpRequests}`,
        "gpt-5.6-sol",
        `SSE answer ${httpRequests}`,
      )) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
    server.on("upgrade", (_request, socket) => {
      upgradeAttempts += 1;
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    const builtin = getBuiltinModels("openai-codex").find(
      (candidate) => candidate.id === "gpt-5.6-sol",
    );
    if (builtin === undefined) throw new Error("Missing gpt-5.6-sol model");
    const model: Model<"openai-responses"> = {
      ...builtin,
      provider: "codex-openai",
      api: "openai-responses",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    };
    const sessionId = "litellm-sse-fallback-test";

    try {
      for (const prompt of ["first", "second"]) {
        const message = await streamLiteLLMOpenAIResponses(
          model,
          { messages: [{ role: "user", content: prompt }] },
          { apiKey: "TEST_KEY", transport: "auto", sessionId },
        ).result();
        expect(message.content).toContainEqual(
          expect.objectContaining({ type: "text", text: `SSE answer ${httpRequests}` }),
        );
      }
      expect(upgradeAttempts).toBe(1);
      expect(httpRequests).toBe(2);
    } finally {
      liteLLMResponsesTest.closeWebSocketSessions(sessionId);
      liteLLMResponsesTest.resetWebSocketDebugStats(sessionId);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
