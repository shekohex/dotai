import { defineConfig } from "vitest/config";

const runningInGitHubActions = process.env.GITHUB_ACTIONS === "true";

export default defineConfig({
  test: {
    dir: "test",
    include: ["**/*.test.ts"],
    reporters: [["minimal", { summary: false }], "json"],
    outputFile: {
      json: "/tmp/vitest-results.json",
    },
    silent: "passed-only",
    hideSkippedTests: true,
    maxWorkers: runningInGitHubActions ? 1 : 6,
    testTimeout: runningInGitHubActions ? 30_000 : undefined,
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: ".tmp/coverage",
      include: ["src/**/*.ts"],
      exclude: ["test/**/*.ts"],
    },
  },
});
