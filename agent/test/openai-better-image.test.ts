import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  extractImageFromEvent,
  registerOpenAIImage,
} from "../src/extensions/openai-better/image.js";
import { defaultOpenAIBetterSettings } from "../src/extensions/openai-better/settings.js";

describe("openai better image parsing", () => {
  it("does not register generate_image by default", () => {
    const registeredTools: string[] = [];
    registerOpenAIImage(createFakePi(registeredTools), () => defaultOpenAIBetterSettings);

    expect(defaultOpenAIBetterSettings.image.enabled).toBe(false);
    expect(registeredTools).not.toContain("generate_image");
  });

  it("registers generate_image when image setting is enabled", () => {
    const registeredTools: string[] = [];
    registerOpenAIImage(createFakePi(registeredTools), () => ({
      ...defaultOpenAIBetterSettings,
      image: {
        ...defaultOpenAIBetterSettings.image,
        enabled: true,
      },
    }));

    expect(registeredTools).toContain("generate_image");
  });

  it("registers imagen command with prompt usage and enables tool before generation", async () => {
    const registeredTools: string[] = [];
    let activeTools: string[] = [];
    let imagenCommand:
      | {
          description: string;
          handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
        }
      | undefined;
    const pi = createFakePi(registeredTools, {
      getActiveTools: () => activeTools,
      setActiveTools: (toolNames) => {
        activeTools = toolNames;
      },
      registerCommand: (name, command) => {
        if (name === "imagen") {
          imagenCommand = command;
        }
      },
    });

    registerOpenAIImage(pi, () => defaultOpenAIBetterSettings);

    expect(imagenCommand?.description).toContain("/imagen <prompt>");
    await expect(
      imagenCommand?.handler("draw a fox", {
        cwd: process.cwd(),
        hasUI: false,
        ui: { notify() {} },
        modelRegistry: { authStorage: { getApiKey: async () => undefined } },
      } as unknown as ExtensionCommandContext),
    ).rejects.toThrow();
    expect(registeredTools).toContain("generate_image");
    expect(activeTools).toContain("generate_image");
  });

  it("ignores streaming partial image chunks", () => {
    const image = extractImageFromEvent(
      { type: "response.image_generation_call.partial_image", partial_image_b64: "partial" },
      "image/png",
    );

    expect(image).toBeUndefined();
  });

  it("extracts final image_generation_call result", () => {
    const image = extractImageFromEvent(
      {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "ig_final",
          status: "completed",
          result: "final",
        },
      },
      "image/png",
    );

    expect(image).toMatchObject({
      id: "ig_final",
      status: "completed",
      data: "final",
      mimeType: "image/png",
    });
  });
});

function createFakePi(
  registeredTools: string[],
  overrides: Partial<ExtensionAPI> = {},
): ExtensionAPI {
  return {
    getActiveTools: () => [],
    on() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerTool(tool) {
      registeredTools.push(tool.name);
    },
    setActiveTools() {},
    ...overrides,
  } as unknown as ExtensionAPI;
}
