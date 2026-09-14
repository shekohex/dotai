#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const defaultEndpoint = "https://ai-gateway.0iq.xyz/v1/models";
const defaultModelsDevEndpoint = "https://models.dev/api.json";
const defaultOutputPath = resolve(homedir(), ".codex", "litellm-models.json");

/** @typedef {{ endpoint: string; modelsDevEndpoint: string; outputPath: string; help: boolean }} GeneratorOptions */
/** @typedef {{ id: string; object: "model"; created: number; owned_by: string }} ExposedModel */
/** @typedef {{ object: "list"; data: ExposedModel[] }} ModelsResponse */
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
/** @typedef {{ providerId: string; providerModelId: string; model: ModelsDevModel }} ModelsDevCandidate */
/** @typedef {Map<string, ModelsDevCandidate[]>} ModelsDevIndex */
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

  const apiKey = process.env.LITELLM_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("LITELLM_API_KEY is required. Export it before generating the catalog.");
  }

  const [exposedModels, modelsDevIndex, codexRuntime] = await Promise.all([
    fetchExposedModels(options.endpoint, apiKey),
    fetchModelsDevIndex(options.modelsDevEndpoint),
    loadCodexRuntime(),
  ]);
  const { catalog, report } = buildCatalog(exposedModels, modelsDevIndex, codexRuntime);

  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, serializeCatalog(catalog), "utf8");
  console.log(`Wrote ${catalog.models.length} LiteLLM models to ${options.outputPath}`);
  console.log(
    `Excluded ${report.excluded} non-agent models: ${formatCounts(report.excludedReasons)}`,
  );
  console.log(
    `Instructions: bundled=${report.bundledInstructions} (codex debug models --bundled); fallback=${report.fallbackInstructions} (codex exec loopback, ${codexRuntime.version}, sha256=${sha256(codexRuntime.fallbackInstructions)})`,
  );
  console.log(
    `Capabilities: ${report.enriched} exact enriched; ${report.ambiguous} ambiguous retained; ${report.incomplete} incomplete exact retained; ${report.unmatched} unmatched retained`,
  );
  console.log(
    `Display names: bundled=${report.bundledDisplayNames}; models.dev=${report.modelsDevDisplayNames}; ambiguous=${report.ambiguousDisplayNames}; missing=${report.missingDisplayNames}`,
  );
  console.log(
    `Reasoning levels: bundled=${report.bundledReasoning}; models.dev=${report.modelsDevReasoning}; ambiguous=${report.ambiguousReasoning}; toggle/budget-only=${report.nonEffortReasoning}; non-reasoning=${report.nonReasoning}; unavailable=${report.unavailableReasoning}; missing descriptions=${report.missingReasoningDescriptions}`,
  );
}

/**
 * @param {string[]} argumentsList - CLI arguments to parse.
 * @returns {GeneratorOptions} Parsed generator options.
 */
function parseArguments(argumentsList) {
  /** @type {GeneratorOptions} */
  const options = {
    endpoint: defaultEndpoint,
    modelsDevEndpoint: defaultModelsDevEndpoint,
    outputPath: defaultOutputPath,
    help: false,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--endpoint") {
      options.endpoint = readOptionValue(argumentsList, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--output") {
      options.outputPath = resolve(readOptionValue(argumentsList, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--models-dev-endpoint") {
      options.modelsDevEndpoint = readOptionValue(argumentsList, index, argument);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}. Run with --help for usage.`);
  }

  return options;
}

/**
 * @param {string[]} argumentsList - CLI arguments containing the option.
 * @param {number} index - Index of the option name.
 * @param {string} option - Option name used in errors.
 * @returns {string} Option value following the name.
 */
function readOptionValue(argumentsList, index, option) {
  const value = argumentsList[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

/**
 * @param {string} endpoint - OpenAI-compatible models endpoint.
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

  const responseBody = await response.text();
  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(responseBody);
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
 * @param {string} endpoint - Models.dev catalog endpoint.
 * @returns {Promise<ModelsDevIndex>} Exact canonical model ids indexed across providers.
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
  /** @type {Record<string, { models: Record<string, ModelsDevModel> }>} */
  const modelsDevCatalog = payload;

  /** @type {ModelsDevIndex} */
  const modelsByCanonicalId = new Map();
  for (const [providerId, provider] of sortEntriesByKey(Object.entries(modelsDevCatalog))) {
    for (const [providerModelId, model] of sortEntriesByKey(Object.entries(provider.models))) {
      const candidates = modelsByCanonicalId.get(model.id) ?? [];
      candidates.push({ providerId, providerModelId, model });
      modelsByCanonicalId.set(model.id, candidates);
    }
  }
  return modelsByCanonicalId;
}

/**
 * @param {unknown} payload - Parsed models.dev response.
 * @returns {payload is Record<string, { models: Record<string, ModelsDevModel> }>} Whether the
 *   catalog has provider model maps and canonical ids.
 */
function isModelsDevCatalog(payload) {
  return (
    isRecord(payload) &&
    Object.keys(payload).length > 0 &&
    Object.values(payload).every(
      (provider) =>
        isRecord(provider) &&
        isRecord(provider.models) &&
        Object.values(provider.models).every(
          (model) => isRecord(model) && typeof model.id === "string" && model.id.length > 0,
        ),
    )
  );
}

/**
 * @param {unknown} payload - Parsed endpoint response.
 * @returns {payload is ModelsResponse} Whether payload is a standard models list.
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
 * @returns {model is ExposedModel} Whether entry has standard model fields.
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
 * @returns {ExposedModel[]} Models with duplicate ids removed.
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
 * @returns {ExposedModel[]} Models ordered by UTF-8 id bytes.
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

/**
 * @param {CodexCatalog} catalog - Catalog to serialize deterministically.
 * @returns {string} Canonical JSON with two-space indentation and a final newline.
 */
function serializeCatalog(catalog) {
  return `${JSON.stringify(sortObjectKeys(catalog), null, 2)}\n`;
}

/**
 * @param {unknown} value - JSON value to canonicalize.
 * @returns {unknown} Value with every object ordered by UTF-8 key bytes.
 */
function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeys(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    sortEntriesByKey(Object.entries(value)).map(([key, item]) => [key, sortObjectKeys(item)]),
  );
}

/**
 * @template T
 * @param {[string, T][]} entries - Object entries to order.
 * @returns {[string, T][]} Entries ordered by UTF-8 key bytes.
 */
function sortEntriesByKey(entries) {
  /** @type {[string, T][]} */
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

/** @returns {CodexCatalog} Validated bundled catalog from installed Codex. */
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
 * @param {unknown} model - Candidate bundled model entry.
 * @returns {model is ModelInfo} Whether entry has a model slug.
 */
function isModelInfo(model) {
  return (
    isRecord(model) &&
    typeof model.slug === "string" &&
    model.slug.length > 0 &&
    typeof model.display_name === "string" &&
    Array.isArray(model.experimental_supported_tools) &&
    typeof model.priority === "number" &&
    Number.isInteger(model.priority) &&
    typeof model.shell_type === "string" &&
    typeof model.support_verbosity === "boolean" &&
    typeof model.supported_in_api === "boolean" &&
    Array.isArray(model.supported_reasoning_levels) &&
    isRecord(model.truncation_policy) &&
    typeof model.visibility === "string" &&
    (typeof model.base_instructions === "string" ||
      (isRecord(model.model_messages) &&
        typeof model.model_messages.instructions_template === "string"))
  );
}

/**
 * @param {ExposedModel[]} exposedModels - Models available through LiteLLM.
 * @param {ModelsDevIndex} modelsDevIndex - Exact canonical models.dev matches.
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
 *     ambiguous: number;
 *     incomplete: number;
 *     unmatched: number;
 *     bundledDisplayNames: number;
 *     modelsDevDisplayNames: number;
 *     ambiguousDisplayNames: number;
 *     missingDisplayNames: number;
 *     bundledReasoning: number;
 *     modelsDevReasoning: number;
 *     ambiguousReasoning: number;
 *     nonEffortReasoning: number;
 *     nonReasoning: number;
 *     unavailableReasoning: number;
 *     missingReasoningDescriptions: number;
 *   };
 * }}
 *   Catalog and generation report.
 */
function buildCatalog(exposedModels, modelsDevIndex, codexRuntime) {
  /** @type {Map<string, ModelInfo>} */
  const bundledModelsBySlug = new Map(
    codexRuntime.bundledCatalog.models.map((model) => [model.slug, model]),
  );
  const fallbackTemplate =
    bundledModelsBySlug.get("gpt-5.5") ??
    codexRuntime.bundledCatalog.models.find(
      (model) => model.visibility === "list" && model.supported_in_api,
    );
  if (fallbackTemplate === undefined) {
    throw new Error("Bundled Codex catalog has no public model to use for LiteLLM model metadata.");
  }
  const reasoningMetadata = createReasoningMetadata(codexRuntime.bundledCatalog.models);

  const report = {
    excluded: 0,
    excludedReasons: new Map(),
    bundledInstructions: 0,
    fallbackInstructions: 0,
    enriched: 0,
    ambiguous: 0,
    incomplete: 0,
    unmatched: 0,
    bundledDisplayNames: 0,
    modelsDevDisplayNames: 0,
    ambiguousDisplayNames: 0,
    missingDisplayNames: 0,
    bundledReasoning: 0,
    modelsDevReasoning: 0,
    ambiguousReasoning: 0,
    nonEffortReasoning: 0,
    nonReasoning: 0,
    unavailableReasoning: 0,
    missingReasoningDescriptions: 0,
  };
  /** @type {ModelInfo[]} */
  const models = [];
  for (const exposedModel of exposedModels) {
    const bundledModel = bundledModelsBySlug.get(exposedModel.id);
    if (bundledModel !== undefined) {
      report.bundledInstructions += 1;
      report.bundledDisplayNames += 1;
      report.bundledReasoning += 1;
      models.push(structuredClone(bundledModel));
      continue;
    }

    const idExclusionReason = getIdExclusionReason(exposedModel.id);
    const candidates = modelsDevIndex.get(exposedModel.id) ?? [];
    const reliableCandidates = candidates.filter(({ model }) =>
      hasReliableAgentCapabilityMetadata(model),
    );
    const reliablyNonAgent =
      reliableCandidates.length === candidates.length &&
      reliableCandidates.length > 0 &&
      !reliableCandidates.some(({ model }) => isAgentCapableModel(model));
    if (idExclusionReason !== undefined || reliablyNonAgent) {
      recordExclusion(report, idExclusionReason ?? "models.dev lacks required agent capabilities");
      continue;
    }

    const resolvedMetadata = resolveModelsDevMetadata(candidates, reasoningMetadata);
    recordResolution(report, "DisplayNames", resolvedMetadata.displayNameStatus);
    recordResolution(report, "Reasoning", resolvedMetadata.reasoningStatus);
    report.missingReasoningDescriptions += resolvedMetadata.missingReasoningDescriptions;
    if (candidates.length === 1 && reliableCandidates.length === 1) {
      report.enriched += 1;
    } else if (candidates.length > 1) {
      report.ambiguous += 1;
    } else if (candidates.length === 1) {
      report.incomplete += 1;
    } else {
      report.unmatched += 1;
    }
    report.fallbackInstructions += 1;
    models.push(
      createFallbackModel(
        fallbackTemplate,
        codexRuntime.fallbackInstructions,
        exposedModel.id,
        models.length,
        resolvedMetadata.metadata,
      ),
    );
  }

  return { catalog: { models }, report };
}

/**
 * @param {ModelInfo} template - Bundled public model used for required schema fields.
 * @param {string} fallbackInstructions - Canonical unknown-model instructions captured from Codex.
 * @param {string} modelId - Exposed model id.
 * @param {number} index - Position in the exposed model list.
 * @param {Record<string, unknown> | undefined} capabilityMetadata - Exact models.dev metadata
 *   supported by Codex.
 * @returns {ModelInfo} Conservative catalog entry for an unknown model.
 */
function createFallbackModel(template, fallbackInstructions, modelId, index, capabilityMetadata) {
  return {
    base_instructions: fallbackInstructions,
    experimental_supported_tools: [],
    priority: 1000 + index,
    shell_type: template.shell_type,
    slug: modelId,
    support_verbosity: false,
    supported_in_api: true,
    supported_reasoning_levels: [],
    truncation_policy: structuredClone(template.truncation_policy),
    visibility: "list",
    description: "Available through LiteLLM.",
    display_name: modelId,
    input_modalities: ["text", "image"],
    supports_image_detail_original: false,
    supports_search_tool: false,
    ...capabilityMetadata,
  };
}

/**
 * @param {ModelsDevModel} model - Exact models.dev record.
 * @returns {boolean} Whether the record reliably describes an agent-capable model.
 */
function isAgentCapableModel(model) {
  return (
    model.modalities?.input?.includes("text") === true &&
    model.modalities?.output?.includes("text") === true &&
    model.tool_call === true
  );
}

/**
 * @param {ModelsDevModel} model - Exact models.dev record.
 * @returns {boolean} Whether all filtering capability fields are explicit.
 */
function hasReliableAgentCapabilityMetadata(model) {
  return (
    Array.isArray(model.modalities?.input) &&
    Array.isArray(model.modalities.output) &&
    typeof model.tool_call === "boolean"
  );
}

/**
 * @param {ModelsDevCandidate[]} candidates - Exact canonical models.dev matches.
 * @param {ReasoningMetadata} reasoningMetadata - Installed Codex effort metadata.
 * @returns {{
 *   metadata: Record<string, unknown>;
 *   displayNameStatus: "modelsDev" | "ambiguous" | "missing";
 *   reasoningStatus: "modelsDev" | "ambiguous" | "nonEffort" | "non" | "unavailable";
 *   missingReasoningDescriptions: number;
 * }}
 *   Consensus metadata and evidence classifications.
 */
function resolveModelsDevMetadata(candidates, reasoningMetadata) {
  /** @type {Record<string, unknown>} */
  const metadata = {};
  const displayNames = candidates.map(({ model }) => normalizeNonEmptyString(model.name));
  const displayName = getConsensusValue(displayNames);
  /** @type {"modelsDev" | "ambiguous" | "missing"} */
  let displayNameStatus = "missing";
  if (displayName !== null) {
    displayNameStatus = "modelsDev";
    metadata.display_name = displayName;
  } else if (candidates.length > 1 && displayNames.some((name) => name !== null)) {
    displayNameStatus = "ambiguous";
  }

  const inputModalities = getConsensusValue(
    candidates.map(({ model }) => normalizeInputModalities(model.modalities?.input)),
  );
  if (inputModalities !== null) {
    metadata.input_modalities = inputModalities;
  }

  const contextWindow = getConsensusValue(
    candidates.map(({ model }) => normalizePositiveInteger(model.limit?.context)),
  );
  if (contextWindow !== null) {
    metadata.context_window = contextWindow;
    metadata.max_context_window = contextWindow;
  }

  const candidateEfforts = candidates.map(({ model }) =>
    normalizeReasoningEfforts(model, reasoningMetadata),
  );
  const supportedEfforts = getConsensusValue(candidateEfforts);
  /** @type {"modelsDev" | "ambiguous" | "nonEffort" | "non" | "unavailable"} */
  let reasoningStatus = "unavailable";
  let missingReasoningDescriptions = 0;
  if (supportedEfforts === null && candidates.length > 1) {
    reasoningStatus = "ambiguous";
  } else if (supportedEfforts?.length > 0) {
    metadata.supported_reasoning_levels = supportedEfforts.map((effort) => ({
      effort,
      description: reasoningMetadata.descriptions.get(effort) ?? "",
    }));
    missingReasoningDescriptions = supportedEfforts.filter(
      (effort) => !reasoningMetadata.descriptions.has(effort),
    ).length;
    reasoningStatus = "modelsDev";
  } else if (candidates.length > 0) {
    const reasoningValues = candidates.map(({ model }) => model.reasoning ?? null);
    if (getConsensusValue(reasoningValues) === null && candidates.length > 1) {
      reasoningStatus = "ambiguous";
    } else if (reasoningValues.every((reasoning) => reasoning === false)) {
      reasoningStatus = "non";
    } else if (
      candidates.some(
        ({ model }) =>
          model.reasoning === true ||
          model.reasoning_options?.some(
            (option) => option.type === "toggle" || option.type === "budget_tokens",
          ) === true,
      )
    ) {
      reasoningStatus = "nonEffort";
    }
  }

  return {
    metadata,
    displayNameStatus,
    reasoningStatus,
    missingReasoningDescriptions,
  };
}

/**
 * @param {ModelInfo[]} bundledModels - Installed bundled Codex models.
 * @returns {ReasoningMetadata} Named effort order and official descriptions.
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
 * @param {ModelsDevModel} model - Models.dev record.
 * @param {ReasoningMetadata} reasoningMetadata - Installed Codex effort metadata.
 * @returns {string[]} Supported effort values in Codex enum order.
 */
function normalizeReasoningEfforts(model, reasoningMetadata) {
  const advertisedEfforts = new Set(
    (model.reasoning_options ?? [])
      .filter((option) => option.type === "effort" && Array.isArray(option.values))
      .flatMap((option) => option.values)
      .map((effort) => normalizeNonEmptyString(effort))
      .filter((effort) => effort !== null),
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
  if (!Number.isInteger(value) || Number(value) <= 0) {
    return null;
  }
  return Number(value);
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
  if (normalized.length === 0) {
    return null;
  }
  return normalized;
}

/**
 * @template T
 * @param {(T | null)[]} values - Candidate normalized field values.
 * @returns {T | null} Unanimous normalized value or no consensus.
 */
function getConsensusValue(values) {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  const [firstValue] = values;
  return values.every((value) => JSON.stringify(value) === JSON.stringify(firstValue))
    ? firstValue
    : null;
}

/**
 * @param {Record<string, number>} report - Mutable generation counts.
 * @param {"DisplayNames" | "Reasoning"} suffix - Report field suffix.
 * @param {string} status - Resolution status prefix.
 * @returns {void}
 */
function recordResolution(report, suffix, status) {
  const field = `${status}${suffix}`;
  report[field] += 1;
}

/**
 * @param {string} modelId - LiteLLM model id.
 * @returns {string | undefined} Unambiguous non-agent family.
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
 * @param {{ excluded: number; excludedReasons: Map<string, number> }} report - Mutable generation
 *   report.
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
 * @param {string} value - Text to fingerprint.
 * @returns {string} Lowercase SHA-256 digest.
 */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {unknown} value - Value to inspect.
 * @returns {value is Record<string, unknown>} Whether value is a plain record.
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} error - Caught value.
 * @returns {string} Safe error description.
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printUsage() {
  console.log(`Usage: node agent/scripts/generate-codex-litellm-model-catalog.mjs [options]

Options:
  --endpoint <url>             Models endpoint (default: ${defaultEndpoint})
  --models-dev-endpoint <url>  Capability catalog (default: ${defaultModelsDevEndpoint})
  --output <path>              Catalog output (default: ${defaultOutputPath})
  -h, --help                   Show this help`);
}

function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
}
