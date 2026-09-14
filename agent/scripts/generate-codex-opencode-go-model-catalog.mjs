#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const defaultEndpoint = "https://opencode.ai/zen/go/v1/models";
const defaultModelsDevEndpoint = "https://models.dev/api.json";
const defaultOutputPath = resolve(import.meta.dirname, "../../.codex/opencode-go-models.json");
const authHelperPath = resolve(import.meta.dirname, "../../.codex/pi-agent-auth.mjs");

/**
 * @typedef {{
 *   id: string;
 *   object: "model";
 *   created: number;
 *   owned_by: string;
 * }} ExposedModel
 */
/** @typedef {{ object: "list"; data: ExposedModel[] }} ModelsResponse */
/**
 * @typedef {Record<string, unknown> & {
 *   id: string;
 *   name?: string;
 *   modalities?: { input?: string[]; output?: string[] };
 *   tool_call?: boolean;
 *   limit?: { context?: number };
 *   reasoning?: boolean;
 *   reasoning_options?: { type?: string; values?: string[] }[];
 * }} ModelsDevModel
 */
/** @typedef {Map<string, ModelsDevModel>} ModelsDevIndex */
/** @typedef {{ endpoint: string; modelsDevEndpoint: string; outputPath: string; help: boolean }} GeneratorOptions */
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
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const apiKey = loadApiKey();
  const [exposedModels, modelsDevIndex, codexRuntime] = await Promise.all([
    fetchExposedModels(options.endpoint, apiKey),
    fetchModelsDevIndex(options.modelsDevEndpoint),
    loadCodexRuntime(),
  ]);
  const { catalog, report } = buildCatalog(exposedModels, modelsDevIndex, codexRuntime);
  await writeFile(options.outputPath, serializeCatalog(catalog), "utf8");
  console.log(`Wrote ${catalog.models.length} OpenCode Go models to ${options.outputPath}`);
  console.log(
    `Excluded ${report.excluded} non-agent models: ${formatCounts(report.excludedReasons)}`,
  );
  console.log(
    `Instructions: bundled=${report.bundledInstructions}; fallback=${report.fallbackInstructions} (${codexRuntime.version})`,
  );
  console.log(
    `Capabilities: ${report.enriched} exact models.dev matches; ${report.aliased} models.dev family aliases; ${report.unmatched} retained without models.dev metadata`,
  );
}

/**
 * @param {string[]} argumentsList - CLI arguments to parse.
 * @returns {GeneratorOptions} Parsed generator options.
 */
function parseArguments(argumentsList) {
  const options = {
    endpoint: defaultEndpoint,
    modelsDevEndpoint: defaultModelsDevEndpoint,
    outputPath: defaultOutputPath,
    help: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--endpoint") {
      options.endpoint = readOptionValue(argumentsList, ++index, argument);
    } else if (argument === "--models-dev-endpoint") {
      options.modelsDevEndpoint = readOptionValue(argumentsList, ++index, argument);
    } else if (argument === "--output") {
      options.outputPath = resolve(readOptionValue(argumentsList, ++index, argument));
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

/**
 * @param {string[]} argumentsList - Arguments to parse.
 * @param {number} index - Option value index.
 * @param {string} option - Option name.
 * @returns {string} Option value.
 */
function readOptionValue(argumentsList, index, option) {
  const value = argumentsList[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

/** @returns {string} OpenCode Go API key without printing it. */
function loadApiKey() {
  const configuredKey = process.env.OPENCODE_GO_API_KEY?.trim();
  if (configuredKey !== undefined && configuredKey.length > 0) {
    return configuredKey;
  }

  try {
    const key = execFileSync(process.execPath, [authHelperPath, "opencode-go"], {
      encoding: "utf8",
    }).trim();
    if (key.length === 0) {
      throw new Error("empty key output");
    }
    return key;
  } catch (error) {
    throw new Error(
      `Could not read the OpenCode Go API key. Set OPENCODE_GO_API_KEY or configure Pi auth: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {string} endpoint - OpenCode Go models endpoint.
 * @param {string} apiKey - Bearer token for the endpoint.
 * @returns {Promise<ExposedModel[]>} Validated, unique exposed models.
 */
async function fetchExposedModels(endpoint, apiKey) {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Could not fetch ${endpoint}: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error(
      `GET ${endpoint} returned HTTP ${response.status}. Check the endpoint and key.`,
    );
  }

  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new Error(`GET ${endpoint} returned invalid JSON.`);
  }
  if (!isStandardModelsResponse(payload)) {
    throw new Error(
      `GET ${endpoint} did not return an OpenAI-compatible models list with object="list" and standard model entries.`,
    );
  }
  return deduplicateModels(payload.data);
}

/**
 * @param {string} endpoint - Models.dev API endpoint.
 * @returns {Promise<ModelsDevIndex>} Exact OpenCode Go model metadata by ID.
 */
async function fetchModelsDevIndex(endpoint) {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`Could not fetch ${endpoint}: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`GET ${endpoint} returned HTTP ${response.status}.`);
  }

  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new Error(`GET ${endpoint} returned invalid JSON.`);
  }
  if (!isModelsDevCatalog(payload)) {
    throw new Error(`GET ${endpoint} returned an unsupported models.dev catalog shape.`);
  }

  const provider = payload["opencode-go"];
  if (!isRecord(provider) || !isRecord(provider.models)) {
    throw new Error(`GET ${endpoint} did not contain an opencode-go provider catalog.`);
  }
  /** @type {ModelsDevIndex} */
  const models = new Map();
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (isModelsDevModel(model) && model.id === modelId) {
      models.set(modelId, model);
    }
  }
  return models;
}

/**
 * @param {unknown} payload - Parsed models.dev response.
 * @returns {payload is Record<string, { models: Record<string, unknown> }>} Valid catalog shape.
 */
function isModelsDevCatalog(payload) {
  return (
    isRecord(payload) &&
    Object.keys(payload).length > 0 &&
    Object.values(payload).every((provider) => isRecord(provider) && isRecord(provider.models))
  );
}

/**
 * @param {unknown} model - Candidate models.dev model.
 * @returns {model is ModelsDevModel} Whether model has an exact ID.
 */
function isModelsDevModel(model) {
  return isRecord(model) && typeof model.id === "string" && model.id.length > 0;
}

/**
 * @param {unknown} payload - Parsed endpoint response.
 * @returns {payload is ModelsResponse} Whether payload is a standard models response.
 */
function isStandardModelsResponse(payload) {
  return (
    isRecord(payload) &&
    payload.object === "list" &&
    Array.isArray(payload.data) &&
    payload.data.length > 0 &&
    payload.data.every(isStandardModel)
  );
}

/**
 * @param {unknown} model - Candidate endpoint model entry.
 * @returns {model is ExposedModel} Whether model has standard fields.
 */
function isStandardModel(model) {
  return (
    isRecord(model) &&
    typeof model.id === "string" &&
    model.id.length > 0 &&
    model.object === "model" &&
    typeof model.created === "number" &&
    Number.isInteger(model.created) &&
    typeof model.owned_by === "string" &&
    model.owned_by.length > 0
  );
}

/**
 * @param {ExposedModel[]} models - Validated endpoint models.
 * @returns {ExposedModel[]} Unique models ordered by ID.
 */
function deduplicateModels(models) {
  /** @type {Map<string, ExposedModel>} */
  const modelsById = new Map();
  for (const model of models) {
    if (!modelsById.has(model.id)) {
      modelsById.set(model.id, model);
    }
  }
  return sortModelsById([...modelsById.values()]);
}

/**
 * @param {ExposedModel[]} models - Models to order.
 * @returns {ExposedModel[]} Models ordered by UTF-8 ID bytes.
 */
function sortModelsById(models) {
  /** @type {ExposedModel[]} */
  const sortedModels = [];
  for (const model of models) {
    const insertionIndex = sortedModels.findIndex(
      (sortedModel) => compareUtf8Bytes(model.id, sortedModel.id) < 0,
    );
    sortedModels.splice(insertionIndex === -1 ? sortedModels.length : insertionIndex, 0, model);
  }
  return sortedModels;
}

function printUsage() {
  console.log(`Usage: node agent/scripts/generate-codex-opencode-go-model-catalog.mjs [options]

Options:
  --endpoint <url>             OpenCode Go models endpoint (default: ${defaultEndpoint})
  --models-dev-endpoint <url>  Capability catalog (default: ${defaultModelsDevEndpoint})
  --output <path>              Catalog output (default: ${defaultOutputPath})
  -h, --help                   Show this help`);
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
 * @template T
 * @param {[string, T][]} entries - Object entries to order.
 * @returns {[string, T][]} Entries ordered by UTF-8 key bytes.
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
 * @param {ExposedModel[]} exposedModels - Models returned by OpenCode Go.
 * @param {ModelsDevIndex} modelsDevIndex - Exact models.dev OpenCode Go metadata.
 * @param {{ bundledCatalog: CodexCatalog; fallbackInstructions: string }} codexRuntime - Installed
 *   Codex metadata.
 * @returns {{
 *   catalog: CodexCatalog;
 *   report: {
 *     excluded: number;
 *     excludedReasons: Map<string, number>;
 *     bundledInstructions: number;
 *     fallbackInstructions: number;
 *     enriched: number;
 *     aliased: number;
 *     unmatched: number;
 *   };
 * }}
 *   OpenCode Go catalog and generation report.
 */
function buildCatalog(exposedModels, modelsDevIndex, codexRuntime) {
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

  const report = {
    excluded: 0,
    excludedReasons: new Map(),
    bundledInstructions: 0,
    fallbackInstructions: 0,
    enriched: 0,
    aliased: 0,
    unmatched: 0,
  };
  const models = [];
  for (const exposedModel of exposedModels) {
    const idExclusionReason = getIdExclusionReason(exposedModel.id);
    const metadataResolution = resolveModelsDevModel(exposedModel.id, modelsDevIndex);
    const capabilityMetadata = metadataResolution.model;
    const hasReliableMetadata =
      capabilityMetadata !== undefined && hasReliableAgentCapabilityMetadata(capabilityMetadata);
    if (
      idExclusionReason !== undefined ||
      (hasReliableMetadata && !isAgentCapableModel(capabilityMetadata))
    ) {
      recordExclusion(report, idExclusionReason ?? "models.dev lacks required agent capabilities");
      continue;
    }

    const bundledModel = bundledModelsBySlug.get(exposedModel.id);
    if (bundledModel !== undefined) {
      report.bundledInstructions += 1;
      models.push(withoutVolatileFields(bundledModel));
      continue;
    }
    if (metadataResolution.source === "none") {
      report.unmatched += 1;
    } else if (metadataResolution.source === "exact") {
      report.enriched += 1;
    } else {
      report.aliased += 1;
    }
    report.fallbackInstructions += 1;
    models.push(
      createFallbackModel(
        fallbackTemplate,
        fallbackInstructions,
        exposedModel.id,
        models.length,
        resolveModelsDevMetadata(capabilityMetadata, reasoningMetadata),
      ),
    );
  }

  return {
    catalog: { models },
    report,
  };
}

/**
 * @param {string} modelId - Exposed OpenCode Go model ID.
 * @param {ModelsDevIndex} modelsDevIndex - Exact models.dev OpenCode Go metadata.
 * @returns {{ model: ModelsDevModel | undefined; source: "exact" | "family-alias" | "none" }} Exact
 *   or models.dev family-alias metadata.
 */
function resolveModelsDevModel(modelId, modelsDevIndex) {
  const exactModel = modelsDevIndex.get(modelId);
  if (exactModel !== undefined) {
    return { model: exactModel, source: "exact" };
  }

  const familyModels = [...modelsDevIndex.values()].filter(
    (model) => normalizeNonEmptyString(model.family) === modelId,
  );
  if (familyModels.length === 0) {
    return { model: undefined, source: "none" };
  }

  const latestModel = familyModels.reduce((currentModel, candidateModel) =>
    compareModelsDevRecency(candidateModel, currentModel) > 0 ? candidateModel : currentModel,
  );
  return { model: latestModel, source: "family-alias" };
}

/**
 * @param {ModelsDevModel} left - First models.dev model.
 * @param {ModelsDevModel} right - Second models.dev model.
 * @returns {number} Recency comparison, with later models sorting first.
 */
function compareModelsDevRecency(left, right) {
  for (const field of ["last_updated", "release_date"]) {
    const leftDate = normalizeNonEmptyString(left[field]);
    const rightDate = normalizeNonEmptyString(right[field]);
    if (leftDate !== rightDate) {
      return compareUtf8Bytes(leftDate ?? "", rightDate ?? "");
    }
  }
  return compareUtf8Bytes(left.id, right.id);
}

/**
 * @param {ModelInfo} template - Public bundled model used for required schema fields.
 * @param {string} fallbackInstructions - Exact unknown-model instructions captured from Codex.
 * @param {string} modelId - Exposed OpenCode Go model ID.
 * @param {number} index - Position in canonical model order.
 * @param {Record<string, unknown>} capabilityMetadata - Normalized models.dev metadata.
 * @returns {ModelInfo} Conservative metadata for an unknown model.
 */
function createFallbackModel(template, fallbackInstructions, modelId, index, capabilityMetadata) {
  return {
    base_instructions: fallbackInstructions,
    description: "Available through OpenCode Go.",
    display_name: modelId,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    priority: 1000 + index,
    shell_type: template.shell_type,
    slug: modelId,
    support_verbosity: false,
    supported_in_api: true,
    supported_reasoning_levels: [],
    supports_image_detail_original: false,
    supports_reasoning_summary_parameter: false,
    supports_search_tool: false,
    truncation_policy: structuredClone(template.truncation_policy),
    visibility: "list",
    ...capabilityMetadata,
  };
}

/**
 * @param {ModelsDevModel | undefined} model - Exact models.dev OpenCode Go record.
 * @param {ReasoningMetadata} reasoningMetadata - Installed Codex effort metadata.
 * @returns {Record<string, unknown>} Normalized metadata safe for Codex.
 */
function resolveModelsDevMetadata(model, reasoningMetadata) {
  if (model === undefined) {
    return {};
  }

  /** @type {Record<string, unknown>} */
  const metadata = {};
  const displayName = normalizeNonEmptyString(model.name);
  if (displayName !== null) {
    metadata.display_name = displayName;
  }

  const inputModalities = normalizeInputModalities(model.modalities?.input);
  if (inputModalities !== null) {
    metadata.input_modalities = inputModalities;
  }

  const contextWindow = normalizePositiveInteger(model.limit?.context);
  if (contextWindow !== null) {
    metadata.context_window = contextWindow;
    metadata.max_context_window = contextWindow;
  }

  const supportedReasoningEfforts = normalizeReasoningEfforts(model, reasoningMetadata);
  if (supportedReasoningEfforts.length > 0) {
    metadata.supported_reasoning_levels = supportedReasoningEfforts.map((effort) => ({
      description: reasoningMetadata.descriptions.get(effort) ?? "",
      effort,
    }));
  }
  return metadata;
}

/**
 * @param {ModelsDevModel} model - Exact models.dev OpenCode Go record.
 * @returns {boolean} Whether metadata explicitly describes a coding agent.
 */
function isAgentCapableModel(model) {
  return (
    model.modalities?.input?.includes("text") === true &&
    model.modalities?.output?.includes("text") === true &&
    model.tool_call === true
  );
}

/**
 * @param {ModelsDevModel} model - Exact models.dev OpenCode Go record.
 * @returns {boolean} Whether filtering fields are all explicit.
 */
function hasReliableAgentCapabilityMetadata(model) {
  return (
    Array.isArray(model.modalities?.input) &&
    Array.isArray(model.modalities?.output) &&
    typeof model.tool_call === "boolean"
  );
}

/**
 * @param {string} modelId - Exposed OpenCode Go model ID.
 * @returns {string | undefined} Generic non-agent family, if unambiguous.
 */
function getIdExclusionReason(modelId) {
  /** @type {[string, RegExp][]} */
  const families = [
    ["embedding", /(?:^|[-_/.])(?:embed|embedding|embeddings)(?=$|[-_/.])/iu],
    ["reranking", /(?:^|[-_/.])rerank(?:er|ing)?(?=$|[-_/.])/iu],
    [
      "transcription",
      /(?:^|[-_/.])(?:asr|whisper|transcribe|transcription|parakeet)(?=$|[-_/.])/iu,
    ],
    ["speech synthesis", /(?:^|[-_/.])(?:tts|speech|kokoro|supertonic)(?=$|[-_/.])/iu],
    [
      "image generation",
      /^(?:gpt|glm)-image(?:$|[-_/.])|(?:^|[-_/.])image-(?:edit|gen|generation)(?=$|[-_/.])/iu,
    ],
    ["video generation", /(?:^|[-_/.])(?:video|veo|sora)(?=$|[-_/.])/iu],
  ];
  return families.find(([, pattern]) => pattern.test(modelId))?.[0];
}

/**
 * @param {{ excluded: number; excludedReasons: Map<string, number> }} report - Mutable report.
 * @param {string} reason - Stable exclusion category.
 */
function recordExclusion(report, reason) {
  report.excluded += 1;
  report.excludedReasons.set(reason, (report.excludedReasons.get(reason) ?? 0) + 1);
}

/**
 * @param {Map<string, number>} counts - Stable category counts.
 * @returns {string} UTF-8 bytewise ordered report fragment.
 */
function formatCounts(counts) {
  return sortEntriesByKey([...counts.entries()])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
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
 * @param {ModelsDevModel} model - Exact models.dev model record.
 * @param {ReasoningMetadata} reasoningMetadata - Installed Codex effort metadata.
 * @returns {string[]} Supported effort values in Codex enum order.
 */
function normalizeReasoningEfforts(model, reasoningMetadata) {
  const advertisedEfforts = new Set(
    (model.reasoning_options ?? [])
      .filter((option) => option.type === "effort" && Array.isArray(option.values))
      .flatMap((option) => option.values)
      .map((effort) => normalizeNonEmptyString(effort))
      .filter((effort) => effort !== null && effort !== "none"),
  );
  return reasoningMetadata.effortOrder.filter((effort) => advertisedEfforts.has(effort));
}

/**
 * @param {string[] | undefined} modalities - Advertised input modalities.
 * @returns {string[] | null} Codex-supported modalities or no evidence.
 */
function normalizeInputModalities(modalities) {
  if (!Array.isArray(modalities)) {
    return null;
  }
  return ["text", "image"].filter((modality) => modalities.includes(modality));
}

/**
 * @param {unknown} value - Possible positive integer.
 * @returns {number | null} Positive integer or no evidence.
 */
function normalizePositiveInteger(value) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
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
