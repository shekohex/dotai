import { readFile } from "node:fs/promises";
import os from "node:os";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function readInputPath(input: Record<string, unknown>): string | undefined {
  const value = input.path ?? input.file_path;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expandPath(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return os.homedir() + filePath.slice(1);
  }
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function resolveInputPath(filePath: string, cwd: string): string {
  const expandedPath = expandPath(filePath);
  return isAbsolute(expandedPath) ? expandedPath : resolvePath(cwd, expandedPath);
}

function resolveSkillPath(
  input: Record<string, unknown>,
  ctx: ExtensionContext,
): string | undefined {
  const filePath = readInputPath(input);
  if (filePath === undefined) {
    return undefined;
  }
  const absolutePath = resolveInputPath(filePath, ctx.cwd);
  return basename(absolutePath) === "SKILL.md" ? absolutePath : undefined;
}

function isSkillRead(input: Record<string, unknown>, ctx: ExtensionContext): boolean {
  return resolveSkillPath(input, ctx) !== undefined;
}

export default function skillReadExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "read" || !isSkillRead(event.input, ctx)) {
      return;
    }

    delete event.input.offset;
    delete event.input.limit;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) {
      return {};
    }

    const absolutePath = resolveSkillPath(event.input, ctx);
    if (absolutePath === undefined) {
      return {};
    }

    try {
      const text = await readFile(absolutePath, "utf8");
      return {
        content: [{ type: "text", text }],
      };
    } catch {
      return {};
    }
  });
}
