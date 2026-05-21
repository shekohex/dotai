import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const TOOL_BASH = new Set(["bash", "shell", "sh", "zsh", "fish"]);
const TOOL_READ = new Set(["read", "open"]);
const TOOL_WRITE = new Set(["write"]);
const TOOL_EDIT = new Set(["edit"]);
const TOOL_PATCH = new Set(["apply_patch", "patch"]);
const TOOL_SEARCH = new Set(["grep", "rg"]);
const TOOL_DISCOVER = new Set(["find", "glob"]);
const TOOL_LIST = new Set(["ls"]);
const TOOL_WEB_SEARCH = new Set(["websearch", "web_search"]);
const TOOL_WEB_FETCH = new Set(["webfetch", "web_fetch", "firecrawl"]);
const BASH_SEARCH_COMMANDS = new Set(["rg", "grep", "ag", "ack"]);
const BASH_EXPLORE_COMMANDS = new Set(["find", "fd", "ls", "tree", "pwd"]);
const BASH_READ_COMMANDS = new Set(["cat", "bat", "less", "head", "tail", "sed", "awk"]);
const BASH_TEST_COMMANDS = new Set(["test", "vitest", "jest", "mocha", "pytest", "go", "cargo"]);
const BASH_BUILD_COMMANDS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "gradle",
  "gradlew",
  "make",
  "cmake",
]);
const BASH_INSTALL_COMMANDS = new Set(["install", "add", "ci"]);

const ToolArgsSchema = Type.Object(
  {
    file_path: Type.Optional(Type.String()),
    filePath: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    filename: Type.Optional(Type.String()),
    content: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    new_string: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const ToolResultObjectSchema = Type.Object(
  {
    text: Type.Optional(Type.String()),
    content: Type.Optional(Type.String()),
    stdout: Type.Optional(Type.String()),
    output: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const InterviewToolUpdateSchema = Type.Object(
  {
    details: Type.Object(
      {
        status: Type.Literal("queued"),
        url: Type.String(),
        title: Type.Optional(Type.String()),
        totalQuestions: Type.Optional(Type.Number()),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

type ToolArgs = Static<typeof ToolArgsSchema>;
type ToolResultObject = Static<typeof ToolResultObjectSchema>;
type InterviewToolUpdate = Static<typeof InterviewToolUpdateSchema>;
type ToolProgressText = { running: string; complete: string };
type BashActivity = "bash" | "git" | "reading" | "searching";
export type ToolTitleActivity =
  | "bash"
  | "editing"
  | "git"
  | "reading"
  | "searching"
  | "web"
  | "subagent"
  | "running";

const basename = (value: string): string => {
  const normalized = value.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
};

const countLines = (value: string): number => value.split(/\r?\n/u).length;

const parseToolArgs = (value: unknown): ToolArgs | undefined =>
  Value.Check(ToolArgsSchema, value) ? Value.Parse(ToolArgsSchema, value) : undefined;

const parseToolResult = (value: unknown): string | ToolResultObject | undefined => {
  if (typeof value === "string") return value;
  return Value.Check(ToolResultObjectSchema, value)
    ? Value.Parse(ToolResultObjectSchema, value)
    : undefined;
};

const readPath = (args: ToolArgs | undefined): string | undefined =>
  args?.file_path ?? args?.filePath ?? args?.path ?? args?.filename;

const readTextInput = (args: ToolArgs | undefined): string | undefined =>
  args?.content ?? args?.text ?? args?.new_string;

const readResultText = (value: unknown): string | undefined => {
  const result = parseToolResult(value);
  if (typeof result === "string") return result;
  return result?.text ?? result?.content ?? result?.stdout ?? result?.output;
};

const patchFileCount = (args: ToolArgs | undefined, result?: unknown): number | undefined => {
  const text = readTextInput(args) ?? readResultText(result);
  const matches = text?.match(/^(?:\+\+\+|---|\*\*\* (?:Update|Add|Delete) File:)\s+/gmu);
  if (matches === undefined || matches === null) return undefined;
  return Math.max(1, Math.ceil(matches.length / 2));
};

const firstShellCommand = (command: string | undefined): string | undefined => {
  const firstLine = command
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  const token = firstLine?.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/iu, "").match(/^[\w./-]+/u)?.[0];
  return token === undefined ? undefined : basename(token).replace(/^\./u, "").toLowerCase();
};

const gitSubcommand = (command: string | undefined): string | undefined =>
  command
    ?.trim()
    .match(/^git\s+([a-z][a-z-]*)\b/iu)?.[1]
    ?.toLowerCase();

const bashActivity = (args: ToolArgs | undefined): BashActivity => {
  const command = args?.command;
  const executable = firstShellCommand(command);
  if (executable === "git") return "git";
  if (executable !== undefined && BASH_READ_COMMANDS.has(executable)) return "reading";
  if (executable !== undefined && BASH_SEARCH_COMMANDS.has(executable)) return "searching";
  if (executable !== undefined && BASH_EXPLORE_COMMANDS.has(executable)) return "searching";
  return "bash";
};

const bashProgress = (args: ToolArgs | undefined): ToolProgressText => {
  const command = args?.command;
  const executable = firstShellCommand(command);
  const gitAction = gitSubcommand(command);
  if (executable === "git") {
    if (gitAction === "commit")
      return { running: "Committing changes", complete: "Git commit finished" };
    if (gitAction === "push") return { running: "Pushing changes", complete: "Git push finished" };
    if (gitAction === "pull" || gitAction === "fetch")
      return { running: "Fetching changes", complete: "Git fetch finished" };
    if (
      gitAction === "status" ||
      gitAction === "diff" ||
      gitAction === "log" ||
      gitAction === "show"
    )
      return { running: "Inspecting git state", complete: "Git inspection finished" };
    return { running: "Running git command", complete: "Git command finished" };
  }
  if (executable !== undefined && BASH_SEARCH_COMMANDS.has(executable))
    return { running: "Searching files", complete: "Search finished" };
  if (executable !== undefined && BASH_EXPLORE_COMMANDS.has(executable))
    return { running: "Exploring files", complete: "Exploration finished" };
  if (executable !== undefined && BASH_READ_COMMANDS.has(executable))
    return { running: "Reading output", complete: "Read command finished" };
  if (executable !== undefined && BASH_TEST_COMMANDS.has(executable))
    return { running: "Running tests", complete: "Tests finished" };
  if (executable !== undefined && BASH_BUILD_COMMANDS.has(executable)) {
    const lowerCommand = command?.toLowerCase() ?? "";
    if (BASH_INSTALL_COMMANDS.has(executable) || /\b(?:install|add|ci)\b/u.test(lowerCommand))
      return { running: "Installing dependencies", complete: "Install finished" };
    if (/\b(?:test|check)\w*/u.test(lowerCommand))
      return { running: "Running tests", complete: "Tests finished" };
    if (/\b(?:build|assemble|compile)\w*/u.test(lowerCommand))
      return { running: "Building project", complete: "Build finished" };
  }
  return { running: "Bashing", complete: "Shell command finished" };
};

const staticProgress = (running: string, complete: string): ToolProgressText => ({
  running,
  complete,
});

const toolProgressText = (
  toolName: string,
  args: ToolArgs | undefined,
): ToolProgressText | undefined => {
  const lowerName = toolName.toLowerCase();
  if (TOOL_BASH.has(lowerName)) return bashProgress(args);
  if (TOOL_WEB_SEARCH.has(lowerName)) return staticProgress("Searching web", "Web search complete");
  if (TOOL_WEB_FETCH.has(lowerName)) return staticProgress("Fetching page", "Fetched page");
  if (lowerName === "execute") return staticProgress("Executing tool code", "Tool code finished");
  if (lowerName === "resume") return staticProgress("Resuming executor", "Executor resumed");
  if (lowerName === "subagent")
    return staticProgress("Working with subagent", "Subagent task finished");
  if (lowerName === "interview") return staticProgress("Preparing interview", "Interview ready");
  if (lowerName === "goal") return staticProgress("Updating goal", "Goal updated");
  if (lowerName === "notify") return staticProgress("Sending notification", "Notification sent");
  if (lowerName === "generate_image") return staticProgress("Generating image", "Image generated");
  if (lowerName === "session_query")
    return staticProgress("Querying session", "Session query finished");
  if (lowerName === "submit_plan") return staticProgress("Submitting plan", "Plan submitted");
  return undefined;
};

export const toolLabel = (toolName: string, args: unknown): string | undefined => {
  const parsedArgs = parseToolArgs(args);
  const lowerName = toolName.toLowerCase();
  const fileName =
    readPath(parsedArgs) === undefined ? undefined : basename(readPath(parsedArgs) ?? "");
  if (TOOL_READ.has(lowerName))
    return fileName === undefined ? "Reading file" : `Reading ${fileName}`;
  if (TOOL_WRITE.has(lowerName))
    return fileName === undefined ? "Writing file" : `Writing ${fileName}`;
  if (TOOL_EDIT.has(lowerName))
    return fileName === undefined ? "Editing file" : `Editing ${fileName}`;
  if (TOOL_PATCH.has(lowerName)) return "Patching files";
  if (TOOL_SEARCH.has(lowerName)) return "Searching text";
  if (TOOL_DISCOVER.has(lowerName)) return "Finding files";
  if (TOOL_LIST.has(lowerName)) return "Listing files";
  return toolProgressText(toolName, parsedArgs)?.running;
};

export const toolTitleActivity = (toolName: string, args: unknown): ToolTitleActivity => {
  const parsedArgs = parseToolArgs(args);
  const lowerName = toolName.toLowerCase();
  if (TOOL_WRITE.has(lowerName) || TOOL_EDIT.has(lowerName) || TOOL_PATCH.has(lowerName)) {
    return "editing";
  }
  if (TOOL_READ.has(lowerName)) return "reading";
  if (TOOL_SEARCH.has(lowerName) || TOOL_DISCOVER.has(lowerName) || TOOL_LIST.has(lowerName)) {
    return "searching";
  }
  if (TOOL_WEB_SEARCH.has(lowerName) || TOOL_WEB_FETCH.has(lowerName)) return "web";
  if (lowerName === "subagent") return "subagent";
  if (TOOL_BASH.has(lowerName)) return bashActivity(parsedArgs);
  return "running";
};

export const toolSummary = (
  toolName: string,
  args: unknown,
  result: unknown,
): string | undefined => {
  const parsedArgs = parseToolArgs(args);
  const lowerName = toolName.toLowerCase();
  const fileName =
    readPath(parsedArgs) === undefined ? undefined : basename(readPath(parsedArgs) ?? "");
  const resultText = readResultText(result);
  const inputText = readTextInput(parsedArgs);
  if (TOOL_READ.has(lowerName)) {
    const lines = resultText === undefined ? undefined : countLines(resultText);
    if (fileName === undefined)
      return lines === undefined ? "Read file" : `Read file (${lines} lines)`;
    return lines === undefined ? `Read ${fileName}` : `Read ${fileName} (${lines} lines)`;
  }
  if (TOOL_WRITE.has(lowerName)) {
    const lines = inputText === undefined ? undefined : countLines(inputText);
    if (fileName === undefined) return lines === undefined ? "Wrote file" : `Wrote ${lines} lines`;
    return lines === undefined ? `Wrote ${fileName}` : `Wrote ${lines} lines to ${fileName}`;
  }
  if (TOOL_EDIT.has(lowerName))
    return fileName === undefined ? "Edited file" : `Edited ${fileName}`;
  if (TOOL_PATCH.has(lowerName)) {
    const files = patchFileCount(parsedArgs, result);
    return files === undefined ? "Patched files" : `Patched ${files} file${files === 1 ? "" : "s"}`;
  }
  if (TOOL_SEARCH.has(lowerName) || TOOL_DISCOVER.has(lowerName) || TOOL_LIST.has(lowerName)) {
    const lines = resultText === undefined ? undefined : countLines(resultText);
    return lines === undefined
      ? "Explored files"
      : `Found ${lines} result${lines === 1 ? "" : "s"}`;
  }
  return toolProgressText(toolName, parsedArgs)?.complete;
};

export const isHttpUrl = (value: string): boolean =>
  value.startsWith("http://") || value.startsWith("https://");

export const interviewDetailsFromResult = (
  value: unknown,
): { url: string; title: string; totalQuestions: number | undefined } | undefined => {
  if (!Value.Check(InterviewToolUpdateSchema, value)) return undefined;
  const update: InterviewToolUpdate = Value.Parse(InterviewToolUpdateSchema, value);
  if (!isHttpUrl(update.details.url)) return undefined;
  return {
    url: update.details.url,
    title: update.details.title ?? "Interview",
    totalQuestions: update.details.totalQuestions,
  };
};
