import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";

type TextContent = { type: "text"; text: string };

const AGENTS_FILENAMES = ["AGENTS.override.md", "AGENTS.md"];

function findGitRoot(startDir: string): string {
  let dir = startDir;

  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return startDir;
    }

    dir = parent;
  }
}

function resolvePath(targetPath: string, baseDir: string): string {
  let absolute = targetPath;

  if (absolute.startsWith("@")) {
    absolute = absolute.slice(1);
  }

  if (absolute === "~") {
    absolute = os.homedir();
  } else if (absolute.startsWith("~/")) {
    absolute = path.join(os.homedir(), absolute.slice(2));
  }

  absolute = path.isAbsolute(absolute) ? path.normalize(absolute) : path.resolve(baseDir, absolute);

  try {
    return fs.realpathSync.native?.(absolute) ?? fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isInsideRoot(rootDir: string, targetPath: string): boolean {
  if (!rootDir) {
    return false;
  }

  const relative = path.relative(rootDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getAgentsFileFromDir(dir: string): string {
  for (const filename of AGENTS_FILENAMES) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "";
}

function findContainingSkillDir(targetPath: string): string {
  let dir = path.dirname(targetPath);

  while (true) {
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return "";
    }

    dir = parent;
  }
}

function countLines(content: string): number {
  if (!content) {
    return 0;
  }

  const lines = content.split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}

export default function agentsMdExtension(pi: ExtensionAPI) {
  const loadedAgents = new Set<string>();
  let currentCwd = "";
  let sessionRoot = "";
  let homeDir = "";

  const formatAgentsPath = (agentsPath: string): string => {
    const normalizedPath = path.normalize(agentsPath);

    if (currentCwd) {
      const cwdRelative = path.relative(currentCwd, normalizedPath);
      if (cwdRelative === "") {
        return ".";
      }
      if (!cwdRelative.startsWith("..") && !path.isAbsolute(cwdRelative)) {
        return cwdRelative.replaceAll("\\", "/");
      }
    }

    if (homeDir) {
      const homeRelative = path.relative(homeDir, normalizedPath);
      if (homeRelative === "") {
        return "~";
      }
      if (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative)) {
        return `~/${homeRelative.replaceAll("\\", "/")}`;
      }
    }

    return normalizedPath.replaceAll("\\", "/");
  };

  const resetSession = (cwd: string) => {
    currentCwd = resolvePath(cwd, process.cwd());
    sessionRoot = findGitRoot(currentCwd);
    homeDir = resolvePath(os.homedir(), process.cwd());
    loadedAgents.clear();

    let dir = currentCwd;
    while (isInsideRoot(sessionRoot, dir)) {
      const agentsPath = path.join(dir, "AGENTS.md");
      if (fs.existsSync(agentsPath)) {
        loadedAgents.add(path.normalize(agentsPath));
      }

      if (dir === sessionRoot) {
        break;
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }

    const cwdAgentsPath = getAgentsFileFromDir(currentCwd);
    if (cwdAgentsPath) {
      loadedAgents.add(path.normalize(cwdAgentsPath));
    }
  };

  const findAgentsFiles = (filePath: string, rootDir: string): string[] => {
    if (!rootDir) {
      return [];
    }

    const agentsFiles: string[] = [];
    let dir = path.dirname(filePath);

    while (isInsideRoot(rootDir, dir)) {
      const candidate = getAgentsFileFromDir(dir);
      if (candidate) {
        agentsFiles.push(candidate);
      }

      if (dir === rootDir) {
        break;
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }

    return agentsFiles.reverse();
  };

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    resetSession(ctx.cwd);
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (event.toolName !== "read" || event.isError) {
      return undefined;
    }

    const pathInput = typeof event.input?.path === "string" ? event.input.path : undefined;
    if (!pathInput) {
      return undefined;
    }

    if (!currentCwd) {
      resetSession(ctx.cwd);
    }

    const absolutePath = resolvePath(pathInput, currentCwd);

    if (findContainingSkillDir(absolutePath) && !isInsideRoot(currentCwd, absolutePath)) {
      return undefined;
    }

    const searchRoot = isInsideRoot(sessionRoot, absolutePath) ? sessionRoot : "";

    if (!searchRoot) {
      return undefined;
    }

    if (AGENTS_FILENAMES.includes(path.basename(absolutePath))) {
      loadedAgents.add(path.normalize(absolutePath));
      return undefined;
    }

    const additions: TextContent[] = [];

    for (const agentsPath of findAgentsFiles(absolutePath, searchRoot)) {
      const normalizedPath = path.normalize(agentsPath);
      if (loadedAgents.has(normalizedPath)) {
        continue;
      }

      try {
        const content = await fs.promises.readFile(agentsPath, "utf8");
        const lineCount = countLines(content);
        loadedAgents.add(normalizedPath);
        additions.push({
          type: "text",
          text: `Loaded subdirectory context from ${agentsPath}\n\n${content}`,
        });

        if (ctx.hasUI) {
          ctx.ui.notify(
            `Loaded ${formatAgentsPath(agentsPath)} into context (${lineCount} ${lineCount === 1 ? "line" : "lines"})`,
            "info",
          );
        }
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Failed to load ${agentsPath}: ${String(error)}`, "warning");
        }
      }
    }

    if (additions.length === 0) {
      return undefined;
    }

    return {
      content: [...(event.content ?? []), ...additions],
      details: event.details,
    };
  });
}
