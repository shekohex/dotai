import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorMessage } from "../utils/error-message.js";
import { readToolDefinition } from "./coreui/builtins.js";
import { completeSimpleModel } from "./pi-ai-models.js";
import {
  renderViewImageCall,
  renderViewImageResult,
  type ViewImageRenderState,
} from "./view-image-render.js";
import type { ViewImageDetails } from "./view-image-types.js";

const IMAGE_DESCRIPTION_SYSTEM_PROMPT =
  "Describe the supplied image in detail. Output only the image description, with no preamble or other commentary.";
const PREFERRED_DESCRIPTION_MODEL_KEYS = ["openai-codex/gpt-5.6-luna"] as const;

const ViewImageParams = Type.Object({
  path: Type.String({ description: "Path to an image file, relative to the current directory" }),
});

export function modelSupportsImages(model: Model<Api> | undefined): boolean {
  return model?.input.includes("image") === true;
}

function descriptionModelScore(model: Model<Api>): number {
  const key = `${model.provider}/${model.id}`;
  const preferredIndex = PREFERRED_DESCRIPTION_MODEL_KEYS.findIndex(
    (candidate) => candidate === key,
  );
  if (preferredIndex >= 0) return preferredIndex;
  const id = model.id.toLowerCase();
  if (model.provider === "openai-codex" && id.includes("mini")) return 10;
  if (id.includes("mini") || id.includes("flash")) return 20;
  if (model.provider === "openai-codex") return 30;
  return 40;
}

export function resolveImageDescriptionModels(ctx: ExtensionContext): Model<Api>[] {
  return ctx.modelRegistry
    .getAvailable()
    .filter((model) => modelSupportsImages(model))
    .toSorted((left, right) => {
      const score = descriptionModelScore(left) - descriptionModelScore(right);
      if (score === 0) {
        const outputCost = left.cost.output - right.cost.output;
        if (outputCost === 0) return left.id.localeCompare(right.id);
        return outputCost;
      }
      return score;
    });
}

async function loadImage(
  path: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ImageContent> {
  if (readToolDefinition.execute === undefined) {
    throw new Error("The built-in read tool is unavailable.");
  }
  const result = await readToolDefinition.execute("view-image", { path }, signal, undefined, ctx);
  const image = result.content.find((item): item is ImageContent => item.type === "image");
  if (image === undefined) {
    throw new Error(`view_image expected an image file: ${path}`);
  }
  return image;
}

function assistantText(response: Awaited<ReturnType<typeof completeSimpleModel>>): string {
  return response.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n")
    .trim();
}

async function describeImage(
  image: ImageContent,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ description: string; model: Model<Api> }> {
  const failures: string[] = [];
  for (const model of resolveImageDescriptionModels(ctx)) {
    const label = `${model.provider}/${model.id}`;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      if (auth.apiKey === undefined || auth.apiKey.length === 0) {
        throw new Error("No API key available");
      }
      const response = await completeSimpleModel(
        model,
        {
          systemPrompt: IMAGE_DESCRIPTION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Describe this image." }, image],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: 4096,
          reasoning: "low",
          signal,
          temperature: 0,
        },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage ?? `Stopped with ${response.stopReason}`);
      }
      const description = assistantText(response);
      if (description.length === 0) throw new Error("Image description returned no text");
      return { description, model };
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
    }
  }
  const reason =
    failures.length === 0 ? "no authenticated vision model is available" : failures.join("; ");
  throw new Error(`view_image could not describe the image: ${reason}`);
}

export async function presentImageToModel(
  image: ImageContent,
  directText: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<TextContent | ImageContent>; describedBy?: string }> {
  if (modelSupportsImages(ctx.model)) {
    return { content: [{ type: "text", text: directText }, image] };
  }
  const result = await describeImage(image, signal, ctx);
  return {
    content: [{ type: "text", text: result.description }],
    describedBy: `${result.model.provider}/${result.model.id}`,
  };
}

export function createViewImageToolDefinition() {
  return defineTool<typeof ViewImageParams, ViewImageDetails, ViewImageRenderState>({
    name: "view_image",
    label: "View Image",
    renderShell: "self",
    description:
      "View a local image file. Vision-capable models receive the image directly; text-only models receive a detailed description from a vision helper model.",
    promptSnippet: "View or inspect a local image file",
    promptGuidelines: [
      "Use view_image for image files when visual inspection is needed, especially when the active model is text-only.",
    ],
    parameters: ViewImageParams,
    renderCall: renderViewImageCall,
    renderResult: renderViewImageResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const path = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      onUpdate?.({
        content: [{ type: "text", text: "Loading image." }],
        details: { path, phase: "loading" },
      });
      const image = await loadImage(path, signal, ctx);
      if (!modelSupportsImages(ctx.model)) {
        onUpdate?.({
          content: [{ type: "text", text: "Describing image." }],
          details: { path, phase: "describing" },
        });
      }
      const presentation = await presentImageToModel(image, `Viewed image: ${path}`, signal, ctx);
      return {
        content: presentation.content,
        details: {
          path,
          mimeType: image.mimeType,
          byteSize: Buffer.byteLength(image.data, "base64"),
          ...(presentation.describedBy === undefined
            ? {}
            : { describedBy: presentation.describedBy }),
        },
      };
    },
  });
}

export default function viewImageExtension(pi: ExtensionAPI): void {
  pi.registerTool(createViewImageToolDefinition());
}
