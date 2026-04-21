import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { ExtensionUiRequestEventPayload } from "../schemas.js";
import { RemoteApiClient } from "../remote-api-client.js";

type SelectUiRequest = Extract<ExtensionUiRequestEventPayload, { method: "select" }>;
type ConfirmUiRequest = Extract<ExtensionUiRequestEventPayload, { method: "confirm" }>;
type InputUiRequest = Extract<ExtensionUiRequestEventPayload, { method: "input" }>;
type EditorUiRequest = Extract<ExtensionUiRequestEventPayload, { method: "editor" }>;

function toUiLineComponentFactory(
  lines: string[] | undefined,
): (() => { render: () => string[]; invalidate: () => void }) | undefined {
  if (!lines) {
    return undefined;
  }
  const nextLines = [...lines];
  return () => ({
    render: () => [...nextLines],
    invalidate: () => {},
  });
}

function applyImmediateUiRequest(
  uiContext: ExtensionUIContext,
  request: ExtensionUiRequestEventPayload,
): boolean {
  if (request.method === "notify") {
    uiContext.notify(request.message, request.notifyType);
    return true;
  }
  if (request.method === "setStatus") {
    uiContext.setStatus(request.statusKey, request.statusText);
    return true;
  }
  if (request.method === "setWidget") {
    uiContext.setWidget(request.widgetKey, request.widgetLines, {
      placement: request.widgetPlacement,
    });
    return true;
  }
  if (request.method === "setWorkingMessage") {
    uiContext.setWorkingMessage(request.message);
    return true;
  }
  if (request.method === "setHiddenThinkingLabel") {
    uiContext.setHiddenThinkingLabel(request.label);
    return true;
  }
  if (request.method === "setTitle") {
    uiContext.setTitle(request.title);
    return true;
  }
  if (request.method === "setHeader") {
    uiContext.setHeader(toUiLineComponentFactory(request.lines));
    return true;
  }
  if (request.method === "setFooter") {
    uiContext.setFooter(toUiLineComponentFactory(request.lines));
    return true;
  }
  if (request.method === "setToolsExpanded") {
    uiContext.setToolsExpanded(request.expanded);
    return true;
  }
  if (request.method === "set_editor_text") {
    uiContext.setEditorText(request.text);
    return true;
  }
  return false;
}

async function applyInteractiveUiRequest(input: {
  uiContext: ExtensionUIContext;
  request: ExtensionUiRequestEventPayload;
  client: RemoteApiClient;
  sessionId: string;
}): Promise<void> {
  if (input.request.method === "select") {
    await postSelectUiResponse(input.uiContext, input.client, input.sessionId, input.request);
    return;
  }

  if (input.request.method === "confirm") {
    await postConfirmUiResponse(input.uiContext, input.client, input.sessionId, input.request);
    return;
  }

  if (input.request.method === "input") {
    await postInputUiResponse(input.uiContext, input.client, input.sessionId, input.request);
    return;
  }

  if (input.request.method === "editor") {
    await postEditorUiResponse(input.uiContext, input.client, input.sessionId, input.request);
  }
}

async function postSelectUiResponse(
  uiContext: ExtensionUIContext,
  client: RemoteApiClient,
  sessionId: string,
  request: SelectUiRequest,
): Promise<void> {
  const id = request.id;
  const value = await uiContext.select(request.title, request.options, {
    timeout: request.timeout,
  });
  await client.postUiResponse(
    sessionId,
    value === undefined ? { id, cancelled: true } : { id, value },
  );
}

async function postConfirmUiResponse(
  uiContext: ExtensionUIContext,
  client: RemoteApiClient,
  sessionId: string,
  request: ConfirmUiRequest,
): Promise<void> {
  const confirmed = await uiContext.confirm(request.title, request.message, {
    timeout: request.timeout,
  });
  await client.postUiResponse(sessionId, { id: request.id, confirmed });
}

async function postInputUiResponse(
  uiContext: ExtensionUIContext,
  client: RemoteApiClient,
  sessionId: string,
  request: InputUiRequest,
): Promise<void> {
  const id = request.id;
  const value = await uiContext.input(request.title, request.placeholder, {
    timeout: request.timeout,
  });
  await client.postUiResponse(
    sessionId,
    value === undefined ? { id, cancelled: true } : { id, value },
  );
}

async function postEditorUiResponse(
  uiContext: ExtensionUIContext,
  client: RemoteApiClient,
  sessionId: string,
  request: EditorUiRequest,
): Promise<void> {
  const id = request.id;
  const value = await uiContext.editor(request.title, request.prefill);
  await client.postUiResponse(
    sessionId,
    value === undefined ? { id, cancelled: true } : { id, value },
  );
}

export async function handleRemoteUiRequest(input: {
  uiContext: ExtensionUIContext;
  request: ExtensionUiRequestEventPayload;
  client: RemoteApiClient;
  sessionId: string;
}): Promise<void> {
  if (applyImmediateUiRequest(input.uiContext, input.request)) {
    return;
  }

  try {
    await applyInteractiveUiRequest(input);
  } catch {
    await input.client.postUiResponse(input.sessionId, {
      id: input.request.id,
      cancelled: true,
    });
  }
}
