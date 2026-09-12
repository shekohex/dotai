import { extname, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const FilePathInputSchema = Type.Object(
  {
    path: Type.String(),
  },
  { additionalProperties: true },
);

const ApplyPatchInputSchema = Type.Object(
  {
    patchText: Type.String(),
  },
  { additionalProperties: true },
);

const ALLOWED_MARKDOWN_EXTENSIONS = new Set<string>([".md", ".mdx"]);

export interface LiveWritePolicyBlock {
  block: true;
  reason: string;
}

function blocked(path?: string): LiveWritePolicyBlock {
  return {
    block: true,
    reason:
      path === undefined
        ? "Live mode limits direct file changes to Markdown documentation inside the working directory. Delegate code changes to a child session."
        : `Live mode limits direct file changes to Markdown documentation inside the working directory. Blocked: ${path}. Delegate code changes to a child session.`,
  };
}

export function enforceLiveWritePolicy(
  toolName: string,
  input: unknown,
  cwd: string,
): LiveWritePolicyBlock | undefined {
  if (toolName === "write" || toolName === "edit") {
    if (!Value.Check(FilePathInputSchema, input)) return blocked();
    const { path } = Value.Parse(FilePathInputSchema, input);
    return isMarkdownWritePathAllowed(path, cwd) ? undefined : blocked(path);
  }

  if (toolName !== "apply_patch") return undefined;
  if (!Value.Check(ApplyPatchInputSchema, input)) return blocked();
  const { patchText } = Value.Parse(ApplyPatchInputSchema, input);
  const paths = getApplyPatchPaths(patchText);
  if (paths.length === 0) return blocked();
  const blockedPath = paths.find((path) => !isMarkdownWritePathAllowed(path, cwd));
  return blockedPath === undefined ? undefined : blocked(blockedPath);
}

function isMarkdownWritePathAllowed(inputPath: string, cwd: string): boolean {
  if (!inputPath) return false;
  const targetAbs = resolve(cwd, inputPath);
  const rel = relative(resolve(cwd), targetAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return ALLOWED_MARKDOWN_EXTENSIONS.has(extname(targetAbs).toLowerCase());
}

function getApplyPatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split(/\r?\n/u)) {
    if (line.startsWith("*** Add File: ")) {
      paths.push(line.slice("*** Add File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      paths.push(line.slice("*** Update File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      paths.push(line.slice("*** Delete File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      paths.push(line.slice("*** Move to: ".length).trim());
    }
  }
  return paths;
}
