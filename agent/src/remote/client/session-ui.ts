import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { ExtensionUiRequestEventPayload } from "../schemas.js";
import { RemoteApiClient } from "../remote-api-client.js";

type SelectUiRequest = Extract<ExtensionUiRequestEventPayload, { method: "select" }>;
type ConfirmUiRequest = Extract<ExtensionUiRequestEventPayload, { method: "confirm" }>;
type InputUiRequest = Extract<ExtensionUiRequestEventPayload, { method: "input" }>;
type EditorUiRequest = Extract<ExtensionUiRequestEventPayload, { method: "editor" }>;

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
  if (request.method === "setWorkingIndicator") {
    uiContext.setWorkingIndicator(request.options);
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
  pendingInteractiveRequests: Map<string, AbortController>;
}): Promise<void> {
  if (input.request.method === "select") {
    await postSelectUiResponse(
      input.uiContext,
      input.client,
      input.sessionId,
      input.request,
      input.pendingInteractiveRequests,
    );
    return;
  }

  if (input.request.method === "confirm") {
    await postConfirmUiResponse(
      input.uiContext,
      input.client,
      input.sessionId,
      input.request,
      input.pendingInteractiveRequests,
    );
    return;
  }

  if (input.request.method === "input") {
    await postInputUiResponse(
      input.uiContext,
      input.client,
      input.sessionId,
      input.request,
      input.pendingInteractiveRequests,
    );
    return;
  }

  if (input.request.method === "editor") {
    await postEditorUiResponse(
      input.uiContext,
      input.client,
      input.sessionId,
      input.request,
      input.pendingInteractiveRequests,
    );
  }
}

async function postSelectUiResponse(
  uiContext: ExtensionUIContext,
  client: RemoteApiClient,
  sessionId: string,
  request: SelectUiRequest,
  pendingInteractiveRequests: Map<string, AbortController>,
): Promise<void> {
  const id = request.id;
  const abortController = new AbortController();
  pendingInteractiveRequests.set(id, abortController);
  try {
    const value = await uiContext.select(request.title, request.options, {
      timeout: request.timeout,
      signal: abortController.signal,
    });
    await client.postUiResponse(
      sessionId,
      value === undefined ? { id, cancelled: true } : { id, value },
    );
  } finally {
    pendingInteractiveRequests.delete(id);
  }
}

async function postConfirmUiResponse(
  uiContext: ExtensionUIContext,
  client: RemoteApiClient,
  sessionId: string,
  request: ConfirmUiRequest,
  pendingInteractiveRequests: Map<string, AbortController>,
): Promise<void> {
  const abortController = new AbortController();
  pendingInteractiveRequests.set(request.id, abortController);
  try {
    const confirmed = await uiContext.confirm(request.title, request.message, {
      timeout: request.timeout,
      signal: abortController.signal,
    });
    await client.postUiResponse(sessionId, { id: request.id, confirmed });
  } finally {
    pendingInteractiveRequests.delete(request.id);
  }
}

async function postInputUiResponse(
  uiContext: ExtensionUIContext,
  client: RemoteApiClient,
  sessionId: string,
  request: InputUiRequest,
  pendingInteractiveRequests: Map<string, AbortController>,
): Promise<void> {
  const id = request.id;
  const abortController = new AbortController();
  pendingInteractiveRequests.set(id, abortController);
  try {
    const value = await uiContext.input(request.title, request.placeholder, {
      timeout: request.timeout,
      signal: abortController.signal,
    });
    await client.postUiResponse(
      sessionId,
      value === undefined ? { id, cancelled: true } : { id, value },
    );
  } finally {
    pendingInteractiveRequests.delete(id);
  }
}

async function postEditorUiResponse(
  uiContext: ExtensionUIContext,
  client: RemoteApiClient,
  sessionId: string,
  request: EditorUiRequest,
  pendingInteractiveRequests: Map<string, AbortController>,
): Promise<void> {
  const id = request.id;
  const abortController = new AbortController();
  pendingInteractiveRequests.set(id, abortController);
  try {
    const value = await uiContext.editor(request.title, request.prefill);
    if (abortController.signal.aborted) {
      return;
    }
    await client.postUiResponse(
      sessionId,
      value === undefined ? { id, cancelled: true } : { id, value },
    );
  } finally {
    pendingInteractiveRequests.delete(id);
  }
}

export async function handleRemoteUiRequest(input: {
  uiContext: ExtensionUIContext;
  request: ExtensionUiRequestEventPayload;
  client: RemoteApiClient;
  sessionId: string;
  pendingInteractiveRequests: Map<string, AbortController>;
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
    input.pendingInteractiveRequests.delete(input.request.id);
  }
}

export function cancelRemoteUiRequest(
  pendingInteractiveRequests: Map<string, AbortController>,
  requestId: string,
): void {
  const controller = pendingInteractiveRequests.get(requestId);
  if (!controller) {
    return;
  }
  controller.abort();
  pendingInteractiveRequests.delete(requestId);
}
