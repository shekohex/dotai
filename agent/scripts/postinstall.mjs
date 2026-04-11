import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");
const templatePath = join(packageDir, "dist", "defaults", "settings.json");
const modesTemplatePath = join(packageDir, "dist", "defaults", "modes.json");
const agentDir = join(homedir(), ".pi", "agent");
const targetPath = join(agentDir, "settings.json");
const modesTargetPath = join(agentDir, "modes.json");
const patchPackageBin = join(packageDir, "node_modules", "patch-package", "index.js");
const patchedToolExecutionPath = join(
	packageDir,
	"node_modules",
	"@mariozechner",
	"pi-coding-agent",
	"dist",
	"modes",
	"interactive",
	"components",
	"tool-execution.js",
);
const dependencyPatchMarkers = ["const TOOL_RAIL_WIDTH = 3;", "getRailPrefix()", 'theme.fg("error", "▏")'];

if (isMain()) {
	await runPostinstall();
}

export async function runPostinstall() {
	if (process.env.SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL === "1") {
		console.log("[shekohex/agent] Skipping settings seed (SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL=1)");
		await ensureDependencyPatches();
		process.exit(0);
	}

	if (!existsSync(templatePath)) {
		console.log(`[shekohex/agent] Skipping settings seed; template not found: ${templatePath}`);
	} else {
		mkdirSync(agentDir, { recursive: true });

		if (existsSync(targetPath)) {
			console.log(`[shekohex/agent] Keeping existing settings: ${targetPath}`);
		} else {
			copyFileSync(templatePath, targetPath);
			console.log(`[shekohex/agent] Seeded default settings: ${targetPath}`);
		}
	}

	if (!existsSync(modesTemplatePath)) {
		console.log(`[shekohex/agent] Skipping modes seed; template not found: ${modesTemplatePath}`);
	} else {
		mkdirSync(agentDir, { recursive: true });

		if (existsSync(modesTargetPath)) {
			console.log(`[shekohex/agent] Keeping existing modes: ${modesTargetPath}`);
		} else {
			copyFileSync(modesTemplatePath, modesTargetPath);
			console.log(`[shekohex/agent] Seeded default modes: ${modesTargetPath}`);
		}
	}

	await ensureDependencyPatches();
}

export async function ensureDependencyPatches() {
	if (areDependencyPatchesApplied()) {
		return;
	}

	await applyDependencyPatches();
}

export async function applyDependencyPatches() {
	if (!existsSync(patchPackageBin)) {
		console.log(`[shekohex/agent] Skipping dependency patches; patch-package not found: ${patchPackageBin}`);
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

function areDependencyPatchesApplied() {
	if (!existsSync(patchedToolExecutionPath)) {
		return false;
	}

	const contents = readFileSync(patchedToolExecutionPath, "utf8");
	return dependencyPatchMarkers.every((marker) => contents.includes(marker));
}

function isMain() {
	if (!process.argv[1]) {
		return false;
	}

	return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
