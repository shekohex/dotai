/**
 * Pi-fff: FFF-powered file search extension for pi
 *
 * Overrides built-in `find` and `grep` tools with FFF and adds FFF-backed at-mention autocomplete
 * suggestions to the interactive editor.
 */

import nodePath from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FileFinderApi } from "@ff-labs/fff-node";
import { errorMessage } from "../../utils/error-message.js";
import { AuxFinderPool, routePathConstraint } from "./aux-finders.js";
import { registerAutocompleteProvider } from "./autocomplete.js";
import { readFffConfig, registerFffFlags } from "./config.js";
import { registerFffCommand } from "./commands.js";
import { isHomeDir } from "./paths.js";
import { buildQuery } from "./query.js";
import { FileFinder, SCAN_TIMEOUT_MS } from "./sdk.js";
import { registerSearchTools } from "./tools.js";
import type { FffToolRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fffExtension(pi: ExtensionAPI): void {
  const config = readFffConfig(pi);
  let finder: FileFinderApi | null = null;
  let finderCwd: string | null = null;
  // Concurrent ensureFinder() callers share the same in-flight promise so
  // FileFinder.create() (which takes native DB locks) runs at most once per
  // base path at a time — otherwise parallel tool calls would race and
  // deadlock at the native layer (issue #403).
  let finderPromise: Promise<FileFinderApi> | null = null;
  let activeCwd = process.cwd();
  let uiContext: {
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => void;
      setStatus?: (key: string, text: string | undefined) => void;
    };
  } | null = null;
  let homeScanTimer: ReturnType<typeof setInterval> | null = null;
  const auxFinders = new AuxFinderPool({
    enableFsRootScanning: config.enableFsRootScanning,
    enableHomeDirScanning: config.enableHomeDirScanning,
    onHomeDirScan: (root) => {
      uiContext?.ui.notify(
        `(fff): Your cwd (${root}) is too large. Indexing will take additional time and resources.`,
        "warning",
      );
    },
  });

  function ensureFinder(cwd: string): Promise<FileFinderApi> {
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
        enableHomeDirScanning: config.enableHomeDirScanning,
        enableFsRootScanning: config.enableFsRootScanning,
      });

      if (!result.ok) throw new Error(`Failed to create FFF file finder: ${result.error}`);

      finder = result.value;
      finderCwd = cwd;
      await finder.waitForScan(SCAN_TIMEOUT_MS);
      return finder;
    })().finally(() => {
      finderPromise = null;
    });

    return finderPromise;
  }

  function destroyFinder(): void {
    if (homeScanTimer !== null) {
      clearInterval(homeScanTimer);
      homeScanTimer = null;
    }
    uiContext?.ui.setStatus?.("fff", undefined);
    if (finder !== null && !finder.isDestroyed) {
      finder.destroy();
      finder = null;
      finderCwd = null;
    }
    auxFinders.destroy();
  }

  async function resolveFinderForPath(
    pathConstraint: string | undefined,
    pattern: string,
    exclude: string | string[] | undefined,
  ): Promise<{ finder: FileFinderApi; query: string; root: string } | null> {
    const route = routePathConstraint(pathConstraint, activeCwd);
    if (route === null) return null;

    const auxiliary = await auxFinders.acquire(route.root);
    const rebase = nodePath.relative(auxiliary.root, route.root).replaceAll(nodePath.sep, "/");
    const suffix = [rebase, route.suffix].filter(Boolean).join("/");
    return {
      finder: auxiliary.finder,
      query: buildQuery(suffix || undefined, pattern, exclude, auxiliary.root),
      root: auxiliary.root,
    };
  }

  function trackHomeScan(): void {
    if (homeScanTimer !== null) clearInterval(homeScanTimer);
    if (uiContext?.ui.setStatus === undefined) return;

    const tick = () => {
      const progress = finder?.getScanProgress();
      if (progress === undefined || !progress.ok || !progress.value.isScanning) {
        if (homeScanTimer !== null) clearInterval(homeScanTimer);
        homeScanTimer = null;
        uiContext?.ui.setStatus?.("fff", undefined);
        return;
      }
      uiContext?.ui.setStatus?.(
        "fff",
        `Agent is indexing $HOME (${progress.value.scannedFilesCount} files), this can lead to high CPU`,
      );
    };

    homeScanTimer = setInterval(tick, 1000);
    homeScanTimer.unref?.();
    tick();
  }

  const runtime: FffToolRuntime = {
    ensureFinder,
    getActiveCwd: () => activeCwd,
    resolveFinderForPath,
  };

  registerFffFlags(pi);
  registerSearchTools(pi, runtime);
  registerFffCommand(pi, () => finder);

  pi.on("session_start", async (_event, ctx) => {
    try {
      activeCwd = ctx.cwd;
      uiContext = createUiContext(ctx);
      registerAutocompleteProvider(runtime, ctx);
      await ensureFinder(activeCwd);
      if (config.enableHomeDirScanning && isHomeDir(activeCwd)) trackHomeScan();
    } catch (error: unknown) {
      ctx.ui.notify(`FFF init failed: ${errorMessage(error)}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    destroyFinder();
  });
}

function createUiContext(ctx: {
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
}): {
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
} {
  return {
    ui: {
      notify: ctx.ui.notify.bind(ctx.ui),
      setStatus: ctx.ui.setStatus?.bind(ctx.ui),
    },
  };
}
