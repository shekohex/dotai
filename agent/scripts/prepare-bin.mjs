import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");
const binDir = join(packageDir, "bin");
const distCliPath = join(packageDir, "dist", "cli.js");
const unixBinPath = join(binDir, "pi.js");
const windowsBinPath = join(binDir, "pi.cmd");

const unixBinContents = `#!/usr/bin/env node
import "../dist/cli.js";
`;

const windowsBinContents = `@ECHO off
node "%~dp0\\pi.js" %*
`;

mkdirSync(binDir, { recursive: true });

writeIfChanged(unixBinPath, unixBinContents);
writeIfChanged(windowsBinPath, windowsBinContents);

chmodIfExists(unixBinPath, 0o755);
chmodIfExists(distCliPath, 0o755);

console.log(`[shekohex/agent] Prepared bin wrappers in ${binDir}`);

function writeIfChanged(path, contents) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (existing === contents) return;
  writeFileSync(path, contents, "utf8");
}

function chmodIfExists(path, mode) {
  if (!existsSync(path)) return;
  chmodSync(path, mode);
}
