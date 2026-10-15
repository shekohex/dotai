import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";
import type { z } from "zod";

import type { previewTargetRpc, ProgressEvent } from "../shared/progress.js";
import { workspaceDirectories } from "./documents.js";
import type { ConductorPaths } from "./paths.js";

type Preview = z.infer<typeof previewTargetRpc.output>;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".log",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".csv",
]);

export class ProgressFileError extends Error {}

export async function conductorWorkspaceDirectory(
  paseo: PaseoApi,
  conductorId: string,
): Promise<string | null> {
  const workspaceId = (await paseo.agents.ref(conductorId).refresh())?.agent
    .workspaceId;
  if (!workspaceId) return null;
  return (await workspaceDirectories(paseo, workspaceId))[0] ?? null;
}

/**
 * Only targets agents recorded on the run are served, so the dashboard cannot be used to read
 * arbitrary paths. Relative targets resolve against the conductor's workspace.
 */
export function resolveTarget(
  target: string,
  recorded: ReadonlySet<string>,
  workspaceDir: string | null,
): { kind: "link"; url: string } | { kind: "file"; filePath: string } {
  if (!recorded.has(target)) {
    throw new ProgressFileError("That item is not part of this run");
  }
  if (/^https?:\/\//i.test(target)) return { kind: "link", url: target };
  if (path.isAbsolute(target)) return { kind: "file", filePath: target };
  if (!workspaceDir) throw new ProgressFileError("Workspace not found");
  return { kind: "file", filePath: path.resolve(workspaceDir, target) };
}

export async function previewFile(filePath: string): Promise<Preview> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    return { kind: "open", reason: "Not a file the app can preview" };
  }
  const extension = path.extname(filePath).toLowerCase();
  const mime = IMAGE_TYPES[extension];
  if (mime) {
    if (info.size > MAX_IMAGE_BYTES) {
      return { kind: "open", reason: "Image is larger than 10 MB" };
    }
    return {
      kind: "image",
      mime,
      data: (await readFile(filePath)).toString("base64"),
    };
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    const bytes = await readFile(filePath);
    return {
      kind: "text",
      text: bytes.subarray(0, MAX_TEXT_BYTES).toString("utf8"),
      truncated: bytes.length > MAX_TEXT_BYTES,
    };
  }
  return { kind: "open", reason: "Open it on the machine running Paseo" };
}

export function openOnHost(filePath: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [filePath]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", filePath]]
        : ["xdg-open", [filePath]];
  return new Promise((resolve, reject) => {
    execFile(command as string, args as string[], (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

/** Per-conductor setting: a repo folder that mirrors each run as one JSONL file. */
export class RunHistory {
  constructor(private readonly paths: ConductorPaths) {}

  private file(conductorId: string): string {
    return path.join(
      this.paths.conductorDir(conductorId),
      "progress-history.json",
    );
  }

  async folder(conductorId: string): Promise<string | null> {
    const raw = await readFile(this.file(conductorId), "utf8").catch(() => "");
    try {
      const folder = (JSON.parse(raw) as { folder?: unknown }).folder;
      return typeof folder === "string" && folder ? folder : null;
    } catch {
      return null;
    }
  }

  async setFolder(conductorId: string, folder: string | null): Promise<void> {
    if (folder !== null) {
      const clean = path.normalize(folder.trim());
      if (
        !clean ||
        clean === "." ||
        path.isAbsolute(clean) ||
        clean.startsWith("..")
      ) {
        throw new ProgressFileError(
          "Pick a folder inside the project, like docs/progress",
        );
      }
      folder = clean;
    }
    await mkdir(this.paths.conductorDir(conductorId), { recursive: true });
    await writeFile(this.file(conductorId), JSON.stringify({ folder }));
  }

  /** Rewrites this run's file so it always matches the log; one file per run avoids merge conflicts. */
  async mirror(
    conductorId: string,
    workspaceDir: string,
    run: readonly ProgressEvent[],
  ): Promise<void> {
    const folder = await this.folder(conductorId);
    const start = run[0];
    if (!folder || !start) return;
    const stamp = start.ts
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "")
      .replace("T", "-");
    const slug =
      (start.title ?? "run")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "run";
    const directory = path.join(workspaceDir, folder, "history");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${stamp}-${slug}.jsonl`),
      `${run.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  }
}
