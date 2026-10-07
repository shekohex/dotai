import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";

import type { ConductorDocument, DocumentRef } from "../shared/contracts.js";
import {
  CONDUCTOR_CORE_FILES,
  GLOBAL_CORE_FILES,
  listMemoryFiles,
  type MemoryFile,
} from "./memory.js";
import type { ConductorPaths } from "./paths.js";
import {
  PROJECT_INSTRUCTIONS_FILE,
  projectInstructionsPath,
} from "./project-instructions.js";

export class DocumentConflictError extends Error {
  constructor(name: string) {
    super(`${name} changed since you opened it. Reload it and try again`);
    this.name = "DocumentConflictError";
  }
}

/** Workspace directory first, then project root: where CONDUCTOR.md is looked up. */
export async function workspaceDirectories(
  paseo: PaseoApi,
  workspaceId: string,
): Promise<string[]> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  return [
    ...new Set(
      [workspace?.workspaceDirectory, workspace?.projectRootPath].filter(
        (directory): directory is string => Boolean(directory),
      ),
    ),
  ];
}

export function isCoreDocument(ref: DocumentRef): boolean {
  if (ref.scope === "conductor") return ref.name in CONDUCTOR_CORE_FILES;
  if (ref.scope === "global") return ref.name in GLOBAL_CORE_FILES;
  return false;
}

export async function documentPath(
  paths: ConductorPaths,
  ref: DocumentRef,
  paseo: PaseoApi,
): Promise<string> {
  if (ref.scope === "conductor")
    return path.join(paths.conductorDir(ref.conductorId), ref.name);
  if (ref.scope === "global") return path.join(paths.sharedMemoryDir, ref.name);
  const target = await projectInstructionsPath(
    await workspaceDirectories(paseo, ref.workspaceId),
  );
  if (!target) throw new Error("Workspace has no directory");
  return target;
}

/** Writes or deletes (`content: null`) only if the file still holds `previousContent`. */
export async function writeDocumentFile(input: {
  filePath: string;
  content: string | null;
  previousContent: string | null;
  core: boolean;
}): Promise<void> {
  const name = path.basename(input.filePath);
  if (input.content === null && input.core) {
    throw new Error(
      `${name} is required. Clear its content instead of deleting it`,
    );
  }
  const current = await readFile(input.filePath, "utf8").catch(() => null);
  if (current !== input.previousContent) throw new DocumentConflictError(name);
  if (input.content === null) {
    await rm(input.filePath, { force: true });
    return;
  }
  await mkdir(path.dirname(input.filePath), { recursive: true });
  await writeFile(input.filePath, input.content);
}

function toDocument(file: MemoryFile, ref: DocumentRef): ConductorDocument {
  return {
    ref,
    name: file.name,
    path: file.path,
    content: file.content,
    core: file.core,
  };
}

export async function listDocuments(
  paths: ConductorPaths,
  paseo: PaseoApi,
  input: { conductorId?: string; workspaceId?: string },
): Promise<{
  conductor: ConductorDocument[];
  global: ConductorDocument[];
  project: ConductorDocument | null;
}> {
  const { conductorId } = input;
  const conductor = conductorId
    ? (
        await listMemoryFiles(
          paths.conductorDir(conductorId),
          CONDUCTOR_CORE_FILES,
        )
      ).map((file) =>
        toDocument(file, { scope: "conductor", conductorId, name: file.name }),
      )
    : [];
  const global = (
    await listMemoryFiles(paths.sharedMemoryDir, GLOBAL_CORE_FILES)
  ).map((file) => toDocument(file, { scope: "global", name: file.name }));

  let workspaceId = input.workspaceId;
  if (!workspaceId && conductorId) {
    workspaceId = (await paseo.agents.ref(conductorId).refresh())?.agent
      .workspaceId;
  }
  let project: ConductorDocument | null = null;
  if (workspaceId) {
    const filePath = await projectInstructionsPath(
      await workspaceDirectories(paseo, workspaceId),
    );
    if (filePath) {
      project = {
        ref: { scope: "project", workspaceId },
        name: PROJECT_INSTRUCTIONS_FILE,
        path: filePath,
        content: await readFile(filePath, "utf8").catch(() => null),
        core: false,
      };
    }
  }
  return { conductor, global, project };
}
