import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const OPENAI_IMAGE_TOOL = "generate_image";
export const OPENAI_IMAGE_COMMAND = "imagen";
export const OPENAI_IMAGE_PROMPT_GUIDELINES = [
  `Always use ${OPENAI_IMAGE_TOOL} when the user asks to generate or edit a raster image, photo, illustration, mockup, texture, sprite, bitmap asset, or any visual artwork. Do not answer with text only for image-generation requests.`,
  `Prefer calling ${OPENAI_IMAGE_TOOL} instead of any other tool when generating or editing images for the user.`,
  "Pass the user's image prompt verbatim. Do not embellish, rewrite, add camera/style details, or add negative prompt terms unless the user explicitly asks you to refine the prompt.",
  `Use ${OPENAI_IMAGE_TOOL} with images for local reference images or edit targets; save project assets into the workspace when requested.`,
  `Prefer ${OPENAI_IMAGE_TOOL} over any built-in or provider-hosted image tool for raster image generation/editing in this project.`,
];
export const OPENAI_IMAGE_SYSTEM_PROMPT = [
  "Image Generation Routing:",
  ...OPENAI_IMAGE_PROMPT_GUIDELINES.map((guideline) => `- ${guideline}`),
].join("\n");

export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_ACTIONS = ["auto", "generate", "edit"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

export type ImageSaveMode = (typeof IMAGE_SAVE_MODES)[number];
export type ImageAction = (typeof IMAGE_ACTIONS)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];

export const ToolParamsSchema = Type.Object({
  prompt: Type.String({
    description:
      "Image generation/editing prompt. Pass the user's wording verbatim unless they explicitly ask you to refine or expand it.",
  }),
  action: Type.Optional(
    StringEnum(IMAGE_ACTIONS, {
      description:
        "Whether to generate a new image, edit/reference provided images, or let the model decide.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: "Local image paths to use as edit targets or references.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "OpenAI Responses model to drive the hosted image_generation tool. Defaults to current codex-openai model or settings default.",
    }),
  ),
  outputFormat: Type.Optional(
    StringEnum(IMAGE_OUTPUT_FORMATS, { description: "Generated image format." }),
  ),
  save: Type.Optional(StringEnum(IMAGE_SAVE_MODES, { description: "Where to save the image." })),
  saveDir: Type.Optional(Type.String({ description: "Directory to save image when save=custom." })),
});

export const ImageGenerationCallSchema = Type.Object(
  {
    type: Type.Literal("image_generation_call"),
    id: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    revised_prompt: Type.Optional(Type.String()),
    result: Type.Optional(Type.String()),
    b64_json: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const CodexImageResultSchema = Type.Object(
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
);

export type ToolParams = Static<typeof ToolParamsSchema>;
export type ImageGenerationCall = Static<typeof ImageGenerationCallSchema>;
