import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const __dirname = import.meta.dirname;
const packageDir = join(__dirname, "..");
const sourceDir = join(packageDir, "src", "resources");
const targetDir = join(packageDir, "dist", "resources");
const interviewFormSourceDir = join(packageDir, "src", "extensions", "interview", "form");
const interviewFormTargetDir = join(packageDir, "dist", "extensions", "interview", "form");

rmSync(targetDir, { recursive: true, force: true });

if (!existsSync(sourceDir)) {
  console.log(`[shekohex/agent] No bundled resources to copy from ${sourceDir}`);
  process.exit(0);
}

mkdirSync(dirname(targetDir), { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
console.log(`[shekohex/agent] Copied bundled resources to ${targetDir}`);

rmSync(interviewFormTargetDir, { recursive: true, force: true });
if (existsSync(interviewFormSourceDir)) {
  mkdirSync(dirname(interviewFormTargetDir), { recursive: true });
  cpSync(interviewFormSourceDir, interviewFormTargetDir, { recursive: true });
  console.log(`[shekohex/agent] Copied interview form assets to ${interviewFormTargetDir}`);
}
