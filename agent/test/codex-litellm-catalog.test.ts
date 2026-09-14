import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const generatorPath = new URL(
  "../scripts/generate-codex-litellm-model-catalog.mjs",
  import.meta.url,
);
const profilePath = new URL("../../.codex/litellm.config.toml", import.meta.url);
const providerAuthPath = new URL("../../.codex/pi-agent-auth.mjs", import.meta.url);
const trackedCatalogPath = new URL("../../.codex/litellm-models.json", import.meta.url);
const modelsDevFixturePath = new URL("./fixtures/models-dev-api.json", import.meta.url);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Codex LiteLLM model catalog generator", () => {
  it("uses bundled metadata, captured fallback instructions, and exact models.dev metadata", async () => {
    const runtimeDirectory = await createTemporaryDirectory();
    const outputPath = join(runtimeDirectory, "litellm-models.json");
    const bundledModel = {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Bundled model",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium", description: "Standard reasoning" }],
      experimental_supported_tools: [],
      truncation_policy: { mode: "tokens", limit: 10_000 },
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 12,
      support_verbosity: true,
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      additional_speed_tiers: ["fast"],
      service_tiers: [{ id: "priority", name: "Fast", description: "Faster" }],
      base_instructions: "Bundled instructions",
      comp_hash: "bundled-hash",
    };
    await installMockCodex(
      runtimeDirectory,
      { models: [bundledModel] },
      "Runtime fallback instructions",
    );

    const modelsDevFixture = await readFile(modelsDevFixturePath, "utf8");

    let requestedPath: string | undefined;
    let authorizationHeader: string | undefined;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/models-dev/api.json") {
        response.end(modelsDevFixture);
        return;
      }
      requestedPath = request.url;
      authorizationHeader = request.headers.authorization;
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-5.5", object: "model", created: 1, owned_by: "litellm" },
            { id: "coding-model", object: "model", created: 2, owned_by: "litellm" },
            { id: "ambiguous-coder", object: "model", created: 3, owned_by: "litellm" },
            { id: "gateway-alias", object: "model", created: 4, owned_by: "litellm" },
            { id: "speech-model", object: "model", created: 5, owned_by: "litellm" },
            { id: "whisper-1", object: "model", created: 6, owned_by: "litellm" },
            { id: "text-embedding-3-large", object: "model", created: 7, owned_by: "litellm" },
            { id: "gpt-image-2", object: "model", created: 8, owned_by: "litellm" },
            {
              id: "gemini-2.5-flash-preview-tts",
              object: "model",
              created: 9,
              owned_by: "litellm",
            },
            { id: "glm-asr-latest", object: "model", created: 10, owned_by: "litellm" },
            { id: "rerank-v3", object: "model", created: 11, owned_by: "litellm" },
            { id: "sora-video-1", object: "model", created: 12, owned_by: "litellm" },
            { id: "gpt-5.4-nano", object: "model", created: 13, owned_by: "litellm" },
            { id: "gemini-3-pro-preview", object: "model", created: 14, owned_by: "litellm" },
            { id: "glm-5.3", object: "model", created: 15, owned_by: "litellm" },
            { id: "ambiguous-non-agent", object: "model", created: 16, owned_by: "litellm" },
            { id: "no-text-input", object: "model", created: 17, owned_by: "litellm" },
            { id: "no-text-output", object: "model", created: 18, owned_by: "litellm" },
            { id: "no-tool-calling", object: "model", created: 19, owned_by: "litellm" },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

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
          "--output",
          outputPath,
          "--models-dev-endpoint",
          `http://127.0.0.1:${address.port}/models-dev/api.json`,
        ],
        {
          env: {
            ...process.env,
            LITELLM_API_KEY: "test-token",
            PATH: `${runtimeDirectory}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(stdout).toContain(
        "Instructions: bundled=1 (codex debug models --bundled); fallback=6 (codex exec loopback, codex-cli 0.154.0, sha256=",
      );
      expect(stdout).toContain("Excluded 12 non-agent models");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    const catalog: unknown = JSON.parse(await readFile(outputPath, "utf8"));
    const models = (catalog as { models: Array<Record<string, unknown>> }).models;
    const modelsBySlug = Object.fromEntries(models.map((model) => [model.slug, model]));
    const stableBundledModel: Record<string, unknown> = structuredClone(bundledModel);
    expect(requestedPath).toBe("/v1/models");
    expect(authorizationHeader).toBe("Bearer test-token");
    expect(models.map((model) => model.slug)).toEqual([
      "ambiguous-coder",
      "coding-model",
      "gateway-alias",
      "gemini-3-pro-preview",
      "glm-5.3",
      "gpt-5.4-nano",
      "gpt-5.5",
    ]);
    expect(modelsBySlug["gpt-5.5"]).toEqual(stableBundledModel);
    expect(modelsBySlug["ambiguous-coder"]).toMatchObject({
      base_instructions: "Runtime fallback instructions",
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [],
    });
    expect(modelsBySlug["coding-model"]).toMatchObject({
      base_instructions: "Runtime fallback instructions",
      context_window: 200_000,
      max_context_window: 200_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "high", description: "" },
      ],
    });
    expect(modelsBySlug["gateway-alias"]).toMatchObject({
      base_instructions: "Runtime fallback instructions",
      input_modalities: ["text", "image"],
    });
  });

  it("writes canonical bytes independent of gateway model order", async () => {
    const runtimeDirectory = await createTemporaryDirectory();
    const firstOutputPath = join(runtimeDirectory, "first.json");
    const secondOutputPath = join(runtimeDirectory, "second.json");
    await installMockCodex(
      runtimeDirectory,
      {
        models: [
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            experimental_supported_tools: [],
            priority: 1,
            shell_type: "unified_exec",
            support_verbosity: true,
            supported_in_api: true,
            supported_reasoning_levels: [],
            truncation_policy: { mode: "tokens", limit: 10_000 },
            visibility: "list",
            base_instructions: "Bundled instructions",
            model_messages: { zeta: "last", alpha: "first" },
          },
        ],
      },
      "Runtime fallback instructions",
    );

    const modelsDevFixture = JSON.parse(await readFile(modelsDevFixturePath, "utf8")) as object;

    const models = [
      { id: "vendor/zeta", object: "model", created: 2, owned_by: "litellm" },
      { id: "vendor/alpha", object: "model", created: 1, owned_by: "litellm" },
    ];
    let gatewayRequestCount = 0;
    let modelsDevRequestCount = 0;
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      if (_request.url === "/models-dev/api.json") {
        modelsDevRequestCount += 1;
        const entries = Object.entries(modelsDevFixture);
        const reverseModelsDevOrder = modelsDevRequestCount === 2;
        const orderedEntries = reverseModelsDevOrder ? entries.reverse() : entries;
        response.end(
          JSON.stringify(
            Object.fromEntries(
              orderedEntries.map(([providerId, provider]) => [
                providerId,
                {
                  ...provider,
                  models: Object.fromEntries(
                    reverseModelsDevOrder
                      ? Object.entries(provider.models).reverse()
                      : Object.entries(provider.models),
                  ),
                },
              ]),
            ),
          ),
        );
        return;
      }
      gatewayRequestCount += 1;
      response.end(
        JSON.stringify({
          object: "list",
          data:
            gatewayRequestCount === 1
              ? models
              : [...models].reverse().map((model) => ({
                  ...model,
                  created: model.created + 100,
                  owned_by: "changed",
                })),
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test server did not expose a TCP port");
      }
      const generatorArguments = [
        generatorPath.pathname,
        "--endpoint",
        `http://127.0.0.1:${address.port}/v1/models`,
        "--models-dev-endpoint",
        `http://127.0.0.1:${address.port}/models-dev/api.json`,
      ];
      const environment = {
        ...process.env,
        LITELLM_API_KEY: "test-token",
        PATH: `${runtimeDirectory}${delimiter}${process.env.PATH ?? ""}`,
      };

      await execFile(process.execPath, [...generatorArguments, "--output", firstOutputPath], {
        env: environment,
      });
      await execFile(process.execPath, [...generatorArguments, "--output", secondOutputPath], {
        env: environment,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    const firstOutput = await readFile(firstOutputPath, "utf8");
    const secondOutput = await readFile(secondOutputPath, "utf8");
    const catalog = JSON.parse(firstOutput) as { models: Array<{ slug: string }> };

    expect(firstOutput).toBe(secondOutput);
    expect(firstOutput).toMatch(/^\{\n  "models": \[/);
    expect(firstOutput.endsWith("\n")).toBe(true);
    expect(catalog.models.map((model) => model.slug)).toEqual(["vendor/alpha", "vendor/zeta"]);
    expectCanonicalKeyOrder(catalog);
  });

  it.each(["", "   "])(
    "fails before contacting the gateway when LITELLM_API_KEY is missing",
    async (apiKey) => {
      const runtimeDirectory = await createTemporaryDirectory();
      const outputPath = join(runtimeDirectory, "litellm-models.json");

      await expect(
        execFile(
          process.execPath,
          [
            generatorPath.pathname,
            "--endpoint",
            "http://127.0.0.1:1/models",
            "--output",
            outputPath,
          ],
          {
            env: {
              ...process.env,
              LITELLM_API_KEY: apiKey,
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "LITELLM_API_KEY is required. Export it before generating the catalog.",
        ),
      });
    },
  );

  it("rejects a non-standard models response", async () => {
    const runtimeDirectory = await createTemporaryDirectory();
    const outputPath = join(runtimeDirectory, "litellm-models.json");
    await installMockCodex(runtimeDirectory, {
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          experimental_supported_tools: [],
          priority: 1,
          shell_type: "unified_exec",
          support_verbosity: true,
          supported_in_api: true,
          supported_reasoning_levels: [],
          truncation_policy: { mode: "tokens", limit: 10_000 },
          visibility: "list",
          base_instructions: "Bundled instructions",
        },
      ],
    });
    const modelsDevFixture = await readFile(modelsDevFixturePath, "utf8");
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/models-dev/api.json") {
        response.end(modelsDevFixture);
        return;
      }
      response.end(JSON.stringify({ object: "list", data: [{ id: "missing-standard-fields" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test server did not expose a TCP port");
      }

      await expect(
        execFile(
          process.execPath,
          [
            generatorPath.pathname,
            "--endpoint",
            `http://127.0.0.1:${address.port}/models`,
            "--output",
            outputPath,
            "--models-dev-endpoint",
            `http://127.0.0.1:${address.port}/models-dev/api.json`,
          ],
          {
            env: {
              ...process.env,
              LITELLM_API_KEY: "test-token",
              PATH: `${runtimeDirectory}${delimiter}${process.env.PATH ?? ""}`,
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("did not return an OpenAI-compatible models list"),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});

describe("Codex LiteLLM profile", () => {
  it("uses the Responses API, command authentication, and installer-relative paths", async () => {
    const profile = await readFile(profilePath, "utf8");

    expect(profile).toContain('model_provider = "litellm"');
    expect(profile).toContain('model_catalog_json = "litellm-models.json"');
    expect(profile).toContain("[model_providers.litellm]");
    expect(profile).toContain('base_url = "https://ai-gateway.0iq.xyz/v1"');
    expect(profile).toContain('wire_api = "responses"');
    expect(profile).toContain("[model_providers.litellm.auth]");
    expect(profile).toContain('command = "node"');
    expect(profile).toContain('args = ["pi-agent-auth.mjs", "litellm"]');
    expect(profile).toContain('cwd = "~/.codex"');
    expect(profile).not.toMatch(/api_key\s*=/);
    expect(profile).not.toMatch(/env_key\s*=/);
    expect(profile).not.toMatch(/experimental_bearer_token\s*=/);
    expect(profile).not.toMatch(/requires_openai_auth\s*=/);
    expect(profile).not.toMatch(/^model\s*=/m);
    expect(profile).not.toMatch(/^approval_policy\s*=/m);
    expect(profile).not.toMatch(/^sandbox_mode\s*=/m);
    expect(profile).not.toContain("[features]");
  });
});

describe("tracked LiteLLM model catalog", () => {
  it("contains canonical Codex 0.154 ModelInfo entries", async () => {
    const contents = await readFile(trackedCatalogPath, "utf8");
    const catalog = JSON.parse(contents) as { models: Array<Record<string, unknown>> };

    expect(contents.endsWith("\n")).toBe(true);
    expect(contents).toBe(`${JSON.stringify(catalog, null, 2)}\n`);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models.map((model) => model.slug)).toEqual(
      [...catalog.models.map((model) => model.slug)].sort(compareUtf8Values),
    );
    expect(new Set(catalog.models.map((model) => model.slug)).size).toBe(catalog.models.length);
    expectCanonicalKeyOrder(catalog);

    const slugs = catalog.models.map((model) => String(model.slug));
    expect(slugs).toEqual(expect.arrayContaining(["gpt-5.5", "gemini-2.5-flash", "glm-5.3"]));
    expect(slugs).not.toEqual(
      expect.arrayContaining([
        "whisper-1",
        "gpt-4o-transcribe",
        "glm-asr-latest",
        "tts-1",
        "gemini-2.5-flash-preview-tts",
        "gpt-image-2",
        "qwen3-embedding",
        "text-embedding-3-large",
      ]),
    );
    expect(catalog.models.find((model) => model.slug === "Example")?.base_instructions).not.toBe(
      "You are Codex, a coding agent.",
    );

    for (const model of catalog.models) {
      expect(typeof model.slug).toBe("string");
      expect(String(model.slug).length).toBeGreaterThan(0);
      expect(typeof model.display_name).toBe("string");
      expect(Array.isArray(model.experimental_supported_tools)).toBe(true);
      expect(Number.isInteger(model.priority)).toBe(true);
      expect(typeof model.shell_type).toBe("string");
      expect(typeof model.support_verbosity).toBe("boolean");
      expect(typeof model.supported_in_api).toBe("boolean");
      expect(Array.isArray(model.supported_reasoning_levels)).toBe(true);
      expect(typeof model.truncation_policy).toBe("object");
      expect(model.truncation_policy).not.toBeNull();
      expect(Array.isArray(model.truncation_policy)).toBe(false);
      expect(typeof model.visibility).toBe("string");
      expect(hasCodexInstructions(model)).toBe(true);
      expect(model).not.toHaveProperty("created");
      expect(model).not.toHaveProperty("object");
      expect(model).not.toHaveProperty("owned_by");
    }
  });
});

describe("Codex provider auth helper", () => {
  it.each([
    ["litellm", "fake-litellm-token"],
    ["opencode-go", "fake-opencode-token"],
  ])("prints the current %s key from Pi auth", async (providerId, expectedKey) => {
    const temporaryHome = await createTemporaryDirectory();
    const authDirectory = join(temporaryHome, ".pi", "agent");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      join(authDirectory, "auth.json"),
      JSON.stringify({
        litellm: { key: "fake-litellm-token" },
        "opencode-go": { key: "fake-opencode-token" },
      }),
      "utf8",
    );

    const { stdout, stderr } = await execFile(
      process.execPath,
      [providerAuthPath.pathname, providerId],
      { env: { ...process.env, HOME: temporaryHome } },
    );

    expect(stdout).toBe(`${expectedKey}\n`);
    expect(stderr).toBe("");
  });

  it("fails cleanly when Pi auth is missing", async () => {
    const temporaryHome = await createTemporaryDirectory();

    await expect(
      execFile(process.execPath, [providerAuthPath.pathname, "litellm"], {
        env: { ...process.env, HOME: temporaryHome },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Pi auth file not found or unreadable"),
    });
  });

  it.each([null, "", "null"])("rejects an unusable key without leaking auth data", async (key) => {
    const temporaryHome = await createTemporaryDirectory();
    const authDirectory = join(temporaryHome, ".pi", "agent");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      join(authDirectory, "auth.json"),
      JSON.stringify({ litellm: { key }, unrelated: { key: "must-not-leak" } }),
      "utf8",
    );

    try {
      await execFile(process.execPath, [providerAuthPath.pathname, "litellm"], {
        env: { ...process.env, HOME: temporaryHome },
      });
      throw new Error("expected auth helper to fail");
    } catch (error) {
      const stderr = isExecFileError(error) ? error.stderr : String(error);
      expect(stderr).toContain("Pi auth has no key for provider litellm");
      expect(stderr).not.toContain("must-not-leak");
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-litellm-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function installMockCodex(
  runtimeDirectory: string,
  bundledCatalog: object,
  fallbackInstructions = "Runtime fallback instructions",
): Promise<void> {
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
    body: JSON.stringify({ instructions: ${JSON.stringify(fallbackInstructions)} }),
  });
  process.exitCode = 1;
}
`;
  await writeFile(executablePath, executable, "utf8");
  await chmod(executablePath, 0o755);
}

function isExecFileError(error: unknown): error is Error & { stderr: string } {
  return error instanceof Error && "stderr" in error && typeof error.stderr === "string";
}

function expectCanonicalKeyOrder(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      expectCanonicalKeyOrder(item);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  const keys = Object.keys(value);
  expect(keys).toEqual([...keys].sort(compareUtf8Values));
  for (const item of Object.values(value)) {
    expectCanonicalKeyOrder(item);
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
