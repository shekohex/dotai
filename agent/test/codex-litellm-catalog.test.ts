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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Codex LiteLLM model catalog generator", () => {
  it("writes exposed models using installed bundled model metadata", async () => {
    const runtimeDirectory = await createTemporaryDirectory();
    const outputPath = join(runtimeDirectory, "litellm-models.json");
    const bundledModel = {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Bundled model",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium", description: "Standard reasoning" }],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 12,
      support_verbosity: true,
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      additional_speed_tiers: ["fast"],
      service_tiers: [{ id: "priority", name: "Fast", description: "Faster" }],
    };
    await installMockCodex(runtimeDirectory, { models: [bundledModel] });

    let requestedPath: string | undefined;
    let authorizationHeader: string | undefined;
    const server = createServer((request, response) => {
      requestedPath = request.url;
      authorizationHeader = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-5.5", object: "model", created: 1, owned_by: "litellm" },
            { id: "vendor/custom-code", object: "model", created: 2, owned_by: "litellm" },
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

      await execFile(
        process.execPath,
        [
          generatorPath.pathname,
          "--endpoint",
          `http://127.0.0.1:${address.port}/v1/models`,
          "--output",
          outputPath,
        ],
        {
          env: {
            ...process.env,
            LITELLM_API_KEY: "test-token",
            PATH: `${runtimeDirectory}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }

    const catalog: unknown = JSON.parse(await readFile(outputPath, "utf8"));
    expect(requestedPath).toBe("/v1/models");
    expect(authorizationHeader).toBe("Bearer test-token");
    expect(catalog).toMatchObject({
      models: [
        bundledModel,
        {
          slug: "vendor/custom-code",
          display_name: "vendor/custom-code",
          description: "Available through LiteLLM.",
          visibility: "list",
          supported_in_api: true,
          priority: 1001,
          input_modalities: ["text"],
          supports_search_tool: false,
          additional_speed_tiers: [],
          service_tiers: [],
        },
      ],
    });
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
    await installMockCodex(runtimeDirectory, { models: [{ slug: "gpt-5.5" }] });
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
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

async function installMockCodex(runtimeDirectory: string, bundledCatalog: object): Promise<void> {
  const executablePath = join(runtimeDirectory, "codex");
  const executable = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(bundledCatalog))});\n`;
  await writeFile(executablePath, executable, "utf8");
  await chmod(executablePath, 0o755);
}

function isExecFileError(error: unknown): error is Error & { stderr: string } {
  return error instanceof Error && "stderr" in error && typeof error.stderr === "string";
}
