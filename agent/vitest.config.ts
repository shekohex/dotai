import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const runningInGitHubActions = process.env.GITHUB_ACTIONS === "true";

export default defineConfig({
  resolve: {
    alias: {
      "@support/pi-test-harness": resolve(import.meta.dirname, "test/support/pi-test-harness"),
    },
  },
  test: {
    dir: "test",
    include: ["**/*.test.ts"],
    setupFiles: ["./test/test-utils/setup-env.ts"],
    reporters: [["minimal", { summary: false }], "json"],
    outputFile: {
      json: "/tmp/vitest-results.json",
    },
    silent: "passed-only",
    hideSkippedTests: true,
    maxWorkers: runningInGitHubActions ? 8 : 6,
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
