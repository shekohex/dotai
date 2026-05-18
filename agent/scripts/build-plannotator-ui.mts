import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const scriptDir = import.meta.dirname;
const packageDir = join(scriptDir, "..");
const resourcesDir = join(packageDir, "src", "resources", "plannotator");
const vendorRoot = join(packageDir, "vendor", "plannotator-ui");
const reviewAppDir = join(vendorRoot, "apps", "review");
const hookAppDir = join(vendorRoot, "apps", "hook");
const packageDirs = [
  join(vendorRoot, "packages", "shared"),
  join(vendorRoot, "packages", "ui"),
  join(vendorRoot, "packages", "editor"),
  join(vendorRoot, "packages", "review-editor"),
];

function isCiEnvironment(): boolean {
  return process.env.CI === "true";
}

function runNpmInstall(cwd: string): void {
  execFileSync("npm", ["install"], {
    cwd,
    stdio: "inherit",
  });
}

function runNpmBuild(cwd: string): void {
  execFileSync("npx", ["vite", "build", "--mode", "production"], {
    cwd,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
  });
}

function ensureNodeModulesPresent(cwd: string): void {
  const nodeModulesDir = join(cwd, "node_modules");
  if (existsSync(nodeModulesDir)) {
    return;
  }
  if (isCiEnvironment()) {
    console.log(`[shekohex/agent] Installing vendored UI dependencies in ${cwd}`);
    runNpmInstall(cwd);
    return;
  }
  throw new Error(
    `Missing vendored UI dependencies in ${cwd}. Run 'npm install' in vendor/plannotator-ui packages as explicit sync step before building.`,
  );
}

if (!existsSync(reviewAppDir) || !existsSync(hookAppDir)) {
  console.log("[shekohex/agent] Skipping Plannotator UI build; vendored source tree missing");
  process.exit(0);
}

if (process.env.SHEKOHEX_AGENT_SKIP_PLANNOTATOR_BUILD === "true") {
  const plannotatorPath = join(resourcesDir, "plannotator.html");
  const reviewEditorPath = join(resourcesDir, "review-editor.html");
  if (existsSync(plannotatorPath) && existsSync(reviewEditorPath)) {
    console.log("[shekohex/agent] Skipping Plannotator UI build; cached resources present");
    process.exit(0);
  }
}

for (const vendoredPackageDir of [...packageDirs, reviewAppDir, hookAppDir]) {
  ensureNodeModulesPresent(vendoredPackageDir);
}

runNpmBuild(reviewAppDir);
runNpmBuild(hookAppDir);

mkdirSync(resourcesDir, { recursive: true });
cpSync(join(hookAppDir, "dist", "index.html"), join(resourcesDir, "plannotator.html"));
cpSync(join(reviewAppDir, "dist", "index.html"), join(resourcesDir, "review-editor.html"));

for (const outputDir of [join(reviewAppDir, "dist"), join(hookAppDir, "dist")]) {
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }
}
