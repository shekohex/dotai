import { rm } from "node:fs/promises";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { builtInExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { createNativeToolExtensions } from "../../src/extensions/native-tool-extensions.js";
import { styleNativeToolExtension } from "../../src/extensions/coreui/tools-native.js";
import { createTempDir } from "../test-utils/temp-paths.ts";

test("native styling factories replace CLI built-ins without duplicate tools", async () => {
  const cwd = await createTempDir("native-tool-styling-");
  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      extensionFactories: [...builtInExtensions, ...createNativeToolExtensions()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const extensions = loader.getExtensions();
    expect(extensions.errors).toEqual([]);
    for (const [extensionName, toolName] of [
      ["codemode", "codemode"],
      ["tool-search", "tool_search"],
    ]) {
      const matching = extensions.extensions.filter(
        (extension) => extension.path === `builtin:${extensionName}`,
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].tools.get(toolName)?.definition.renderShell).toBe("self");
      expect(matching[0].tools.get(toolName)?.definition.defaultActive).toBe(false);
    }
    expect(
      extensions.extensions.filter((extension) => extension.path === "builtin:mcp"),
    ).toHaveLength(1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("late native registrations keep styling and original execution contracts", () => {
  const registered: ToolDefinition[] = [];
  let registerLater: (() => void) | undefined;
  const definition = {
    name: "mcp__executor__list_projects",
    label: "executor/list_projects",
    description: "List projects",
    parameters: Type.Object({}),
    outputSchema: Type.Object({ content: Type.Array(Type.Unknown()) }),
    exposure: "deferred" as const,
    namespace: { name: "executor" },
    annotations: { readOnlyHint: true },
    execute: async () => ({ content: [] }),
    prepareLoadout: () => ({ descriptions: {} }),
  };
  styleNativeToolExtension((pi) => {
    registerLater = () => pi.registerTool(definition);
  }, "mcp")({ registerTool: (tool: ToolDefinition) => registered.push(tool) } as ExtensionAPI);
  registerLater!();
  registerLater!();
  for (const tool of registered) {
    expect(tool.renderShell).toBe("self");
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
    for (const key of [
      "execute",
      "parameters",
      "outputSchema",
      "prepareLoadout",
      "exposure",
      "namespace",
      "annotations",
    ] as const)
      expect(tool[key]).toBe(definition[key]);
  }
});
