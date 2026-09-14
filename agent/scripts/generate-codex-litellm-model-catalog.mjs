#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const defaultEndpoint = "https://ai-gateway.0iq.xyz/v1/models";
const defaultOutputPath = resolve(homedir(), ".codex", "litellm-models.json");

/** @typedef {{ endpoint: string; outputPath: string; help: boolean }} GeneratorOptions */
/** @typedef {{ id: string; object: "model"; created: number; owned_by: string }} ExposedModel */
/** @typedef {{ object: "list"; data: ExposedModel[] }} ModelsResponse */
/**
 * @typedef {Record<string, unknown> & {
 *   slug: string;
 *   visibility?: unknown;
 *   supported_in_api?: unknown;
 * }} ModelInfo
 */
/** @typedef {{ models: ModelInfo[] }} CodexCatalog */

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

  const exposedModels = await fetchExposedModels(options.endpoint, apiKey);
  const bundledCatalog = loadBundledCatalog();
  const catalog = buildCatalog(exposedModels, bundledCatalog);

  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(`Wrote ${catalog.models.length} LiteLLM models to ${options.outputPath}`);
}

/**
 * @param {string[]} argumentsList - CLI arguments to parse.
 * @returns {GeneratorOptions} Parsed generator options.
 */
function parseArguments(argumentsList) {
  /** @type {GeneratorOptions} */
  const options = {
    endpoint: defaultEndpoint,
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
    throw new Error(`Could not fetch ${endpoint}: ${getErrorMessage(error)}`, { cause: error });
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
  return [...modelsById.values()];
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
  return isRecord(model) && typeof model.slug === "string" && model.slug.length > 0;
}

/**
 * @param {ExposedModel[]} exposedModels - Models available through LiteLLM.
 * @param {CodexCatalog} bundledCatalog - Catalog from installed Codex.
 * @returns {CodexCatalog} Replacement catalog containing exposed models only.
 */
function buildCatalog(exposedModels, bundledCatalog) {
  /** @type {Map<string, ModelInfo>} */
  const bundledModelsBySlug = new Map(bundledCatalog.models.map((model) => [model.slug, model]));
  const fallbackTemplate =
    bundledModelsBySlug.get("gpt-5.5") ??
    bundledCatalog.models.find(
      (model) => model.visibility === "list" && model.supported_in_api === true,
    );
  if (fallbackTemplate === undefined) {
    throw new Error("Bundled Codex catalog has no public model to use for LiteLLM model metadata.");
  }

  return {
    models: exposedModels.map((exposedModel, index) => {
      const bundledModel = bundledModelsBySlug.get(exposedModel.id);
      if (bundledModel !== undefined) {
        return bundledModel;
      }
      return createFallbackModel(fallbackTemplate, exposedModel.id, index);
    }),
  };
}

/**
 * @param {ModelInfo} template - Bundled public model used for required schema fields.
 * @param {string} modelId - Exposed model id.
 * @param {number} index - Position in the exposed model list.
 * @returns {ModelInfo} Conservative catalog entry for an unknown model.
 */
function createFallbackModel(template, modelId, index) {
  return {
    ...structuredClone(template),
    slug: modelId,
    display_name: modelId,
    description: "Available through LiteLLM.",
    visibility: "list",
    supported_in_api: true,
    priority: 1000 + index,
    availability_nux: null,
    upgrade: null,
    additional_speed_tiers: [],
    service_tiers: [],
    input_modalities: ["text"],
    supports_image_detail_original: false,
    supports_search_tool: false,
  };
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
  --endpoint <url>  Models endpoint (default: ${defaultEndpoint})
  --output <path>   Catalog output (default: ${defaultOutputPath})
  -h, --help        Show this help`);
}

function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
}
