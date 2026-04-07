import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");
const sourceDir = join(packageDir, "src", "resources");
const targetDir = join(packageDir, "dist", "resources");

rmSync(targetDir, { recursive: true, force: true });

if (!existsSync(sourceDir)) {
  console.log(`[shekohex/agent] No bundled resources to copy from ${sourceDir}`);
  process.exit(0);
}

mkdirSync(dirname(targetDir), { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
console.log(`[shekohex/agent] Copied bundled resources to ${targetDir}`);
