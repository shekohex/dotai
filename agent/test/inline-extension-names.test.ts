import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import {
  installInlineExtensionNamePatch,
  setInlineExtensionName,
} from "../src/extensions/inline-extension-names.js";
import { timedTest } from "./test-utils/timed-test.ts";

timedTest("inline extension factories use named synthetic paths", async () => {
  installInlineExtensionNamePatch();
  const cwd = await mkdtemp(join(tmpdir(), "agent-inline-extension-name-"));

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
