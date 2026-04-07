import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");
const compiledPostinstall = join(packageDir, "dist", "postinstall.js");

if (!existsSync(compiledPostinstall)) {
	console.log(`[shekohex/agent] Skipping settings seed; compiled postinstall not found: ${compiledPostinstall}`);
	process.exit(0);
}

await import(pathToFileURL(compiledPostinstall).href);
