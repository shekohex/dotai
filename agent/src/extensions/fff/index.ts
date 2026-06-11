/**
 * Pi-fff: FFF-powered file search extension for pi
 *
 * Overrides built-in `find` and `grep` tools with FFF and adds FFF-backed at-mention autocomplete
 * suggestions to the interactive editor.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FileFinder } from "@ff-labs/fff-node";
import { errorMessage } from "../../utils/error-message.js";
import { registerAutocompleteProvider } from "./autocomplete.js";
import { readFffConfig, registerFffFlags } from "./config.js";
import { registerFffCommand } from "./commands.js";
import { registerSearchTools } from "./tools.js";
import type { FffToolRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fffExtension(pi: ExtensionAPI): void {
  const config = readFffConfig(pi);
  let finder: FileFinder | null = null;
  let finderCwd: string | null = null;
  // Concurrent ensureFinder() callers share the same in-flight promise so
  // FileFinder.create() (which takes native DB locks) runs at most once per
  // base path at a time — otherwise parallel tool calls would race and
  // deadlock at the native layer (issue #403).
  let finderPromise: Promise<FileFinder> | null = null;
  let activeCwd = process.cwd();

  function ensureFinder(cwd: string): Promise<FileFinder> {
    if (finder !== null && !finder.isDestroyed && finderCwd === cwd) return Promise.resolve(finder);
    if (finderPromise !== null) return finderPromise;

    finderPromise = (async () => {
      if (finder !== null && !finder.isDestroyed) {
        finder.destroy();
        finder = null;
        finderCwd = null;
      }

      const result = FileFinder.create({
        basePath: cwd,
        frecencyDbPath: config.frecencyDbPath,
        historyDbPath: config.historyDbPath,
        aiMode: true,
        enableHomeDirScanning: true,
        enableFsRootScanning: config.enableFsRootScanning,
      });

      if (!result.ok) throw new Error(`Failed to create FFF file finder: ${result.error}`);

      finder = result.value;
      finderCwd = cwd;
      await finder.waitForScan(15000);
      return finder;
    })().finally(() => {
      finderPromise = null;
    });

    return finderPromise;
  }

  function destroyFinder(): void {
    if (finder !== null && !finder.isDestroyed) {
      finder.destroy();
      finder = null;
      finderCwd = null;
    }
  }

  const runtime: FffToolRuntime = {
    ensureFinder,
    getActiveCwd: () => activeCwd,
  };

  registerFffFlags(pi);
  registerSearchTools(pi, runtime);
  registerFffCommand(pi, () => finder);

  pi.on("session_start", async (_event, ctx) => {
    try {
      activeCwd = ctx.cwd;
      registerAutocompleteProvider(runtime, ctx);
      await ensureFinder(activeCwd);
    } catch (error: unknown) {
      ctx.ui.notify(`FFF init failed: ${errorMessage(error)}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    destroyFinder();
  });
}
