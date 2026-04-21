import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const __dirname = import.meta.dirname;
const packageDir = join(__dirname, "..");
const templatePath = join(packageDir, "dist", "defaults", "settings.json");
const modesTemplatePath = join(packageDir, "dist", "defaults", "modes.json");
const agentDir = join(homedir(), ".pi", "agent");
const targetPath = join(agentDir, "settings.json");
const modesTargetPath = join(agentDir, "modes.json");
const patchPackageBin = join(packageDir, "node_modules", "patch-package", "index.js");
const patchesDir = join(packageDir, "patches");
const dependencyPatchApplyMarker = join(
  packageDir,
  "node_modules",
  ".shekohex-agent-dependency-patches-applied",
);

if (isMain()) {
  runPostinstall();
}

export function runPostinstall() {
  if (process.env.SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL === "1") {
    console.log("[shekohex/agent] Skipping settings seed (SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL=1)");
    ensureDependencyPatches();
    process.exit(0);
  }

  if (existsSync(templatePath)) {
    mkdirSync(agentDir, { recursive: true });

    if (existsSync(targetPath)) {
      console.log(`[shekohex/agent] Keeping existing settings: ${targetPath}`);
    } else {
      copyFileSync(templatePath, targetPath);
      console.log(`[shekohex/agent] Seeded default settings: ${targetPath}`);
    }
  } else {
    console.log(`[shekohex/agent] Skipping settings seed; template not found: ${templatePath}`);
  }

  if (existsSync(modesTemplatePath)) {
    mkdirSync(agentDir, { recursive: true });

    if (existsSync(modesTargetPath)) {
      console.log(`[shekohex/agent] Keeping existing modes: ${modesTargetPath}`);
    } else {
      copyFileSync(modesTemplatePath, modesTargetPath);
      console.log(`[shekohex/agent] Seeded default modes: ${modesTargetPath}`);
    }
  } else {
    console.log(`[shekohex/agent] Skipping modes seed; template not found: ${modesTemplatePath}`);
  }

  ensureDependencyPatches();
}

export function ensureDependencyPatches() {
  if (areDependencyPatchesApplied()) {
    return;
  }

  applyDependencyPatches();
  writeFileSync(dependencyPatchApplyMarker, `${new Date().toISOString()}\n`, "utf8");
}

export function applyDependencyPatches() {
  if (!existsSync(patchPackageBin)) {
    console.log(
      `[shekohex/agent] Skipping dependency patches; patch-package not found: ${patchPackageBin}`,
    );
    return;
  }

  const result = spawnSync(process.execPath, [patchPackageBin], {
    cwd: packageDir,
    stdio: "inherit",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgSign",
      GIT_CONFIG_VALUE_0: "false",
    },
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function listDependencyPatchFiles() {
  if (!existsSync(patchesDir)) {
    return [];
  }

  return readdirSync(patchesDir)
    .filter((entry) => entry.endsWith(".patch"))
    .map((entry) => join(patchesDir, entry));
}

function areDependencyPatchesApplied() {
  const patchFiles = listDependencyPatchFiles();
  if (patchFiles.length === 0) {
    return true;
  }

  if (!existsSync(dependencyPatchApplyMarker)) {
    return false;
  }

  const markerMtime = statSync(dependencyPatchApplyMarker).mtimeMs;
  return patchFiles.every((patchFile) => {
    const patchMtime = statSync(patchFile).mtimeMs;
    return patchMtime <= markerMtime;
  });
}

function isMain() {
  if (process.argv[1] === undefined || process.argv[1].length === 0) {
    return false;
  }

  return resolve(process.argv[1]) === import.meta.filename;
}
