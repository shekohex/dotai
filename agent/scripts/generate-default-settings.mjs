import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");
const moduleUrl = pathToFileURL(join(packageDir, "dist", "default-settings.js")).href;
const { defaultModes, defaultSettings } = await import(moduleUrl);

const outDir = join(packageDir, "dist", "defaults");
const settingsOutPath = join(outDir, "settings.json");
const modesOutPath = join(outDir, "modes.json");

function stripUndefined(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map(stripUndefined).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, nestedValue]) => [key, stripUndefined(nestedValue)])
      .filter(([, nestedValue]) => nestedValue !== undefined);
    return Object.fromEntries(entries);
  }
  return value;
}

const sanitizedSettings = stripUndefined(defaultSettings);
const sanitizedModes = stripUndefined(defaultModes);

mkdirSync(outDir, { recursive: true });
writeFileSync(settingsOutPath, `${JSON.stringify(sanitizedSettings, null, 2)}\n`, "utf8");
writeFileSync(modesOutPath, `${JSON.stringify(sanitizedModes, null, 2)}\n`, "utf8");
console.log(`[shekohex/agent] Generated ${settingsOutPath}`);
console.log(`[shekohex/agent] Generated ${modesOutPath}`);
