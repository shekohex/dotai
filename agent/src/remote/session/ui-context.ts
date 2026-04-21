import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import {
  initTheme,
  theme as defaultTheme,
} from "../../../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { attachRuntimeCapabilities } from "../../extensions/runtime-capabilities.js";
import { getSessionRuntimeCapabilities } from "./capabilities.js";
import type { RemoteUiContextInput } from "./ui-context-types.js";
import { createRemoteUiInputHandlers } from "./ui-input-handlers.js";
import { createRemoteUiStatusHandlers } from "./ui-status-handlers.js";

export function createRemoteUiContext(input: RemoteUiContextInput): ExtensionUIContext {
  initTheme(undefined, false);
  const uiContext: ExtensionUIContext = {
    ...createRemoteUiInputHandlers(input),
    ...createRemoteUiStatusHandlers(input),
    ...createRemoteUiLayoutHandlers(),
    ...createRemoteUiEditorHandlers(input),
    ...createRemoteUiThemeHandlers(defaultTheme),
  };
  attachRuntimeCapabilities(uiContext, () => getSessionRuntimeCapabilities(input.record.presence));
  return uiContext;
}

function createRemoteUiLayoutHandlers(): Pick<ExtensionUIContext, "setFooter" | "setHeader"> {
  return {
    setFooter: (factory) => {
      if (typeof factory === "function") {
        throw new TypeError(
          "ctx.ui.setFooter(factory) is not supported in remote server runtime. Send footer data and render on client runtime.",
        );
      }
    },
    setHeader: (factory) => {
      if (typeof factory === "function") {
        throw new TypeError(
          "ctx.ui.setHeader(factory) is not supported in remote server runtime. Send header data and render on client runtime.",
        );
      }
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
    getEditorText: () => "",
    setEditorComponent: (factory) => {
      if (factory !== undefined) {
        throw new TypeError(
          "ctx.ui.setEditorComponent(factory) is not supported in remote server runtime. Render editor components on client runtime.",
        );
      }
    },
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
