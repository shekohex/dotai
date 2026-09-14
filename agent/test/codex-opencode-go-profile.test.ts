import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Codex OpenCode Go model catalog generator", () => {
  it("builds the catalog from every live agent model with normalized metadata", async () => {
    const runtimeDirectory = await createTemporaryDirectory();
    const outputPath = join(runtimeDirectory, "opencode-go-models.json");
    const generatorSource = await readFile(generatorPath, "utf8");
    expect(generatorSource).not.toContain(["documented", "Responses", "Models"].join(""));
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

    const requestedPaths: string[] = [];
    let authorizationHeader: string | undefined;
    const server = createServer((request, response) => {
      requestedPaths.push(request.url ?? "");
      if (request.url === "/v1/models") {
        authorizationHeader = request.headers.authorization;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "gpt-5.6-luna", object: "model", created: 1, owned_by: "opencode" },
              {
                id: "deepseek-v4.1-flash",
                object: "model",
                created: 2,
                owned_by: "opencode",
              },
              { id: "deepseek-flash", object: "model", created: 3, owned_by: "opencode" },
              { id: "unmatched-agent", object: "model", created: 4, owned_by: "opencode" },
              { id: "text-embedding-3-small", object: "model", created: 5, owned_by: "opencode" },
              { id: "gpt-image-2", object: "model", created: 6, owned_by: "opencode" },
            ],
          }),
        );
        return;
      }
      if (request.url === "/models-dev/api.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            "opencode-go": {
              models: {
                "deepseek-v4-flash": {
                  id: "deepseek-v4-flash",
                  name: "DeepSeek V4 Flash",
                  family: "deepseek-flash",
                  last_updated: "2026-07-31",
                  release_date: "2026-07-31",
                  modalities: { input: ["text"], output: ["text"] },
                  tool_call: true,
                  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
                  limit: { context: 1_000_000, output: 384_000 },
                },
                "deepseek-v4.1-flash": {
                  id: "deepseek-v4.1-flash",
                  name: "DeepSeek V4.1 Flash",
                  family: "deepseek-flash",
                  last_updated: "2026-09-10",
                  release_date: "2026-09-10",
                  modalities: { input: ["text", "image"], output: ["text"] },
                  tool_call: true,
                  reasoning: true,
                  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
                  limit: { context: 1_000_000, output: 384_000 },
                },
              },
            },
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test server did not expose a TCP port");
      }
      const { stdout } = await execFile(
        process.execPath,
        [
          generatorPath.pathname,
          "--endpoint",
          `http://127.0.0.1:${address.port}/v1/models`,
          "--models-dev-endpoint",
          `http://127.0.0.1:${address.port}/models-dev/api.json`,
          "--output",
          outputPath,
        ],
        {
          env: {
            ...process.env,
            OPENCODE_GO_API_KEY: "test-token",
            PATH: `${runtimeDirectory}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(stdout).toContain("Wrote 4 OpenCode Go models");
      expect(stdout).toContain("Excluded 2 non-agent models");
      expect(stdout).toContain("1 models.dev family aliases");

      await execFile(
        process.execPath,
        [
          generatorPath.pathname,
          "--endpoint",
          `http://127.0.0.1:${address.port}/v1/models`,
          "--models-dev-endpoint",
          `http://127.0.0.1:${address.port}/models-dev/api.json`,
          "--output",
          join(runtimeDirectory, "opencode-go-models-second.json"),
        ],
        {
          env: {
            ...process.env,
            OPENCODE_GO_API_KEY: "test-token",
            PATH: `${runtimeDirectory}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
      );
    }

    expect(requestedPaths.sort()).toEqual([
      "/models-dev/api.json",
      "/models-dev/api.json",
      "/v1/models",
      "/v1/models",
    ]);
    expect(authorizationHeader).toBe("Bearer test-token");
    expect(await readFile(outputPath, "utf8")).toBe(
      await readFile(join(runtimeDirectory, "opencode-go-models-second.json"), "utf8"),
    );

    const catalog = JSON.parse(await readFile(outputPath, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    const modelsBySlug = Object.fromEntries(catalog.models.map((model) => [model.slug, model]));
    expect(catalog.models.map((model) => model.slug)).toEqual([
      "deepseek-flash",
      "deepseek-v4.1-flash",
      "gpt-5.6-luna",
      "unmatched-agent",
    ]);
    expect(modelsBySlug["deepseek-flash"]).toMatchObject({
      base_instructions: "Runtime fallback instructions",
      display_name: "DeepSeek V4.1 Flash",
      context_window: 1_000_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [
        { effort: "low", description: "Fast reasoning" },
        { effort: "high", description: "Deep reasoning" },
        { effort: "max", description: "Maximum reasoning" },
      ],
    });
    expect(modelsBySlug["deepseek-v4.1-flash"]).toMatchObject({
      base_instructions: "Runtime fallback instructions",
      display_name: "DeepSeek V4.1 Flash",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [
        { effort: "low", description: "Fast reasoning" },
        { effort: "high", description: "Deep reasoning" },
        { effort: "max", description: "Maximum reasoning" },
      ],
    });
    expect(modelsBySlug["unmatched-agent"]).toMatchObject({
      base_instructions: "Runtime fallback instructions",
      display_name: "unmatched-agent",
      input_modalities: ["text"],
      supported_reasoning_levels: [],
    });
    expect(modelsBySlug["gpt-5.6-luna"]).toMatchObject({
      base_instructions: "Bundled instructions",
      display_name: "GPT-5.6-Luna",
    });
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

  it("documents live OpenCode Go model discovery and metadata enrichment", async () => {
    const documentation = await readFile(documentationPath, "utf8");

    expect(documentation).toContain("GET https://opencode.ai/zen/go/v1/models");
    expect(documentation).toContain("models.dev");
    expect(documentation).toContain("structural non-agent families");
    expect(documentation).not.toContain("only four models");
    expect(documentation).not.toContain("`/chat/completions`");
    expect(documentation).not.toContain("`/messages`");
    expect(documentation).toContain("codex --profile opencode-go --model <model-id>");
    expect(documentation).not.toContain("profile defaults");
  });

  it("ships a deterministic catalog from the current OpenCode Go model source", async () => {
    const source = await readFile(catalogPath, "utf8");
    const catalog = JSON.parse(source) as {
      models: Array<Record<string, unknown>>;
    };
    const modelIds = catalog.models.map((model) => model.slug);

    expect(modelIds).toEqual([...modelIds].sort(compareUtf8Values));
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds).toContain("deepseek-v4.1-flash");
    expect(modelIds).toContain("deepseek-v4-flash");
    expect(modelIds).toContain("glm-5.3-flash");
    expect(modelIds).not.toEqual([
      "gpt-5.6-luna",
      "grok-4.6",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
    ]);
    expect(source).toBe(`${JSON.stringify(catalog, null, 2)}\n`);
    expectCanonicalKeyOrder(catalog);

    const deepseekModel = catalog.models.find((model) => model.slug === "deepseek-v4.1-flash");
    expect(deepseekModel).toMatchObject({
      slug: "deepseek-v4.1-flash",
      display_name: "DeepSeek V4.1 Flash",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
    });

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
