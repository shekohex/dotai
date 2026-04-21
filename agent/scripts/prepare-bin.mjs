import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const __dirname = import.meta.dirname;
const packageDir = join(__dirname, "..");
const binDir = join(packageDir, "bin");
const distCliPath = join(packageDir, "dist", "cli.js");
const unixBinPath = join(binDir, "pi.js");
const windowsBinPath = join(binDir, "pi.cmd");

const unixBinContents = `#!/usr/bin/env node
import { ensureDependencyPatches } from "../scripts/postinstall.mjs";
ensureDependencyPatches();
await import("../dist/cli.js");
`;

const windowsBinContents = `@ECHO off
node "%~dp0\\pi.js" %*
`;

mkdirSync(binDir, { recursive: true });

const existingUnix = existsSync(unixBinPath) ? readFileSync(unixBinPath, "utf8") : undefined;
if (existingUnix !== unixBinContents) {
  writeFileSync(unixBinPath, unixBinContents, "utf8");
}

const existingWindows = existsSync(windowsBinPath)
  ? readFileSync(windowsBinPath, "utf8")
  : undefined;
if (existingWindows !== windowsBinContents) {
  writeFileSync(windowsBinPath, windowsBinContents, "utf8");
}

if (existsSync(unixBinPath)) {
  chmodSync(unixBinPath, 0o755);
}

if (existsSync(distCliPath)) {
  chmodSync(distCliPath, 0o755);
}

console.log(`[shekohex/agent] Prepared bin wrappers in ${binDir}`);
