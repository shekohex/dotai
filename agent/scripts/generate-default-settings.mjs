import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultModes, defaultSettings } from "../dist/default-settings.js";

const __dirname = import.meta.dirname;
const packageDir = join(__dirname, "..");

const outDir = join(packageDir, "dist", "defaults");
const settingsOutPath = join(outDir, "settings.json");
const modesOutPath = join(outDir, "modes.json");

mkdirSync(outDir, { recursive: true });
writeFileSync(settingsOutPath, `${JSON.stringify(defaultSettings, null, 2)}\n`, "utf8");
writeFileSync(modesOutPath, `${JSON.stringify(defaultModes, null, 2)}\n`, "utf8");
console.log(`[shekohex/agent] Generated ${settingsOutPath}`);
console.log(`[shekohex/agent] Generated ${modesOutPath}`);
