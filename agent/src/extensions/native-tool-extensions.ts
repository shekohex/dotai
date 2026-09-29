import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { styleNativeToolExtension } from "./coreui/tools-native.js";

// Same built-in names replace the CLI factories and also opt SDK sessions in.
export function createNativeToolExtensions(): InlineExtension[] {
  return [
    {
      name: "codemode",
      factory: styleNativeToolExtension(createCodemodeExtension(), "codemode"),
      builtin: true,
      replaceable: true,
    },
    {
      name: "tool-search",
      factory: styleNativeToolExtension(createToolSearchExtension(), "tool-search"),
      builtin: true,
      replaceable: true,
    },
    {
      name: "mcp",
      factory: styleNativeToolExtension(createMcpExtension(), "mcp"),
      builtin: true,
      replaceable: true,
    },
  ];
}
