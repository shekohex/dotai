import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const jsonObjectSchema = z.record(z.string(), z.unknown());

export interface RuntimeIdentityFile {
  destination: string;
  contents: string;
}

interface IdentityFileSpec {
  label: string;
  source: string[];
  destination: string;
}

const identityFileSpecs: IdentityFileSpec[] = [
  {
    label: "Pi auth",
    source: [".pi", "agent", "auth.json"],
    destination: "/home/coder/.pi/agent/auth.json",
  },
  {
    label: "Codex auth",
    source: [".codex", "auth.json"],
    destination: "/home/coder/.codex/auth.json",
  },
  {
    label: "Paseo config",
    source: [".paseo", "config.json"],
    destination: "/home/coder/.paseo/config.json",
  },
];

async function loadIdentityFile(
  homeDirectory: string,
  spec: IdentityFileSpec,
): Promise<RuntimeIdentityFile> {
  const sourcePath = path.join(homeDirectory, ...spec.source);
  let contents: string;
  try {
    contents = await readFile(sourcePath, "utf8");
  } catch (error) {
    throw new Error(`${spec.label} file does not exist: ${sourcePath}`, {
      cause: error,
    });
  }
  try {
    jsonObjectSchema.parse(JSON.parse(contents) as unknown);
  } catch (error) {
    throw new Error(`${spec.label} file is not valid JSON: ${sourcePath}`, {
      cause: error,
    });
  }
  return { destination: spec.destination, contents };
}

export async function loadRuntimeIdentityFiles(
  homeDirectory = os.homedir(),
): Promise<RuntimeIdentityFile[]> {
  const files: RuntimeIdentityFile[] = [];
  for (const spec of identityFileSpecs) {
    files.push(await loadIdentityFile(homeDirectory, spec));
  }
  return files;
}
