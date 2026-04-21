import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import {
  initTheme,
  theme as defaultTheme,
} from "../../../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { isRenderableComponent } from "./helpers.js";
import type { RemoteUiRenderState } from "./types.js";
import type { RemoteUiContextInput } from "./ui-context-types.js";
import { createRemoteUiInputHandlers } from "./ui-input-handlers.js";
import { createRemoteUiStatusHandlers } from "./ui-status-handlers.js";

export function createRemoteUiContext(input: RemoteUiContextInput): ExtensionUIContext {
  const renderState = createRemoteUiRenderState(input);
  return {
    ...createRemoteUiInputHandlers(input),
    ...createRemoteUiStatusHandlers(input, renderState),
    ...createRemoteUiLayoutHandlers(input, renderState),
    ...createRemoteUiEditorHandlers(input),
    ...createRemoteUiThemeHandlers(renderState.theme),
  };
}

function createRemoteUiRenderState(input: RemoteUiContextInput): RemoteUiRenderState {
  initTheme(undefined, false);
  const theme = defaultTheme;
  const footerStatuses = new Map<string, string>();
  const footerData = {
    getGitBranch: () => null,
    getExtensionStatuses: () => footerStatuses,
    getAvailableProviderCount: () => 0,
    onBranchChange: () => () => {},
  };
  const renderWidth = 180;
  const state: RemoteUiRenderState = {
    theme,
    footerStatuses,
    footerData,
    headerComponent: undefined,
    footerComponent: undefined,
    renderHeader: () => {},
    renderFooter: () => {},
    tui: {
      requestRender: () => {},
    },
  };
  state.renderHeader = (): void => {
    input.publishUiEvent(input.record, {
      id: randomUUID(),
      method: "setHeader",
      ...(state.headerComponent ? { lines: state.headerComponent.render(renderWidth) } : {}),
    });
  };
  state.renderFooter = (): void => {
    input.publishUiEvent(input.record, {
      id: randomUUID(),
      method: "setFooter",
      ...(state.footerComponent ? { lines: state.footerComponent.render(renderWidth) } : {}),
    });
  };
  state.tui.requestRender = (): void => {
    state.renderHeader();
    state.renderFooter();
  };
  return state;
}

function createRemoteUiLayoutHandlers(
  _input: RemoteUiContextInput,
  renderState: RemoteUiRenderState,
): Pick<ExtensionUIContext, "setFooter" | "setHeader"> {
  return {
    setFooter: (factory) => {
      renderState.footerComponent?.dispose?.();
      renderState.footerComponent = undefined;
      if (typeof factory === "function") {
        const created: unknown = Reflect.apply(factory, undefined, [
          renderState.tui,
          renderState.theme,
          renderState.footerData,
        ]);
        if (isRenderableComponent(created)) {
          renderState.footerComponent = created;
        }
      }
      renderState.renderFooter();
    },
    setHeader: (factory) => {
      renderState.headerComponent?.dispose?.();
      renderState.headerComponent = undefined;
      if (typeof factory === "function") {
        const created: unknown = Reflect.apply(factory, undefined, [
          renderState.tui,
          renderState.theme,
        ]);
        if (isRenderableComponent(created)) {
          renderState.headerComponent = created;
        }
      }
      renderState.renderHeader();
    },
  };
}

function createRemoteUiEditorHandlers(
  input: RemoteUiContextInput,
): Pick<
  ExtensionUIContext,
  "pasteToEditor" | "setEditorText" | "getEditorText" | "setEditorComponent"
> {
  return {
    pasteToEditor: (text) => {
      input.publishUiEvent(input.record, { id: randomUUID(), method: "set_editor_text", text });
    },
    setEditorText: (text) => {
      input.publishUiEvent(input.record, { id: randomUUID(), method: "set_editor_text", text });
    },
    getEditorText: () => input.record.draft.text,
    setEditorComponent: () => {},
  };
}

function createRemoteUiThemeHandlers(
  theme: typeof defaultTheme,
): Pick<ExtensionUIContext, "theme" | "getAllThemes" | "getTheme" | "setTheme"> {
  return {
    theme,
    getAllThemes: () => [],
    getTheme: () => {},
    setTheme: () => ({
      success: false,
      error: "Theme switching is not supported by pi-remote",
    }),
  };
}
