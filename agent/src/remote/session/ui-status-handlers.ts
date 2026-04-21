import { randomUUID } from "node:crypto";
import type { RemoteUiRenderState, RemoteUiStatusHandlers } from "./types.js";
import type { RemoteUiContextInput } from "./ui-context-types.js";

export function createRemoteUiStatusHandlers(
  input: RemoteUiContextInput,
  renderState: RemoteUiRenderState,
): RemoteUiStatusHandlers {
  return {
    notify: (message, notifyType) => {
      publishRemoteUiNotify(input, message, notifyType);
    },
    onTerminalInput: () => () => {},
    setStatus: (statusKey, statusText) => {
      publishRemoteUiStatus(input, renderState, statusKey, statusText);
    },
    setWorkingMessage: (message) => {
      publishRemoteUiWorkingMessage(input, message);
    },
    setHiddenThinkingLabel: (label) => {
      publishRemoteUiHiddenThinkingLabel(input, label);
    },
    setWidget: (widgetKey, content, options) => {
      publishRemoteUiWidget(input, widgetKey, content, options);
    },
    setTitle: (title) => {
      publishRemoteUiTitle(input, title);
    },
    getToolsExpanded: () => true,
    setToolsExpanded: (expanded) => {
      publishRemoteUiToolsExpanded(input, expanded);
    },
  };
}

function publishRemoteUiNotify(
  input: RemoteUiContextInput,
  message: string,
  notifyType: "info" | "warning" | "error" | undefined,
): void {
  input.publishUiEvent(input.record, {
    id: randomUUID(),
    method: "notify",
    message,
    notifyType,
  });
}

function publishRemoteUiStatus(
  input: RemoteUiContextInput,
  renderState: RemoteUiRenderState,
  statusKey: string,
  statusText: string | undefined,
): void {
  if (statusText === undefined) {
    renderState.footerStatuses.delete(statusKey);
  } else {
    renderState.footerStatuses.set(statusKey, statusText);
  }
  if (renderState.footerComponent) {
    renderState.renderFooter();
  }
  input.publishUiEvent(input.record, {
    id: randomUUID(),
    method: "setStatus",
    statusKey,
    ...(statusText === undefined ? {} : { statusText }),
  });
}

function publishRemoteUiWorkingMessage(
  input: RemoteUiContextInput,
  message: string | undefined,
): void {
  input.publishUiEvent(input.record, {
    id: randomUUID(),
    method: "setWorkingMessage",
    ...(message === undefined ? {} : { message }),
  });
}

function publishRemoteUiHiddenThinkingLabel(
  input: RemoteUiContextInput,
  label: string | undefined,
): void {
  input.publishUiEvent(input.record, {
    id: randomUUID(),
    method: "setHiddenThinkingLabel",
    ...(label === undefined ? {} : { label }),
  });
}

function publishRemoteUiWidget(
  input: RemoteUiContextInput,
  widgetKey: string,
  content: unknown,
  options: unknown,
): void {
  const placement = readWidgetPlacement(options);
  input.publishUiEvent(input.record, {
    id: randomUUID(),
    method: "setWidget",
    widgetKey,
    widgetLines: Array.isArray(content) ? content : undefined,
    ...(placement ? { widgetPlacement: placement } : {}),
  });
}

function publishRemoteUiTitle(input: RemoteUiContextInput, title: string): void {
  input.publishUiEvent(input.record, { id: randomUUID(), method: "setTitle", title });
}

function publishRemoteUiToolsExpanded(input: RemoteUiContextInput, expanded: boolean): void {
  input.publishUiEvent(input.record, { id: randomUUID(), method: "setToolsExpanded", expanded });
}

function readWidgetPlacement(options: unknown): "aboveEditor" | "belowEditor" | undefined {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return undefined;
  }

  const placement: unknown = Reflect.get(options, "placement");
  if (placement === "aboveEditor" || placement === "belowEditor") {
    return placement;
  }
  return undefined;
}
