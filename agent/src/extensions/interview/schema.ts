import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const MarkdownLangSchema = Type.Union([Type.Literal("md"), Type.Literal("markdown")]);
const QuestionTypeSchema = Type.Union([
  Type.Literal("single"),
  Type.Literal("multi"),
  Type.Literal("text"),
  Type.Literal("image"),
  Type.Literal("info"),
]);
const ConvictionSchema = Type.Union([Type.Literal("strong"), Type.Literal("slight")]);
const WeightSchema = Type.Union([Type.Literal("critical"), Type.Literal("minor")]);
const MediaPositionSchema = Type.Union([
  Type.Literal("above"),
  Type.Literal("below"),
  Type.Literal("side"),
]);
const MediaTypeSchema = Type.Union([
  Type.Literal("image"),
  Type.Literal("chart"),
  Type.Literal("mermaid"),
  Type.Literal("table"),
  Type.Literal("html"),
]);

export const ContentBlockSchema = Type.Object(
  {
    source: Type.String(),
    lang: Type.Optional(Type.String()),
    file: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    lines: Type.Optional(Type.String()),
    highlights: Type.Optional(Type.Array(Type.Number())),
    showSource: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type ContentBlock = Static<typeof ContentBlockSchema>;

export const RichOptionSchema = Type.Object(
  {
    label: Type.String(),
    content: Type.Optional(ContentBlockSchema),
    recommended: Type.Optional(Type.Boolean()),
    conviction: Type.Optional(ConvictionSchema),
  },
  { additionalProperties: false },
);

export type RichOption = Static<typeof RichOptionSchema>;

export const OptionValueSchema = Type.Union([Type.String(), RichOptionSchema]);

export type OptionValue = Static<typeof OptionValueSchema>;

const ChartSchema = Type.Object(
  {
    type: Type.String(),
    data: Type.Record(Type.String(), Type.Unknown()),
    options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const TableSchema = Type.Object(
  {
    headers: Type.Array(Type.String()),
    rows: Type.Array(Type.Array(Type.String())),
    highlights: Type.Optional(Type.Array(Type.Number())),
  },
  { additionalProperties: false },
);

export const MediaBlockSchema = Type.Object(
  {
    type: MediaTypeSchema,
    src: Type.Optional(Type.String()),
    alt: Type.Optional(Type.String()),
    chart: Type.Optional(ChartSchema),
    mermaid: Type.Optional(Type.String()),
    table: Type.Optional(TableSchema),
    html: Type.Optional(Type.String()),
    caption: Type.Optional(Type.String()),
    position: Type.Optional(MediaPositionSchema),
    maxHeight: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type MediaBlock = Static<typeof MediaBlockSchema>;

export const QuestionSchema = Type.Object(
  {
    id: Type.String(),
    type: QuestionTypeSchema,
    question: Type.String(),
    options: Type.Optional(Type.Array(OptionValueSchema, { minItems: 1 })),
    recommended: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    conviction: Type.Optional(ConvictionSchema),
    weight: Type.Optional(WeightSchema),
    context: Type.Optional(Type.String()),
    content: Type.Optional(ContentBlockSchema),
    media: Type.Optional(Type.Union([MediaBlockSchema, Type.Array(MediaBlockSchema)])),
  },
  { additionalProperties: false },
);

export type Question = Static<typeof QuestionSchema>;

export const QuestionsFileSchema = Type.Object(
  {
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    questions: Type.Array(QuestionSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type QuestionsFile = Static<typeof QuestionsFileSchema>;

export function getOptionLabel(option: OptionValue): string {
  return typeof option === "string" ? option : option.label;
}

export function isRichOption(option: OptionValue): option is RichOption {
  return typeof option !== "string";
}

function normalizeOptionLevelRecommendations(question: Question): void {
  if (!question.options) return;

  const recommendedOptions: RichOption[] = [];
  const convictions = new Set<Static<typeof ConvictionSchema>>();
  const richOptions: RichOption[] = [];

  for (const option of question.options) {
    if (!isRichOption(option)) continue;
    richOptions.push(option);
    if (option.conviction !== undefined && option.recommended !== true) {
      throw new Error(
        `Question "${question.id}" option "${option.label}": conviction requires recommended`,
      );
    }
    if (option.recommended !== true) continue;
    recommendedOptions.push(option);
    if (option.conviction) convictions.add(option.conviction);
  }

  if (recommendedOptions.length === 0) return;

  if (question.recommended !== undefined || question.conviction !== undefined) {
    throw new Error(
      `Question "${question.id}": use either question-level recommended/conviction or option-level recommended flags, not both`,
    );
  }

  if (question.type === "single" && recommendedOptions.length !== 1) {
    throw new Error(
      `Question "${question.id}": exactly one option must be recommended for single-select`,
    );
  }

  if (convictions.size > 1) {
    throw new Error(`Question "${question.id}": recommended options must use same conviction`);
  }

  for (const option of richOptions) {
    delete option.recommended;
    delete option.conviction;
  }

  const recommendedLabels = recommendedOptions.map((option) => option.label);
  question.recommended = question.type === "single" ? recommendedLabels[0] : recommendedLabels;
  const conviction = convictions.values().next().value;
  if (conviction !== undefined) {
    question.conviction = conviction;
  }
}

const SCHEMA_EXAMPLE = `Expected format:
{
  "title": "Optional Title",
  "questions": [
    { "id": "q1", "type": "single", "question": "Pick one?", "options": ["A", "B"] },
    { "id": "q2", "type": "multi", "question": "Pick many?", "options": ["X", "Y", "Z"] },
    { "id": "q3", "type": "text", "question": "Describe?" },
    { "id": "q4", "type": "image", "question": "Upload?" }
  ]
}
Valid types: single, multi, text, image, info
Options: array of strings or objects with { label, content? }`;

function isMarkdownLang(lang: string | undefined): lang is Static<typeof MarkdownLangSchema> {
  if (typeof lang !== "string") return false;
  const normalized = lang.trim().toLowerCase();
  return normalized === "md" || normalized === "markdown";
}

function normalizeMarkdownLang(lang: string): Static<typeof MarkdownLangSchema> {
  return lang.trim().toLowerCase() === "md" ? "md" : "markdown";
}

function validateContentBlock(block: ContentBlock, context: string): ContentBlock {
  if (isMarkdownLang(block.lang)) {
    if (block.lines !== undefined) {
      throw new Error(`${context}: content.lines is not allowed for markdown content`);
    }
    if (block.highlights !== undefined) {
      throw new Error(`${context}: content.highlights is not allowed for markdown content`);
    }
    return {
      ...block,
      lang: normalizeMarkdownLang(block.lang),
    };
  }

  if (block.showSource !== undefined) {
    throw new Error(
      `${context}: content.showSource is only valid when content.lang is "md" or "markdown"`,
    );
  }

  return block;
}

function validateMediaBlock(block: MediaBlock, context: string): MediaBlock {
  if (block.type === "image" && typeof block.src !== "string") {
    throw new Error(`${context}: media.src required for image type`);
  }
  if (block.type === "chart" && !block.chart) {
    throw new Error(`${context}: media.chart required for chart type`);
  }
  if (block.type === "mermaid" && typeof block.mermaid !== "string") {
    throw new Error(`${context}: media.mermaid required for mermaid type`);
  }
  if (block.type === "table" && !block.table) {
    throw new Error(`${context}: media.table required for table type`);
  }
  if (block.type === "html" && typeof block.html !== "string") {
    throw new Error(`${context}: media.html required for html type`);
  }

  return block;
}

function validateOption(option: OptionValue, questionId: string): OptionValue {
  if (typeof option === "string") {
    return option;
  }

  if (option.content === undefined) {
    return option;
  }

  return {
    ...option,
    content: validateContentBlock(
      option.content,
      `Question "${questionId}" option "${option.label}"`,
    ),
  };
}

function formatSchemaPath(instancePath: string): string {
  if (instancePath.length === 0) {
    return "root";
  }

  const parts = instancePath.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(".") : "root";
}

function formatSchemaError(data: unknown): string {
  const firstError = [...Value.Errors(QuestionsFileSchema, data)][0];
  if (firstError === undefined) {
    return `Invalid questions file.\n\n${SCHEMA_EXAMPLE}`;
  }

  return `Invalid questions file at ${formatSchemaPath(firstError.instancePath)}: ${firstError.message}.\n\n${SCHEMA_EXAMPLE}`;
}

function validateBasicStructure(data: unknown): QuestionsFile {
  if (Array.isArray(data)) {
    throw new TypeError(
      `Invalid questions file: root must be object, not array.\n\n${SCHEMA_EXAMPLE}`,
    );
  }

  if (!Value.Check(QuestionsFileSchema, data)) {
    throw new TypeError(formatSchemaError(data));
  }

  const parsed = Value.Parse(QuestionsFileSchema, data);

  for (const question of parsed.questions) {
    if (question.content !== undefined) {
      question.content = validateContentBlock(question.content, `Question "${question.id}"`);
    }

    if (question.options !== undefined) {
      question.options = question.options.map((option) => validateOption(option, question.id));
    }

    if (question.media !== undefined) {
      question.media = Array.isArray(question.media)
        ? question.media.map((media, index) =>
            validateMediaBlock(media, `Question "${question.id}" media[${index}]`),
          )
        : validateMediaBlock(question.media, `Question "${question.id}" media[0]`);
    }
  }

  return parsed;
}

export function validateQuestions(data: unknown): QuestionsFile {
  const parsed = validateBasicStructure(data);

  const ids = new Set<string>();
  for (const question of parsed.questions) {
    if (ids.has(question.id)) {
      throw new Error(`Duplicate question id: "${question.id}"`);
    }
    ids.add(question.id);
  }

  for (const question of parsed.questions) {
    if (question.type === "single" || question.type === "multi") {
      if (!question.options || question.options.length === 0) {
        throw new Error(`Question "${question.id}": options required for type "${question.type}"`);
      }
      normalizeOptionLevelRecommendations(question);
    } else if (
      (question.type === "text" || question.type === "image" || question.type === "info") &&
      question.options !== undefined
    ) {
      throw new Error(`Question "${question.id}": options not allowed for type "${question.type}"`);
    }

    if (question.conviction !== undefined && question.recommended === undefined) {
      throw new Error(`Question "${question.id}": conviction requires recommended`);
    }

    if (question.recommended === undefined) {
      continue;
    }

    if (question.type === "text" || question.type === "image" || question.type === "info") {
      throw new Error(
        `Question "${question.id}": recommended not allowed for type "${question.type}"`,
      );
    }

    const optionLabels = question.options?.map(getOptionLabel) ?? [];

    if (question.type === "single") {
      if (Array.isArray(question.recommended) && question.recommended.length === 1) {
        question.recommended = question.recommended[0];
      }
      if (typeof question.recommended !== "string") {
        throw new TypeError(
          `Question "${question.id}": recommended must be string for single-select`,
        );
      }
      if (!optionLabels.includes(question.recommended)) {
        throw new Error(
          `Question "${question.id}": recommended "${question.recommended}" not in options`,
        );
      }
      continue;
    }

    const recommendedValues = Array.isArray(question.recommended)
      ? question.recommended
      : [question.recommended];
    for (const recommended of recommendedValues) {
      if (!optionLabels.includes(recommended)) {
        throw new Error(`Question "${question.id}": recommended "${recommended}" not in options`);
      }
    }
    if (!Array.isArray(question.recommended)) {
      question.recommended = recommendedValues;
    }
  }

  return parsed;
}

export function sanitizeLLMJSON(input: string): string {
  let json = input.trim();

  const fenceMatch = json.match(/^`{3,}(?:json|jsonc)?\s*\n([\s\S]*?)\n\s*`{3,}\s*$/i);
  if (fenceMatch) {
    json = fenceMatch[1];
  }

  json = json.replaceAll(/^\s*\/\/.*$/gm, "");
  json = json.replaceAll(/,(\s*[}\]])/g, "$1");
  json = json.replaceAll(/\u201C|\u201D/g, '"');

  return json.trim();
}
