import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Container, Image, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../utils/error-message.js";
import {
  createTextComponent,
  formatDurationHuman,
  formatToolRail,
  getTextContent,
  renderToolError,
} from "../coreui/tools.js";
import { formatToolStatus } from "../coreui/tools-status.js";
import { LITELLM_API_KEY_ENV, resolveLiteLLMApiKey, resolveLiteLLMState } from "../litellm.js";
import {
  IMAGE_ACTIONS,
  IMAGE_OUTPUT_FORMATS,
  ImageGenerationCallSchema,
  OPENAI_IMAGE_COMMAND,
  OPENAI_IMAGE_PROMPT_GUIDELINES,
  OPENAI_IMAGE_SYSTEM_PROMPT,
  OPENAI_IMAGE_TOOL,
  ToolParamsSchema,
  type ImageAction,
  type ImageGenerationCall,
  type ImageOutputFormat,
  type ImageSaveMode,
  type ToolParams,
} from "./image-schema.js";
import type { OpenAIBetterSettings } from "./settings.js";

const LITELLM_RESPONSES_PATH = "/responses";
const DEFAULT_TIMEOUT_MS = 360_000;

const ImageEventSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    item: Type.Optional(Type.Unknown()),
    output: Type.Optional(Type.Array(Type.Unknown())),
    partial_image_b64: Type.Optional(Type.String()),
    b64_json: Type.Optional(Type.String()),
    response: Type.Optional(Type.Unknown()),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

type LiteLLMImageCredentials = {
  accessToken: string;
  baseUrl: string;
  source: "litellmAuth" | "litellmEnv";
};

type ImageInput = {
  data: string;
  mimeType: string;
};

type ImageRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
};

export type CodexImageResult = {
  id: string;
  status: string;
  prompt: string;
  revisedPrompt?: string;
  data: string;
  mimeType: string;
  savedPath?: string;
  model: string;
  action: ImageAction;
  outputFormat: ImageOutputFormat;
};

type ExtractedImageResult = Omit<
  CodexImageResult,
  "prompt" | "savedPath" | "model" | "action" | "outputFormat"
>;

export type ImageGenerationDebug = {
  authFound: boolean;
  authSource?: string;
  endpoint: string;
  defaultModel: string;
  defaultSave: ImageSaveMode;
  enabled: boolean;
  lastStatus?: string;
  lastError?: string;
};

async function getCredentials(): Promise<LiteLLMImageCredentials> {
  const state = await resolveLiteLLMState();
  if (state.baseUrl !== undefined && state.baseUrl.length > 0) {
    const authKey = await resolveLiteLLMApiKey();
    if (authKey !== undefined && authKey.length > 0) {
      return { accessToken: authKey, baseUrl: state.baseUrl, source: "litellmAuth" };
    }

    const envKey = process.env[LITELLM_API_KEY_ENV]?.trim();
    if (envKey !== undefined && envKey.length > 0) {
      return { accessToken: envKey, baseUrl: state.baseUrl, source: "litellmEnv" };
    }

    throw new Error("LiteLLM API key not configured. Run /login litellm or set LITELLM_API_KEY.");
  }
  throw new Error(
    state.error === undefined ? "LiteLLM unavailable." : `LiteLLM unavailable: ${state.error}`,
  );
}

function resolveModel(
  params: Pick<ToolParams, "model">,
  ctx: ExtensionContext,
  settings: OpenAIBetterSettings,
): string {
  const requestedModel = params.model?.trim();
  if (requestedModel !== undefined && requestedModel.length > 0) {
    return requestedModel.includes("/")
      ? (requestedModel.split("/").pop() ?? requestedModel)
      : requestedModel;
  }
  if (ctx.model?.provider === "codex-openai") return ctx.model.id;
  return settings.image.defaultModel;
}

function resolveImageOptions(settings: OpenAIBetterSettings, params: ToolParams) {
  return {
    action: params.action ?? "auto",
    outputFormat: params.outputFormat ?? settings.image.outputFormat,
    save: params.save ?? settings.image.defaultSave,
  };
}

function imageMimeType(path: string, outputFormat?: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (outputFormat === "jpeg") return "image/jpeg";
  if (outputFormat === "webp") return "image/webp";
  return "image/png";
}

function extensionForFormat(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

async function readImageInputs(paths: string[] | undefined, cwd: string): Promise<ImageInput[]> {
  const inputs: ImageInput[] = [];
  for (const rawPath of paths ?? []) {
    const trimmed = rawPath.trim();
    if (trimmed.length === 0) continue;
    const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
    const data = (await readFile(path)).toString("base64");
    inputs.push({ data, mimeType: imageMimeType(path) });
  }
  return inputs;
}

function resolveSaveDir(
  mode: ImageSaveMode,
  params: Pick<ToolParams, "saveDir">,
  cwd: string,
): string | undefined {
  if (mode === "none") return undefined;
  if (mode === "project") return join(cwd, ".pi", "generated-images");
  if (mode === "global")
    return join(
      process.env.PI_CODING_AGENT_DIR?.trim() ?? join(homedir(), ".pi", "agent"),
      "generated-images",
    );
  const dir = params.saveDir?.trim() ?? process.env.PI_IMAGE_SAVE_DIR?.trim();
  if (dir === undefined || dir.length === 0)
    throw new Error("save=custom requires saveDir or PI_IMAGE_SAVE_DIR.");
  return dir;
}

async function saveImage(data: string, format: ImageOutputFormat, outputDir: string, id: string) {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const safeId = id.replaceAll(/[^a-zA-Z0-9_-]/g, "_") || randomUUID().slice(0, 8);
  const path = join(outputDir, `openai-image-${timestamp}-${safeId}.${extensionForFormat(format)}`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path, Buffer.from(data, "base64"));
  return path;
}

function buildRequest(
  params: ToolParams,
  model: string,
  settings: OpenAIBetterSettings,
  images: ImageInput[],
) {
  const { action, outputFormat } = resolveImageOptions(settings, params);
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: params.prompt }];
  for (const image of images) {
    content.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  const tool: Record<string, unknown> = { type: "image_generation", output_format: outputFormat };
  if (action !== "auto") tool.action = action;
  return {
    model,
    input: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    store: false,
    stream: true,
  };
}

function dataUrlParts(value: string, fallbackMimeType: string) {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match !== null)
    return { mimeType: match[1] ?? fallbackMimeType, data: match[2]?.trim() ?? "" };
  return { data: value.trim(), mimeType: fallbackMimeType };
}

function parseImageGenerationCall(value: unknown): ImageGenerationCall | undefined {
  return Value.Check(ImageGenerationCallSchema, value)
    ? Value.Parse(ImageGenerationCallSchema, value)
    : undefined;
}

function extractImageFromCall(
  call: ImageGenerationCall,
  fallbackMimeType: string,
): ExtractedImageResult | undefined {
  const raw = call.result?.trim() ?? call.b64_json?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const { data, mimeType } = dataUrlParts(raw, fallbackMimeType);
  return {
    id: call.id ?? `ig_${randomUUID().slice(0, 8)}`,
    status: call.status ?? "completed",
    revisedPrompt: call.revised_prompt,
    data,
    mimeType,
  };
}

export function extractImageFromEvent(
  value: unknown,
  fallbackMimeType: string,
): ExtractedImageResult | undefined {
  if (!Value.Check(ImageEventSchema, value)) return undefined;
  const event = Value.Parse(ImageEventSchema, value);
  const direct = parseImageGenerationCall(event);
  const item = parseImageGenerationCall(event.item);
  const output = event.output
    ?.map((entry) => parseImageGenerationCall(entry))
    .find((entry) => entry !== undefined);
  const callImage = [direct, item, output]
    .map((entry) =>
      entry === undefined ? undefined : extractImageFromCall(entry, fallbackMimeType),
    )
    .find((entry) => entry !== undefined);
  if (callImage !== undefined) return callImage;
  const partial = event.b64_json?.trim();
  if (partial === undefined || partial.length === 0) return undefined;
  const { data, mimeType } = dataUrlParts(partial, fallbackMimeType);
  return { id: `ig_${randomUUID().slice(0, 8)}`, status: "completed", data, mimeType };
}

function throwIfResponseError(value: unknown): void {
  if (!Value.Check(ImageEventSchema, value)) return;
  const event = Value.Parse(ImageEventSchema, value);
  if (event.type === "error") throw new Error(event.message ?? "LiteLLM image request failed.");
  if (event.type !== "response.failed") return;
  throw new Error("LiteLLM image request failed.");
}

function parseSseDataChunk(chunk: string): unknown {
  const data = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (data.length === 0 || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch (error) {
    throw new Error(`Malformed image_generation SSE event: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

async function parseSseForImage(
  response: Response,
  fallbackMimeType: string,
  signal?: AbortSignal,
) {
  if (response.body === null) throw new Error("No response body from LiteLLM image request.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastImage: ExtractedImageResult | undefined;
  try {
    for (;;) {
      if (signal?.aborted === true) throw new Error("Image request was aborted.");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const event = parseSseDataChunk(chunk);
        if (event === null) continue;
        throwIfResponseError(event);
        const image = extractImageFromEvent(event, fallbackMimeType);
        if (image === undefined) continue;
        lastImage = image;
        if (image.status === "completed") {
          await reader.cancel().catch(() => {});
          return image;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (lastImage !== undefined) return lastImage;
  throw new Error("No image_generation_call result returned by provider.");
}

async function parseJsonForImage(response: Response, fallbackMimeType: string) {
  const json = (await response.json()) as unknown;
  throwIfResponseError(json);
  const image = extractImageFromEvent(json, fallbackMimeType);
  if (image !== undefined) return image;
  throw new Error("No image_generation_call result returned by provider.");
}

function parseImageResponse(response: Response, fallbackMimeType: string, signal?: AbortSignal) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream"))
    return parseSseForImage(response, fallbackMimeType, signal);
  return parseJsonForImage(response, fallbackMimeType);
}

async function requestLiteLLMImage(
  params: ToolParams,
  ctx: ExtensionContext,
  settings: OpenAIBetterSettings,
  requestSignal?: AbortSignal,
): Promise<CodexImageResult> {
  if (!settings.image.enabled) throw new Error("OpenAI image generation is disabled in settings.");
  const credentials = await getCredentials();
  const model = resolveModel(params, ctx, settings);
  const { action, outputFormat, save } = resolveImageOptions(settings, params);
  const images = await readImageInputs(params.images, ctx.cwd || process.cwd());
  const request = buildRequest(params, model, settings, images);
  const timeoutSignal = AbortSignal.timeout(settings.image.timeoutMs);
  const signal =
    requestSignal === undefined ? timeoutSignal : AbortSignal.any([requestSignal, timeoutSignal]);
  const response = await fetch(`${credentials.baseUrl}${LITELLM_RESPONSES_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      accept: "text/event-stream, application/json",
      "content-type": "application/json",
      "User-Agent": "pi-openai-better",
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `LiteLLM image request failed (${response.status}): ${text.length > 0 ? text : response.statusText}`,
    );
  }
  const parsed = await parseImageResponse(
    response,
    imageMimeType(`image.${outputFormat}`, outputFormat),
    signal,
  );
  const saveDir = resolveSaveDir(save, params, ctx.cwd || process.cwd());
  const savedPath =
    saveDir === undefined
      ? undefined
      : await saveImage(parsed.data, outputFormat, saveDir, parsed.id);
  return { ...parsed, prompt: params.prompt, savedPath, model, action, outputFormat };
}

function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(homePrefix) ? `~/${path.slice(homePrefix.length)}` : path;
}

function textFromMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } =>
      Value.Check(Type.Object({ type: Type.Literal("text"), text: Type.String() }), part),
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function resultText(result: CodexImageResult): string {
  return [
    `Generated image using OpenAI image_generation tool with ${result.model}.`,
    `Action: ${result.action}.`,
    `Prompt: ${result.prompt}`,
    result.revisedPrompt === undefined ? undefined : `Revised prompt: ${result.revisedPrompt}`,
    result.savedPath === undefined ? undefined : `Saved: ${displayPath(result.savedPath)}`,
    result.savedPath === undefined
      ? undefined
      : `Generated images are saved to ${displayPath(result.savedPath)} as ${result.outputFormat} by default.\nIf you need to use a generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it.`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

function shortPrompt(prompt: string): string {
  const normalized = prompt.replaceAll(/\s+/g, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function syncRenderState(context: {
  state: unknown;
  executionStarted: boolean;
  isPartial: boolean;
  invalidate: () => void;
}): ImageRenderState {
  const state = isImageRenderState(context.state) ? context.state : {};
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
  if (state.startedAt !== undefined && context.isPartial && state.interval === undefined) {
    state.interval = setInterval(() => {
      context.invalidate();
    }, 1000);
    state.interval.unref?.();
  }
  if (!context.isPartial && state.startedAt !== undefined) {
    state.endedAt ??= Date.now();
    if (state.interval !== undefined) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }
  return state;
}

function isImageRenderState(value: unknown): value is ImageRenderState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getElapsedMs(state: ImageRenderState): number | undefined {
  if (state.startedAt === undefined) return undefined;
  return (state.endedAt ?? Date.now()) - state.startedAt;
}

function isImageContent(
  value: unknown,
): value is { type: "image"; data: string; mimeType: string } {
  return Value.Check(
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
    value,
  );
}

function extractRenderedImage(message: { content: unknown; details?: unknown }) {
  const result = Value.Check(
    Type.Object(
      { data: Type.String(), mimeType: Type.String(), savedPath: Type.Optional(Type.String()) },
      { additionalProperties: true },
    ),
    message.details,
  )
    ? Value.Parse(
        Type.Object(
          { data: Type.String(), mimeType: Type.String(), savedPath: Type.Optional(Type.String()) },
          { additionalProperties: true },
        ),
        message.details,
      )
    : undefined;
  if (result !== undefined) return result;
  if (!Array.isArray(message.content)) return null;
  const image = message.content.find(isImageContent);
  return image === undefined ? undefined : { data: image.data, mimeType: image.mimeType };
}

function registerImageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<CodexImageResult>("openai-image", (message, _options, theme) => {
    const text =
      message.details === undefined
        ? (textFromMessageContent(message.content) ?? "")
        : resultText(message.details);
    const image = extractRenderedImage(message);
    const container = new Container();
    const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new Text(`${theme.fg("accent", theme.bold("[openai-image]"))}\n\n${text}`, 0, 0));
    if (image !== undefined && image !== null) {
      box.addChild(
        new Image(
          image.data,
          image.mimeType,
          { fallbackColor: (line) => theme.fg("dim", line) },
          { maxWidthCells: 80, maxHeightCells: 24, filename: image.savedPath },
        ),
      );
    }
    container.addChild(box);
    return container;
  });
}

function createImagePreviewComponent(
  result: CodexImageResult,
  theme: ExtensionContext["ui"]["theme"],
): Container {
  const container = new Container();
  const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(
    new Text(`${theme.fg("accent", theme.bold("[image]"))}\n\n${resultText(result)}`, 0, 0),
  );
  box.addChild(
    new Image(
      result.data,
      result.mimeType,
      { fallbackColor: (line) => theme.fg("dim", line) },
      { maxWidthCells: 80, maxHeightCells: 24, filename: result.savedPath },
    ),
  );
  container.addChild(box);
  return container;
}

function parseRenderedResultDetails(value: unknown): CodexImageResult | undefined {
  return Value.Check(
    Type.Object(
      {
        id: Type.String(),
        status: Type.String(),
        prompt: Type.String(),
        data: Type.String(),
        mimeType: Type.String(),
        model: Type.String(),
        action: StringEnum(IMAGE_ACTIONS),
        outputFormat: StringEnum(IMAGE_OUTPUT_FORMATS),
        revisedPrompt: Type.Optional(Type.String()),
        savedPath: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    value,
  )
    ? Value.Parse(
        Type.Object(
          {
            id: Type.String(),
            status: Type.String(),
            prompt: Type.String(),
            data: Type.String(),
            mimeType: Type.String(),
            model: Type.String(),
            action: StringEnum(IMAGE_ACTIONS),
            outputFormat: StringEnum(IMAGE_OUTPUT_FORMATS),
            revisedPrompt: Type.Optional(Type.String()),
            savedPath: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
        value,
      )
    : undefined;
}

function createImageTool(getSettings: () => OpenAIBetterSettings) {
  return defineTool({
    name: OPENAI_IMAGE_TOOL,
    label: "imagen",
    renderShell: "self",
    description:
      "Generate or edit images through OpenAI using the hosted image_generation tool. Supports local reference/edit images and saves to the project by default.",
    promptSnippet: "Generate or edit raster images via OpenAI image_generation.",
    promptGuidelines: OPENAI_IMAGE_PROMPT_GUIDELINES,
    parameters: ToolParamsSchema,
    renderCall(args, theme, context) {
      const state = syncRenderState(context);
      const rail = formatToolRail(theme, context);
      const status = formatToolStatus(theme, context, {
        pending: "drawing",
        success: "drew",
        error: "draw failed",
      });
      const prompt = typeof args.prompt === "string" ? shortPrompt(args.prompt) : "image";
      const format = typeof args.outputFormat === "string" ? ` · ${args.outputFormat}` : "";
      const elapsedMs = getElapsedMs(state);
      const elapsed = elapsedMs === undefined ? "" : ` · ${formatDurationHuman(elapsedMs)}`;
      return createTextComponent(
        context.lastComponent,
        `${rail}${status} ${theme.fg("text", prompt)}${theme.fg("muted", `${format}${elapsed}`)}`,
      );
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        return renderToolError(getTextContent(result), theme, context.lastComponent);
      }

      const details = parseRenderedResultDetails(result.details);
      if (details !== undefined) {
        return createImagePreviewComponent(details, theme);
      }
      return createTextComponent(
        context.lastComponent,
        `${formatToolRail(theme, context)}${theme.bold(theme.fg("muted", "image"))}`,
      );
    },
    async execute(_toolCallId, params: ToolParams, signal, _onUpdate, ctx) {
      const settings = getSettings();
      const result = await requestLiteLLMImage(params, ctx, settings, signal);
      return {
        content: [
          { type: "text", text: resultText(result) },
          { type: "image", data: result.data, mimeType: result.mimeType },
        ],
        details: result,
      };
    },
  });
}

export function registerOpenAIImage(
  pi: ExtensionAPI,
  getSettings: () => OpenAIBetterSettings,
): { getDebug: (ctx: ExtensionContext) => Promise<ImageGenerationDebug> } {
  let lastStatus: string | undefined;
  let lastError: string | undefined;
  let commandEnabled = false;
  let toolRegistered = false;

  function getEffectiveSettings(): OpenAIBetterSettings {
    const settings = getSettings();
    if (!commandEnabled) {
      return settings;
    }
    return {
      ...settings,
      image: {
        ...settings.image,
        enabled: true,
      },
    };
  }

  function registerImageTool(): void {
    if (toolRegistered) {
      return;
    }
    pi.registerTool(createImageTool(getEffectiveSettings));
    toolRegistered = true;
  }

  function activateImageTool(): void {
    commandEnabled = true;
    registerImageTool();
    const activeTools = new Set([...pi.getActiveTools(), OPENAI_IMAGE_TOOL]);
    pi.setActiveTools(Array.from(activeTools).toSorted((left, right) => left.localeCompare(right)));
  }

  async function generate(params: ToolParams, ctx: ExtensionContext, requestSignal?: AbortSignal) {
    try {
      lastStatus = "requesting";
      lastError = undefined;
      const result = await requestLiteLLMImage(params, ctx, getEffectiveSettings(), requestSignal);
      lastStatus = `completed (${result.id})`;
      return result;
    } catch (error) {
      lastStatus = "error";
      lastError = errorMessage(error);
      throw error;
    }
  }

  async function getDebug(ctx: ExtensionContext): Promise<ImageGenerationDebug> {
    const settings = getEffectiveSettings();
    const credentials = await getCredentials().catch(() => {});
    return {
      authFound: credentials !== undefined,
      authSource: credentials?.source,
      endpoint:
        credentials === undefined
          ? LITELLM_RESPONSES_PATH
          : `${credentials.baseUrl}${LITELLM_RESPONSES_PATH}`,
      defaultModel:
        ctx.model?.provider === "codex-openai" ? ctx.model.id : settings.image.defaultModel,
      defaultSave: settings.image.defaultSave,
      enabled: settings.image.enabled,
      lastStatus,
      lastError,
    };
  }

  registerImageRenderer(pi);
  pi.on("before_agent_start", (event) =>
    getEffectiveSettings().image.enabled
      ? { systemPrompt: `${event.systemPrompt}\n\n${OPENAI_IMAGE_SYSTEM_PROMPT}` }
      : undefined,
  );
  pi.registerCommand(OPENAI_IMAGE_COMMAND, {
    description: "Generate or edit an image. Usage: /imagen <prompt>",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (prompt.length === 0) {
        ctx.ui.notify("Usage: /imagen <prompt>", "error");
        return;
      }
      activateImageTool();
      ctx.ui.notify("Requesting OpenAI image...", "info");
      const result = await generate({ prompt }, ctx);
      pi.sendMessage({
        customType: "openai-image",
        content: [
          { type: "text", text: resultText(result) },
          { type: "image", data: result.data, mimeType: result.mimeType },
        ],
        display: true,
        details: result,
      });
    },
  });
  if (getEffectiveSettings().image.enabled) {
    registerImageTool();
  }
  return { getDebug };
}

export const _imageTest = {
  LITELLM_RESPONSES_PATH,
  DEFAULT_TIMEOUT_MS,
  OPENAI_IMAGE_TOOL,
  OPENAI_IMAGE_COMMAND,
  imageMimeType,
  dataUrlParts,
  extractImageFromEvent,
  displayPath,
  buildRequest,
};
