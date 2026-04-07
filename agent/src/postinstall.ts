import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatePath = join(__dirname, "defaults", "settings.json");
const agentDir = join(homedir(), ".pi", "agent");
const targetPath = join(agentDir, "settings.json");

if (process.env.SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL === "1") {
	console.log("[shekohex/agent] Skipping settings seed (SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL=1)");
	process.exit(0);
}

if (!existsSync(templatePath)) {
	console.log(`[shekohex/agent] Skipping settings seed; template not found: ${templatePath}`);
	process.exit(0);
}

mkdirSync(agentDir, { recursive: true });

if (existsSync(targetPath)) {
	console.log(`[shekohex/agent] Keeping existing settings: ${targetPath}`);
	process.exit(0);
}

copyFileSync(templatePath, targetPath);
console.log(`[shekohex/agent] Seeded default settings: ${targetPath}`);
