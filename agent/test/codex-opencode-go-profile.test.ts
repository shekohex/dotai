import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const generatorPath = new URL(
  "../scripts/generate-codex-opencode-go-model-catalog.mjs",
  import.meta.url,
);
const profilePath = new URL("../../.codex/opencode-go.config.toml", import.meta.url);
const documentationPath = new URL("../../.codex/opencode-go.md", import.meta.url);
const catalogPath = new URL("../../.codex/opencode-go-models.json", import.meta.url);

const documentedModelIds = [
  "gpt-5.6-luna",
  "grok-4.6",
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor",
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Codex OpenCode Go model catalog generator", () => {
  it("writes only documented text tool-calling agent models with canonical metadata", async () => {
    const runtimeDirectory = await createTemporaryDirectory();
    const outputPath = join(runtimeDirectory, "opencode-go-models.json");
    const bundledModel = {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      description: "Bundled model",
      experimental_supported_tools: [],
      priority: 8,
      shell_type: "unified_exec",
      support_verbosity: true,
      supported_in_api: true,
      supported_reasoning_levels: [],
      truncation_policy: { mode: "tokens", limit: 10_000 },
      visibility: "list",
      base_instructions: "Bundled instructions",
      model_messages: { instructions_template: "Bundled instruction template" },
      comp_hash: "runtime-cache-hash",
    };
    const fallbackModel = {
      ...bundledModel,
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      base_instructions: "Fallback instructions",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast reasoning" },
        { effort: "medium", description: "Standard reasoning" },
        { effort: "high", description: "Deep reasoning" },
        { effort: "xhigh", description: "Extra deep reasoning" },
        { effort: "max", description: "Maximum reasoning" },
      ],
    };
    await installMockCodex(runtimeDirectory, {
      models: [bundledModel, fallbackModel],
    });

    const { stdout } = await execFile(
      process.execPath,
      [generatorPath.pathname, "--output", outputPath],
      {
        env: {
          ...process.env,
          PATH: `${runtimeDirectory}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    expect(stdout).toContain("Instructions: 1 exact bundled; 3 installed Codex fallback");

    const contents = await readFile(outputPath, "utf8");
    const catalog = JSON.parse(contents) as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models.map((model) => model.slug)).toEqual(documentedModelIds);
    expect(catalog.models[0]).toMatchObject({
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      description: "Bundled model",
      base_instructions: "Bundled instructions",
      model_messages: { instructions_template: "Bundled instruction template" },
    });
    expect(catalog.models[0]).not.toHaveProperty("comp_hash");
    for (const model of catalog.models.slice(1)) {
      expect(model).toMatchObject({
        base_instructions: "Runtime fallback instructions",
        input_modalities: ["text", "image"],
        support_verbosity: false,
        supported_in_api: true,
        supports_reasoning_summary_parameter: false,
        supports_search_tool: false,
        visibility: "list",
      });
      expect(model).not.toHaveProperty("default_reasoning_level");
    }
    expect(catalog.models[1]).toMatchObject({
      display_name: "Grok 4.6",
      description:
        "xAI's frontier model for long-running agents, coding, knowledge work, and visual projects",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast reasoning" },
        { effort: "medium", description: "Standard reasoning" },
        { effort: "high", description: "Deep reasoning" },
        { effort: "xhigh", description: "Extra deep reasoning" },
      ],
    });
    for (const model of catalog.models.slice(2)) {
      expect(model.supported_reasoning_levels).toEqual([
        { effort: "minimal", description: "" },
        { effort: "low", description: "Fast reasoning" },
        { effort: "medium", description: "Standard reasoning" },
        { effort: "high", description: "Deep reasoning" },
        { effort: "xhigh", description: "Extra deep reasoning" },
      ]);
    }
    expect(contents).toBe(`${JSON.stringify(catalog, null, 2)}\n`);
    expectCanonicalKeyOrder(catalog);

    const fallbackOnlyOutputPath = join(runtimeDirectory, "opencode-go-fallback-models.json");
    await installMockCodex(runtimeDirectory, { models: [fallbackModel] });
    await execFile(process.execPath, [generatorPath.pathname, "--output", fallbackOnlyOutputPath], {
      env: {
        ...process.env,
        PATH: `${runtimeDirectory}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    const fallbackOnlyCatalog = JSON.parse(await readFile(fallbackOnlyOutputPath, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    expect(fallbackOnlyCatalog.models[0].supported_reasoning_levels).toEqual([
      { effort: "low", description: "Fast reasoning" },
      { effort: "medium", description: "Standard reasoning" },
      { effort: "high", description: "Deep reasoning" },
      { effort: "xhigh", description: "Extra deep reasoning" },
      { effort: "max", description: "Maximum reasoning" },
    ]);
  });
});

describe("Codex OpenCode Go profile", () => {
  it("uses the Responses API and shared Pi auth helper", async () => {
    const profile = await readFile(profilePath, "utf8");

    expect(profile).not.toMatch(/^model\s*=/m);
    expect(profile).toContain('model_provider = "opencode-go"');
    expect(profile).toContain('model_catalog_json = "opencode-go-models.json"');
    expect(profile).toContain("[model_providers.opencode-go]");
    expect(profile).toContain('base_url = "https://opencode.ai/zen/go/v1"');
    expect(profile).toContain('wire_api = "responses"');
    expect(profile).toContain("[model_providers.opencode-go.auth]");
    expect(profile).toContain('command = "node"');
    expect(profile).toContain('args = ["pi-agent-auth.mjs", "opencode-go"]');
    expect(profile).toContain('cwd = "~/.codex"');
    expect(profile).not.toMatch(/api_key\s*=/);
    expect(profile).not.toMatch(/env_key\s*=/);
    expect(profile).not.toMatch(/experimental_bearer_token\s*=/);
    expect(profile).not.toMatch(/requires_openai_auth\s*=/);
    expect(profile).not.toMatch(
      /^(?:approval_policy|sandbox_mode|personality|model_reasoning_effort)\s*=/m,
    );
    expect(profile).not.toContain("[features]");
  });

  it("documents only OpenCode Go models with Responses API endpoints", async () => {
    const documentation = await readFile(documentationPath, "utf8");

    expect(documentation).toContain("`gpt-5.6-luna`");
    expect(documentation).toContain("`grok-4.6`");
    expect(documentation).toContain("`muse-spark-1.3-contributor`");
    expect(documentation).toContain("`muse-spark-1.2-contributor`");
    expect(documentation).toContain("`/chat/completions`");
    expect(documentation).toContain("`/messages`");
    expect(documentation).toContain("codex --profile opencode-go --model <model-id>");
    expect(documentation).not.toContain("profile defaults");
  });

  it("ships a deterministic catalog containing only documented Responses coding agents", async () => {
    const source = await readFile(catalogPath, "utf8");
    const catalog = JSON.parse(source) as {
      models: Array<Record<string, unknown>>;
    };
    const modelIds = catalog.models.map((model) => model.slug);

    expect(modelIds).toEqual(documentedModelIds);
    expect(modelIds).toEqual([...modelIds].sort(compareUtf8Values));
    expect(new Set(modelIds).size).toBe(documentedModelIds.length);
    expect(source).toBe(`${JSON.stringify(catalog, null, 2)}\n`);
    expectCanonicalKeyOrder(catalog);

    expect(catalog.models[1]).toMatchObject({
      slug: "grok-4.6",
      display_name: "Grok 4.6",
      context_window: 500_000,
      max_context_window: 500_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
      ],
    });
    for (const model of catalog.models.slice(2)) {
      expect(model).toMatchObject({
        display_name: expect.stringMatching(/^Muse Spark 1\.[23] Contributor$/),
        context_window: 1_048_576,
        max_context_window: 1_048_576,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [
          { effort: "minimal" },
          { effort: "low" },
          { effort: "medium" },
          { effort: "high" },
          { effort: "xhigh" },
        ],
      });
    }

    for (const model of catalog.models) {
      expect(model).toMatchObject({
        slug: expect.any(String),
        display_name: expect.any(String),
        experimental_supported_tools: expect.any(Array),
        priority: expect.any(Number),
        shell_type: expect.any(String),
        support_verbosity: expect.any(Boolean),
        supported_in_api: true,
        supported_reasoning_levels: expect.any(Array),
        truncation_policy: expect.any(Object),
        visibility: "list",
      });
      expect(hasCodexInstructions(model)).toBe(true);
      expect(model).not.toHaveProperty("comp_hash");
      expect(model).not.toHaveProperty("created");
      expect(model).not.toHaveProperty("object");
      expect(model).not.toHaveProperty("owned_by");
      if (model.slug !== "gpt-5.6-luna") {
        expect(model).not.toHaveProperty("default_reasoning_level");
      }
      expect(model.input_modalities).not.toContain("audio");
      expect(model.input_modalities).not.toContain("pdf");
      expect(model.input_modalities).not.toContain("video");
      for (const level of model.supported_reasoning_levels as Array<Record<string, unknown>>) {
        expect(typeof level.description).toBe("string");
      }
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-opencode-go-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function installMockCodex(runtimeDirectory: string, bundledCatalog: object): Promise<void> {
  const executablePath = join(runtimeDirectory, "codex");
  const executable = `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.154.0\\n");
} else if (process.argv.includes("--bundled")) {
  process.stdout.write(${JSON.stringify(JSON.stringify(bundledCatalog))});
} else {
  const config = await readFile(join(process.env.CODEX_HOME, "config.toml"), "utf8");
  const baseUrl = config.match(/base_url = "([^"]+)"/)?.[1];
  await fetch(baseUrl + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions: "Runtime fallback instructions" }),
  });
  process.exitCode = 1;
}
`;
  await writeFile(executablePath, executable, "utf8");
  await chmod(executablePath, 0o755);
}

function expectCanonicalKeyOrder(value: unknown): void {
  if (Array.isArray(value)) {
    for (const childValue of value) {
      expectCanonicalKeyOrder(childValue);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  const keys = Object.keys(value);
  expect(keys).toEqual([...keys].sort(compareUtf8Values));
  for (const childValue of Object.values(value)) {
    expectCanonicalKeyOrder(childValue);
  }
}

function compareUtf8Values(left: unknown, right: unknown): number {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

function hasCodexInstructions(model: Record<string, unknown>): boolean {
  if (typeof model.base_instructions === "string") {
    return true;
  }
  const modelMessages = model.model_messages;
  return (
    typeof modelMessages === "object" &&
    modelMessages !== null &&
    "instructions_template" in modelMessages &&
    typeof modelMessages.instructions_template === "string"
  );
}
