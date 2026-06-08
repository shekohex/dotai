import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import {
  installInlineExtensionNamePatch,
  setInlineExtensionName,
} from "../src/extensions/inline-extension-names.js";
import { timedTest } from "./test-utils/timed-test.ts";
import { createTempDir } from "./test-utils/temp-paths.ts";

timedTest("inline extension factories use named synthetic paths", async () => {
  installInlineExtensionNamePatch();
  const cwd = await createTempDir("agent-inline-extension-name-");

  try {
    const namedFactory = setInlineExtensionName((pi: ExtensionAPI) => {
      pi.on("session_start", () => {});
    }, "git-state");

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

    expect(extension.path).toBe("<git-state>");
    expect(extension.sourceInfo.path).toBe("<git-state>");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("inline extension name patch forwards reload options", async () => {
  installInlineExtensionNamePatch();
  const cwd = await createTempDir("agent-inline-extension-options-");
  await writeFile(`${cwd}/AGENTS.md`, "test");

  try {
    let projectTrustCalled = false;
    const namedFactory = setInlineExtensionName((pi: ExtensionAPI) => {
      pi.on("project_trust", () => {
        projectTrustCalled = true;
        return { trusted: "yes" };
      });
    }, "project-trust-test");

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
        const extension = extensionsResult.extensions.find((item) => item.path === "<inline:1>");
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
