import { randomUUID } from "node:crypto";
import type { WorkingIndicatorOptions } from "@mariozechner/pi-coding-agent";
import type { RemoteUiStatusHandlers } from "./types.js";
import type { RemoteUiContextInput } from "./ui-context-types.js";

export function createRemoteUiStatusHandlers(input: RemoteUiContextInput): RemoteUiStatusHandlers {
  return {
    notify: (message, notifyType) => {
      publishRemoteUiNotify(input, message, notifyType);
    },
    onTerminalInput: () => {
      throw new Error(
        "ctx.ui.onTerminalInput() is not supported in remote server runtime. Run terminal handlers on client runtime.",
      );
    },
    setStatus: (statusKey, statusText) => {
      publishRemoteUiStatus(input, statusKey, statusText);
    },
    setWorkingMessage: (message) => {
      publishRemoteUiWorkingMessage(input, message);
    },
    setWorkingIndicator: (options) => {
      publishRemoteUiWorkingIndicator(input, options);
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
    getToolsExpanded: () => {
      throw new Error(
        "ctx.ui.getToolsExpanded() is not supported in remote server runtime. Track tools panel state on client runtime.",
      );
    },
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
  statusKey: string,
  statusText: string | undefined,
): void {
  const currentStatus = input.record.uiState.statuses.get(statusKey);
  if (currentStatus === statusText) {
    return;
  }
  input.record.uiState.statuses.set(statusKey, statusText);
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
  if (input.record.uiState.workingMessage === message) {
    return;
  }
  input.record.uiState.workingMessage = message;
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
  if (input.record.uiState.hiddenThinkingLabel === label) {
    return;
  }
  input.record.uiState.hiddenThinkingLabel = label;
  input.publishUiEvent(input.record, {
    id: randomUUID(),
    method: "setHiddenThinkingLabel",
    ...(label === undefined ? {} : { label }),
  });
}

function publishRemoteUiWorkingIndicator(
  input: RemoteUiContextInput,
  options: WorkingIndicatorOptions | undefined,
): void {
  input.publishUiEvent(input.record, {
    id: randomUUID(),
    method: "setWorkingIndicator",
    ...(options === undefined ? {} : { options }),
  });
}

function publishRemoteUiWidget(
  input: RemoteUiContextInput,
  widgetKey: string,
  content: unknown,
  options: unknown,
): void {
  if (typeof content === "function") {
    throw new TypeError(
      "ctx.ui.setWidget() function content is not supported in remote server runtime. Send string[] widget lines or move widget rendering to client runtime.",
    );
  }
  if (content !== undefined && !Array.isArray(content)) {
    throw new TypeError("ctx.ui.setWidget() expects string[] content in remote server runtime");
  }
  const placement = readWidgetPlacement(options);
  const widgetLines = readWidgetLines(content);
  const previousWidget = input.record.uiState.widgets.get(widgetKey);
  if (
    previousWidget?.placement === placement &&
    areWidgetLinesEqual(previousWidget?.lines, widgetLines)
  ) {
    return;
  }
  input.record.uiState.widgets.set(widgetKey, {
    lines: widgetLines,
    placement,
  });
  input.publishUiEvent(input.record, {
    id: randomUUID(),
    method: "setWidget",
    widgetKey,
    widgetLines,
    ...(placement ? { widgetPlacement: placement } : {}),
  });
}

function readWidgetLines(content: unknown): string[] | undefined {
  if (content === undefined) {
    return undefined;
  }
  if (!Array.isArray(content)) {
    throw new TypeError("ctx.ui.setWidget() expects string[] content in remote server runtime");
  }
  const widgetLines: string[] = [];
  for (const line of content) {
    if (typeof line !== "string") {
      throw new TypeError("ctx.ui.setWidget() expects string[] content in remote server runtime");
    }
    widgetLines.push(line);
  }
  return widgetLines;
}

function publishRemoteUiTitle(input: RemoteUiContextInput, title: string): void {
  if (input.record.uiState.title === title) {
    return;
  }
  input.record.uiState.title = title;
  input.publishUiEvent(input.record, { id: randomUUID(), method: "setTitle", title });
}

function publishRemoteUiToolsExpanded(input: RemoteUiContextInput, expanded: boolean): void {
  if (input.record.uiState.toolsExpanded === expanded) {
    return;
  }
  input.record.uiState.toolsExpanded = expanded;
  input.publishUiEvent(input.record, { id: randomUUID(), method: "setToolsExpanded", expanded });
}

function areWidgetLinesEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function readWidgetPlacement(options: unknown): "aboveEditor" | "belowEditor" | undefined {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return undefined;
  }

  const placement = "placement" in options ? options.placement : undefined;
  if (placement === "aboveEditor" || placement === "belowEditor") {
    return placement;
  }
  return undefined;
}
