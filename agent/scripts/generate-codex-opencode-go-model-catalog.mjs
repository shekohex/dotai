#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * IDs come only from https://opencode.ai/docs/go/#endpoints. Capabilities use exact `opencode-go`
 * entries from https://models.dev/api.json.
 *
 * @type {VerifiedModel[]}
 */
const documentedResponsesModels = [
  {
    id: "gpt-5.6-luna",
    description: "Cost-efficient GPT-5.6 model for fast, high-volume workloads",
    contextWindow: 1_050_000,
    inputModalities: ["text", "image", "pdf"],
    name: "GPT-5.6 Luna",
    outputModalities: ["text"],
    reasoningOptions: [
      { type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] },
    ],
    toolCall: true,
  },
  {
    id: "grok-4.6",
    description:
      "xAI's frontier model for long-running agents, coding, knowledge work, and visual projects",
    contextWindow: 500_000,
    inputModalities: ["text", "image"],
    name: "Grok 4.6",
    outputModalities: ["text"],
    reasoningOptions: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }],
    toolCall: true,
  },
  {
    id: "muse-spark-1.2-contributor",
    description:
      "Muse Spark 1.2 is a coding-focused update to Muse Spark 1.1 with improvements in code generation, complex debugging, codebase understanding, and end-to-end developer workflows.",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image", "video", "pdf", "audio"],
    name: "Muse Spark 1.2 Contributor",
    outputModalities: ["text"],
    reasoningOptions: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }],
    toolCall: true,
  },
  {
    id: "muse-spark-1.3-contributor",
    description:
      "Muse Spark 1.3 is a multimodal reasoning model from Meta for coding and agentic workflows.",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image", "video", "pdf", "audio"],
    name: "Muse Spark 1.3 Contributor",
    outputModalities: ["text"],
    reasoningOptions: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }],
    toolCall: true,
  },
];
const defaultOutputPath = resolve(import.meta.dirname, "../../.codex/opencode-go-models.json");

/**
 * @typedef {{
 *   id: string;
 *   name: string;
 *   description: string;
 *   contextWindow: number;
 *   inputModalities: string[];
 *   outputModalities: string[];
 *   reasoningOptions: Array<{ type: string; values?: string[] }>;
 *   toolCall: boolean;
 * }} VerifiedModel
 */
/**
 * @typedef {Record<string, unknown> & {
 *   slug: string;
 *   display_name: string;
 *   experimental_supported_tools: unknown[];
 *   priority: number;
 *   shell_type: string;
 *   support_verbosity: boolean;
 *   supported_in_api: boolean;
 *   supported_reasoning_levels: unknown[];
 *   truncation_policy: Record<string, unknown>;
 *   visibility: string;
 * }} ModelInfo
 */
/** @typedef {{ models: ModelInfo[] }} CodexCatalog */
/** @typedef {{ effort: string; description: string }} ReasoningLevel */
/** @typedef {{ descriptions: Map<string, string>; effortOrder: string[] }} ReasoningMetadata */

const codexNamedReasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
];

if (isMain()) {
  try {
    await main();
  } catch (error) {
    console.error(`Error: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const codexRuntime = await loadCodexRuntime();
  const { catalog, bundledInstructionCount, fallbackInstructionCount } = buildCatalog(codexRuntime);
  await writeFile(outputPath, serializeCatalog(catalog), "utf8");
  console.log(`Wrote ${catalog.models.length} OpenCode Go models to ${outputPath}`);
  console.log(
    `Instructions: ${bundledInstructionCount} exact bundled; ${fallbackInstructionCount} installed Codex fallback (${codexRuntime.version})`,
  );
}

/**
 * @param {string[]} argumentsList - CLI arguments to parse.
 * @returns {string} Resolved output path.
 */
function parseOutputPath(argumentsList) {
  if (argumentsList.length === 0) {
    return defaultOutputPath;
  }
  if (argumentsList.length === 2 && argumentsList[0] === "--output") {
    return resolve(argumentsList[1]);
  }
  throw new Error("Usage: generate-codex-opencode-go-model-catalog.mjs [--output <path>]");
}

/**
 * @param {CodexCatalog} catalog - Catalog to serialize deterministically.
 * @returns {string} Canonical JSON with two-space indentation and a final newline.
 */
function serializeCatalog(catalog) {
  return `${JSON.stringify(sortObjectKeys(catalog), null, 2)}\n`;
}

/**
 * @param {unknown} value - JSON-compatible value.
 * @returns {unknown} Value with every object ordered by UTF-8 key bytes.
 */
function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((childValue) => sortObjectKeys(childValue));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    sortEntriesByKey(Object.entries(value)).map(([key, childValue]) => [
      key,
      sortObjectKeys(childValue),
    ]),
  );
}

/**
 * @param {[string, unknown][]} entries - Object entries to order.
 * @returns {[string, unknown][]} Entries ordered by UTF-8 key bytes.
 */
function sortEntriesByKey(entries) {
  /** @type {[string, unknown][]} */
  const sortedEntries = [];
  for (const entry of entries) {
    const insertionIndex = sortedEntries.findIndex(
      ([sortedKey]) => compareUtf8Bytes(entry[0], sortedKey) < 0,
    );
    sortedEntries.splice(insertionIndex === -1 ? sortedEntries.length : insertionIndex, 0, entry);
  }
  return sortedEntries;
}

/**
 * @param {string} left - First string.
 * @param {string} right - Second string.
 * @returns {number} UTF-8 bytewise comparison result.
 */
function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * @returns {Promise<{
 *   bundledCatalog: CodexCatalog;
 *   fallbackInstructions: string;
 *   version: string;
 * }>}
 *   Installed Codex metadata and unknown-model fallback instructions.
 */
async function loadCodexRuntime() {
  return {
    bundledCatalog: loadBundledCatalog(),
    fallbackInstructions: await captureFallbackInstructions(),
    version: loadCodexVersion(),
  };
}

/** @returns {string} Installed Codex version string. */
function loadCodexVersion() {
  try {
    const version = execFileSync("codex", ["--version"], {
      encoding: "utf8",
    }).trim();
    if (version.length === 0) {
      throw new Error("empty version output");
    }
    return version;
  } catch (error) {
    throw new Error(`Could not read the installed Codex version: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
}

/** @returns {Promise<string>} Canonical instructions used by installed Codex for an unknown model. */
async function captureFallbackInstructions() {
  const captureHome = await mkdtemp(join(tmpdir(), "codex-model-instructions-"));
  /** @type {string | undefined} */
  let capturedInstructions;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        /** @type {unknown} */
        const payload = JSON.parse(body);
        if (
          isRecord(payload) &&
          typeof payload.instructions === "string" &&
          payload.instructions.length > 0
        ) {
          capturedInstructions = payload.instructions;
        }
      } catch {
        // The actionable error below covers missing or malformed capture payloads.
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "instruction capture complete" } }));
    });
  });

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("loopback server did not expose a TCP port");
    }
    await writeFile(
      join(captureHome, "config.toml"),
      [
        'model_provider = "instruction-capture"',
        "",
        "[model_providers.instruction-capture]",
        'name = "Instruction capture"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "supports_websockets = false",
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "",
      ].join("\n"),
      "utf8",
    );

    const codexEnvironment = { ...process.env, CODEX_HOME: captureHome };
    delete codexEnvironment.CODEX_API_KEY;
    delete codexEnvironment.LITELLM_API_KEY;
    delete codexEnvironment.OPENAI_API_KEY;
    const codexProcess = spawn(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        "dotai-external-model-instruction-probe",
        "Return no output.",
      ],
      {
        cwd: captureHome,
        env: codexEnvironment,
        stdio: "ignore",
      },
    );
    await waitForProcess(codexProcess, 15_000);

    if (capturedInstructions === undefined) {
      throw new Error(
        "Installed Codex did not send fallback instructions to the loopback Responses endpoint.",
      );
    }
    return capturedInstructions;
  } finally {
    await new Promise((resolvePromise) => {
      server.close(() => {
        resolvePromise();
      });
    });
    await rm(captureHome, { recursive: true, force: true });
  }
}

/**
 * @param {import("node:child_process").ChildProcess} childProcess - Codex fallback probe.
 * @param {number} timeoutMilliseconds - Maximum probe duration.
 * @returns {Promise<void>} Resolves when the process exits or is terminated at the timeout.
 */
async function waitForProcess(childProcess, timeoutMilliseconds) {
  await new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      childProcess.kill();
    }, timeoutMilliseconds);
    childProcess.once("close", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

/** @returns {CodexCatalog} Bundled catalog from installed Codex. */
function loadBundledCatalog() {
  /** @type {string} */
  let stdout;
  try {
    stdout = execFileSync("codex", ["debug", "models", "--bundled"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Could not read the bundled Codex model catalog. Ensure Codex 0.154 is installed and on PATH: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  /** @type {unknown} */
  let catalog;
  try {
    catalog = JSON.parse(stdout);
  } catch {
    throw new Error("codex debug models --bundled returned invalid JSON.");
  }
  if (
    !isRecord(catalog) ||
    !Array.isArray(catalog.models) ||
    catalog.models.length === 0 ||
    !catalog.models.every(isModelInfo)
  ) {
    throw new Error("codex debug models --bundled returned an unsupported catalog shape.");
  }
  return catalog;
}

/**
 * @param {{ bundledCatalog: CodexCatalog; fallbackInstructions: string }} codexRuntime - Installed
 *   Codex metadata.
 * @returns {{
 *   catalog: CodexCatalog;
 *   bundledInstructionCount: number;
 *   fallbackInstructionCount: number;
 * }}
 *   OpenCode Go catalog and instruction provenance counts.
 */
function buildCatalog(codexRuntime) {
  const { bundledCatalog, fallbackInstructions } = codexRuntime;
  /** @type {Map<string, ModelInfo>} */
  const bundledModelsBySlug = new Map(bundledCatalog.models.map((model) => [model.slug, model]));
  const fallbackTemplate =
    bundledModelsBySlug.get("gpt-5.5") ??
    bundledCatalog.models.find((model) => model.visibility === "list" && model.supported_in_api);
  if (fallbackTemplate === undefined) {
    throw new Error("Bundled Codex catalog has no public model for fallback metadata.");
  }
  const reasoningMetadata = createReasoningMetadata(bundledCatalog.models);

  const incompatibleModel = documentedResponsesModels.find(
    (model) =>
      !model.toolCall ||
      !model.inputModalities.includes("text") ||
      !model.outputModalities.includes("text"),
  );
  if (incompatibleModel !== undefined) {
    throw new Error(
      `Documented Responses model ${incompatibleModel.id} is not a text tool-calling agent in models.dev.`,
    );
  }

  let bundledInstructionCount = 0;
  let fallbackInstructionCount = 0;
  const models = sortModelsById(documentedResponsesModels).map((verifiedModel, index) => {
    const bundledModel = bundledModelsBySlug.get(verifiedModel.id);
    if (bundledModel !== undefined) {
      bundledInstructionCount += 1;
      return withoutVolatileFields(bundledModel);
    }
    fallbackInstructionCount += 1;
    return createFallbackModel(
      fallbackTemplate,
      fallbackInstructions,
      reasoningMetadata,
      verifiedModel,
      index,
    );
  });

  return {
    catalog: { models },
    bundledInstructionCount,
    fallbackInstructionCount,
  };
}

/**
 * @param {VerifiedModel[]} models - Models to order.
 * @returns {VerifiedModel[]} Models ordered by UTF-8 ID bytes.
 */
function sortModelsById(models) {
  /** @type {VerifiedModel[]} */
  const sortedModels = [];
  for (const model of models) {
    const insertionIndex = sortedModels.findIndex(
      (sortedModel) => compareUtf8Bytes(model.id, sortedModel.id) < 0,
    );
    sortedModels.splice(insertionIndex === -1 ? sortedModels.length : insertionIndex, 0, model);
  }
  return sortedModels;
}

/**
 * @param {ModelInfo} template - Public bundled model used for required schema fields.
 * @param {string} fallbackInstructions - Exact unknown-model instructions captured from Codex.
 * @param {ReasoningMetadata} reasoningMetadata - Installed Codex effort metadata.
 * @param {VerifiedModel} verifiedModel - Exact models.dev OpenCode Go metadata.
 * @param {number} index - Position in canonical model order.
 * @returns {ModelInfo} Conservative metadata for an unknown model.
 */
function createFallbackModel(
  template,
  fallbackInstructions,
  reasoningMetadata,
  verifiedModel,
  index,
) {
  return {
    base_instructions: fallbackInstructions,
    context_window: verifiedModel.contextWindow,
    description: verifiedModel.description,
    display_name: verifiedModel.name,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"].filter((modality) =>
      verifiedModel.inputModalities.includes(modality),
    ),
    max_context_window: verifiedModel.contextWindow,
    priority: 1000 + index,
    shell_type: template.shell_type,
    slug: verifiedModel.id,
    support_verbosity: false,
    supported_in_api: true,
    supported_reasoning_levels: normalizeReasoningEfforts(verifiedModel, reasoningMetadata).map(
      (effort) => ({
        description: reasoningMetadata.descriptions.get(effort) ?? "",
        effort,
      }),
    ),
    supports_image_detail_original: false,
    supports_reasoning_summary_parameter: false,
    supports_search_tool: false,
    truncation_policy: structuredClone(template.truncation_policy),
    visibility: "list",
  };
}

/**
 * @param {ModelInfo[]} bundledModels - Installed bundled Codex models.
 * @returns {ReasoningMetadata} Accepted effort order and installed descriptions.
 */
function createReasoningMetadata(bundledModels) {
  /** @type {{ levels: ReasoningLevel[] }[]} */
  const modelsByCoverage = [];
  for (const model of bundledModels) {
    const entry = { levels: readReasoningLevels(model) };
    const insertionIndex = modelsByCoverage.findIndex(
      (existingEntry) => entry.levels.length > existingEntry.levels.length,
    );
    modelsByCoverage.splice(
      insertionIndex === -1 ? modelsByCoverage.length : insertionIndex,
      0,
      entry,
    );
  }
  /** @type {Map<string, string>} */
  const descriptions = new Map();
  for (const { levels } of modelsByCoverage) {
    for (const level of levels) {
      if (!descriptions.has(level.effort)) {
        descriptions.set(level.effort, level.description);
      }
    }
  }
  return { descriptions, effortOrder: codexNamedReasoningEfforts };
}

/**
 * @param {ModelInfo} model - Bundled ModelInfo.
 * @returns {ReasoningLevel[]} Valid named levels.
 */
function readReasoningLevels(model) {
  /** @type {ReasoningLevel[]} */
  const levels = [];
  for (const level of model.supported_reasoning_levels) {
    if (
      isRecord(level) &&
      codexNamedReasoningEfforts.includes(level.effort) &&
      typeof level.description === "string" &&
      level.description.trim().length > 0
    ) {
      levels.push({ effort: level.effort, description: level.description });
    }
  }
  return levels;
}

/**
 * @param {VerifiedModel} verifiedModel - Exact models.dev model record.
 * @param {ReasoningMetadata} reasoningMetadata - Installed Codex effort metadata.
 * @returns {string[]} Supported effort values in Codex enum order.
 */
function normalizeReasoningEfforts(verifiedModel, reasoningMetadata) {
  const advertisedEfforts = new Set(
    verifiedModel.reasoningOptions
      .filter((option) => option.type === "effort" && Array.isArray(option.values))
      .flatMap((option) => option.values)
      .map((effort) => normalizeNonEmptyString(effort))
      .filter((effort) => effort !== null && effort !== "none"),
  );
  return reasoningMetadata.effortOrder.filter((effort) => advertisedEfforts.has(effort));
}

/**
 * @param {unknown} value - Possible user-facing string.
 * @returns {string | null} Trimmed non-empty string or no evidence.
 */
function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * @param {ModelInfo} model - Exact bundled model metadata.
 * @returns {ModelInfo} Stable bundled metadata without runtime cache fields.
 */
function withoutVolatileFields(model) {
  const stableModel = structuredClone(model);
  delete stableModel.comp_hash;
  return stableModel;
}

/**
 * @param {unknown} value - Value to inspect.
 * @returns {value is Record<string, unknown>} Whether value is a record.
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value - Candidate model entry.
 * @returns {value is ModelInfo} Whether entry has a model slug.
 */
function isModelInfo(value) {
  return (
    isRecord(value) &&
    typeof value.slug === "string" &&
    value.slug.length > 0 &&
    typeof value.display_name === "string" &&
    Array.isArray(value.experimental_supported_tools) &&
    typeof value.priority === "number" &&
    Number.isInteger(value.priority) &&
    typeof value.shell_type === "string" &&
    typeof value.support_verbosity === "boolean" &&
    typeof value.supported_in_api === "boolean" &&
    Array.isArray(value.supported_reasoning_levels) &&
    isRecord(value.truncation_policy) &&
    typeof value.visibility === "string" &&
    (typeof value.base_instructions === "string" ||
      (isRecord(value.model_messages) &&
        typeof value.model_messages.instructions_template === "string"))
  );
}

/**
 * @param {unknown} error - Caught value.
 * @returns {string} Safe error description.
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
}
