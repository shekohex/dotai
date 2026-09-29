import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import { getBundledExtensionDefinitions } from "../src/extensions/index.js";
import { timedTest } from "./test-utils/timed-test.ts";
import { createTempDir } from "./test-utils/temp-paths.ts";

timedTest("inline extension factories use named synthetic paths", async () => {
  const cwd = await createTempDir("agent-inline-extension-name-");

  try {
    const namedFactory = {
      name: "git-state",
      factory: (pi: ExtensionAPI) => {
        pi.on("session_start", () => {});
      },
    };

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      extensionFactories: [namedFactory],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });

    await loader.reload();

    const extension = loader.getExtensions().extensions[0];
    if (!extension) {
      throw new Error("Expected named inline extension");
    }

    expect(extension.path).toBe("<inline:git-state>");
    expect(extension.sourceInfo.path).toBe("<inline:git-state>");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("inline extension name patch forwards reload options", async () => {
  const cwd = await createTempDir("agent-inline-extension-options-");
  await writeFile(`${cwd}/AGENTS.md`, "test");

  try {
    let projectTrustCalled = false;
    const namedFactory = {
      name: "project-trust-test",
      factory: (pi: ExtensionAPI) => {
        pi.on("project_trust", () => {
          projectTrustCalled = true;
          return { trusted: "yes" };
        });
      },
    };

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      extensionFactories: [namedFactory],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });

    let resolveProjectTrustCalled = false;
    await loader.reload({
      resolveProjectTrust: async ({ extensionsResult }) => {
        resolveProjectTrustCalled = true;
        const extension = extensionsResult.extensions.find(
          (item) => item.path === "<inline:project-trust-test>",
        );
        const handler = extension?.handlers.get("project_trust")?.[0];
        await handler?.(
          { type: "project_trust", cwd },
          {
            cwd,
            mode: "test",
            hasUI: false,
            ui: {} as never,
          },
        );
        return true;
      },
    });

    expect(resolveProjectTrustCalled).toBe(true);
    expect(projectTrustCalled).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("bundled Herdr reporter suppresses managed Pi integration", async () => {
  const cwd = await createTempDir("agent-herdr-integration-conflict-");
  const managedIntegrationPath = join(cwd, "herdr-agent-state.ts");
  const managedIntegrationLoadedKey = "__testManagedHerdrIntegrationLoaded";
  Reflect.deleteProperty(globalThis, managedIntegrationLoadedKey);
  const herdrDefinition = getBundledExtensionDefinitions().find(
    (definition) => definition.id === "herdr-agent-state",
  );
  if (herdrDefinition === undefined) {
    throw new Error("Expected bundled Herdr reporter");
  }
  await writeFile(
    managedIntegrationPath,
    [
      `// ${"x".repeat(2048)}`,
      "// HERDR_INTEGRATION_ID=pi",
      `Reflect.set(globalThis, "${managedIntegrationLoadedKey}", true);`,
      "export default function (pi) {",
      '  pi.on("agent_start", () => {});',
      "}",
    ].join("\n"),
  );

  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      additionalExtensionPaths: [managedIntegrationPath],
      extensionFactories: [{ name: herdrDefinition.id, factory: herdrDefinition.factory }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });

    await loader.reload();
    await loader.reload();

    expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
      "<inline:herdr-agent-state>",
    ]);
    expect(Reflect.get(globalThis, managedIntegrationLoadedKey)).toBeUndefined();
  } finally {
    Reflect.deleteProperty(globalThis, managedIntegrationLoadedKey);
    await rm(cwd, { recursive: true, force: true });
  }
});
