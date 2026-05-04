import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const createdTempDirs: string[] = [];

afterEach(() => {
  for (const directoryPath of createdTempDirs.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

function createTempDir(prefix: string): string {
  const directoryPath = mkdtempSync(join(tmpdir(), prefix));
  createdTempDirs.push(directoryPath);
  return directoryPath;
}

function createMockCommand(directoryPath: string, commandName: string, source: string): void {
  const commandPath = join(directoryPath, commandName);
  writeFileSync(commandPath, source, { mode: 0o755 });
}

function createFixtureScript(defaultPackageVersion: string): string {
  const fixtureDir = createTempDir("install-script-");
  const fixturePath = join(fixtureDir, "install-github-package.sh");
  cpSync(join(process.cwd(), "scripts/install-github-package.sh"), fixturePath);

  const scriptContents = readFileSync(fixturePath, "utf8").replace(
    "default_package_version=''",
    `default_package_version='${defaultPackageVersion}'`,
  );

  writeFileSync(fixturePath, scriptContents, { mode: 0o755 });
  return fixturePath;
}

function runFixtureScript(args: string[]): { bunArgs: string; curlArgs: string[] } {
  const fixturePath = createFixtureScript("0.72.1-dev.6119212");
  const binDir = createTempDir("install-bin-");
  const curlLogPath = join(binDir, "curl.log");
  const bunLogPath = join(binDir, "bun.log");

  createMockCommand(
    binDir,
    "curl",
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${curlLogPath}"
if [[ "$*" == *"%{http_code}"* ]]; then
  printf '200'
  exit 0
fi
printf '%s' '{"dist-tags":{"preview":"0.72.1-dev.6119212"},"versions":{"0.72.1-dev.6119212":{},"0.72.1-dev.07bb683":{}}}'
`,
  );
  createMockCommand(
    binDir,
    "bun",
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "${bunLogPath}"
`,
  );

  execFileSync("bash", [fixturePath, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GH_TOKEN: "test-token",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    stdio: "pipe",
  });

  return {
    bunArgs: readFileSync(bunLogPath, "utf8").trim(),
    curlArgs: readFileSync(curlLogPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

describe("install-github-package.sh", () => {
  it("uses preview dist-tag for bun when preview asset pins exact prerelease", () => {
    const result = runFixtureScript(["--bun"]);

    expect(result.bunArgs).toContain("add --global @shekohex/agent@preview");
  });

  it("keeps curl silent by default and exposes verbose mode", () => {
    const defaultResult = runFixtureScript(["--bun"]);
    const verboseResult = runFixtureScript(["--bun", "--verbose"]);
    const scriptContents = readFileSync(
      join(process.cwd(), "scripts/install-github-package.sh"),
      "utf8",
    );

    expect(defaultResult.curlArgs.some((line) => line.startsWith("-fsSL "))).toBe(true);
    expect(verboseResult.curlArgs.some((line) => line.startsWith("-fSL "))).toBe(true);
    expect(scriptContents).toContain(
      "curl -fsSL https://raw.githubusercontent.com/shekohex/dotai/main/agent/scripts/install-github-package.sh",
    );
    expect(scriptContents).toContain("[--version VERSION] [--verbose]");
  });
});
