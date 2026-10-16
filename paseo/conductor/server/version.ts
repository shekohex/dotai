import { createHash } from "node:crypto";

/** Kept equal to package.json by a test: Paseo only bundles client/, server/, and shared/. */
export const PLUGIN_VERSION = "0.1.0";

/**
 * "0.1.0 #3f9c1a2b" for the startup log. Paseo runs the plugin from a bundle, so there's no
 * checkout to ask git; the hash of the loaded code tells two machines' builds apart instead.
 */
export function pluginBuild(code: readonly { toString(): string }[]): string {
  const hash = createHash("sha256");
  for (const part of code) hash.update(part.toString());
  return `${PLUGIN_VERSION} #${hash.digest("hex").slice(0, 8)}`;
}
