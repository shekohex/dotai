import { webcrypto } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { MODE_ACTIVATE_EVENT } from "../modes/index.js";
import { errorMessage } from "../../utils/error-message.js";
import { isRecord } from "../../utils/unknown-data.js";

const OPENWIKI_MODE = "openwiki";
const OPEN_WIKI_DIR = "openwiki";
const UPDATE_METADATA_PATH = `${OPEN_WIKI_DIR}/.last-update.json`;
const GIT_COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

type OpenWikiCommand = "chat" | "init" | "update";
type OpenWikiContentSnapshot = string;

const UpdateMetadataSchema = Type.Object({
  updatedAt: Type.String(),
  command: Type.Union([Type.Literal("chat"), Type.Literal("init"), Type.Literal("update")]),
  gitHead: Type.Optional(Type.String()),
  model: Type.String(),
});

type UpdateMetadata = Static<typeof UpdateMetadataSchema>;

type RunContext = {
  lastUpdate: UpdateMetadata | null;
  gitSummary: string;
};

type PendingOpenWikiRun = {
  command: OpenWikiCommand;
  context: RunContext;
  cwd: string;
  openWikiSnapshotBefore: OpenWikiContentSnapshot | null;
  additionalInstruction: string | null;
};

type ActiveOpenWikiRun = PendingOpenWikiRun;

type ParsedOpenWikiCommand =
  | { kind: "help" }
  | { kind: "switch" }
  | { kind: "run"; command: OpenWikiCommand; additionalInstruction: string | null };

export default function openWikiExtension(pi: ExtensionAPI): void {
  let pendingRun: PendingOpenWikiRun | undefined;
  let activeRun: ActiveOpenWikiRun | undefined;
  const activeModesByCwd = new Map<string, string | undefined>();

  function resetState(): void {
    pendingRun = undefined;
    activeRun = undefined;
  }

  pi.on("session_start", resetState);
  pi.events.on("modes:changed", (data) => {
    if (!isRecord(data)) {
      return;
    }

    const cwd = data.cwd;
    if (typeof cwd !== "string") {
      return;
    }

    const mode = data.mode;
    if (typeof mode === "string") {
      activeModesByCwd.set(cwd, mode);
      return;
    }

    activeModesByCwd.set(cwd, undefined);
  });

  pi.on("input", async (event, ctx) => {
    const args = parseOpenWikiInputText(event.text);
    if (args === null) {
      return { action: "continue" };
    }

    const parsed = parseOpenWikiCommand(args);

    if (event.streamingBehavior !== undefined) {
      ctx.ui.notify("Run /openwiki when the agent is idle", "warning");
      return { action: "handled" };
    }

    if (parsed.kind === "help") {
      sendOpenWikiHelp(pi);
      return { action: "handled" };
    }

    await activateOpenWikiMode(pi, ctx);

    if (parsed.kind === "switch") {
      ctx.ui.notify("Switched to OpenWiki mode", "info");
      return { action: "handled" };
    }

    const context = await createRunContext(pi, parsed.command, ctx.cwd);
    pendingRun = {
      command: parsed.command,
      context,
      cwd: ctx.cwd,
      openWikiSnapshotBefore:
        parsed.command === "chat" ? null : await createOpenWikiContentSnapshot(ctx.cwd),
      additionalInstruction: parsed.additionalInstruction,
    };

    return { action: "transform", text: formatOpenWikiPrompt(parsed.command) };
  });

  function consumePendingRun(
    systemPrompt: string,
    ctx: ExtensionContext,
  ): { systemPrompt: string } | undefined {
    if (pendingRun === undefined || pendingRun.cwd !== ctx.cwd) {
      return undefined;
    }

    if (activeModesByCwd.get(ctx.cwd) !== OPENWIKI_MODE) {
      pendingRun = undefined;
      return undefined;
    }

    activeRun = pendingRun;
    pendingRun = undefined;

    return {
      systemPrompt: `${systemPrompt}\n\n${createDynamicSystemPrompt(activeRun)}`,
    };
  }

  pi.on("before_agent_start", (event, ctx) => {
    return consumePendingRun(event.systemPrompt, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (activeRun === undefined || activeRun.cwd !== ctx.cwd) {
      return;
    }

    const run = activeRun;
    activeRun = undefined;

    if (run.command === "chat" || run.openWikiSnapshotBefore === null) {
      return;
    }

    const openWikiSnapshotAfter = await createOpenWikiContentSnapshot(ctx.cwd);
    if (run.openWikiSnapshotBefore === openWikiSnapshotAfter) {
      return;
    }

    await writeLastUpdateMetadata(pi, run.command, ctx, getCurrentModelId(ctx));
  });
}

function parseOpenWikiInputText(text: string): string | null {
  const trimmedText = text.trim();
  if (trimmedText === "/openwiki") {
    return "";
  }

  return trimmedText.startsWith("/openwiki ") ? trimmedText.slice("/openwiki ".length) : null;
}

function parseOpenWikiCommand(args: string): ParsedOpenWikiCommand {
  const trimmedArgs = args.trim();
  if (trimmedArgs.length === 0) {
    return { kind: "switch" };
  }

  const [rawCommand = "", ...rest] = trimmedArgs.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const additionalInstruction = rest.length > 0 ? rest.join(" ") : null;

  if (command === "help") {
    return { kind: "help" };
  }

  if (command === "init" || command === "update" || command === "chat") {
    return { kind: "run", command, additionalInstruction };
  }

  return { kind: "run", command: "chat", additionalInstruction: trimmedArgs };
}

async function activateOpenWikiMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pi.events.emit(MODE_ACTIVATE_EVENT, {
      ctx,
      mode: OPENWIKI_MODE,
      reason: "apply",
      source: "command",
      done: { resolve, reject },
    });
  });
}

function sendOpenWikiHelp(pi: ExtensionAPI): void {
  pi.sendMessage(
    {
      customType: "openwiki-help",
      display: true,
      content: [
        "OpenWiki commands:",
        "- `/openwiki` switches current session to OpenWiki mode.",
        "- `/openwiki init [message]` switches mode and initializes `openwiki/` docs.",
        "- `/openwiki update [message]` switches mode and updates stale `openwiki/` docs.",
        "- `/openwiki chat <message>` switches mode and answers without editing docs unless asked.",
        "- `/mode openwiki` enters OpenWiki chat mode manually.",
      ].join("\n"),
    },
    { triggerTurn: false },
  );
}

function createDynamicSystemPrompt(run: PendingOpenWikiRun): string {
  return [
    "OpenWiki command context:",
    `- Command: ${run.command}`,
    `- Repository root: ${run.cwd}`,
    `- Additional instruction: ${formatOptionalInstruction(run.additionalInstruction)}`,
    "",
    "OpenWiki command prompt:",
    createCommandPrompt(run.command, run.context, run.additionalInstruction),
    "",
    "Runtime note:",
    "- Treat the repository root above as the only project you are documenting.",
    "- Use pi repo-relative paths: README.md means README.md and openwiki/quickstart.md means openwiki/quickstart.md.",
    "- Use pi tools: find for path discovery, grep for content search, read for file reads, write/apply_patch/edit for writes, and bash for shell commands.",
    `- Shell commands run on the host. Run commands from ${run.cwd} and keep them inside that repository.`,
    "- Do not search parent directories or unrelated repositories.",
    "",
    "Mode-specific behavior:",
    createModeInstructions(run.command),
    "",
    "Last update metadata:",
    formatLastUpdate(run.context.lastUpdate),
    "",
    "Git change summary:",
    run.context.gitSummary,
  ].join("\n");
}

function createModeInstructions(command: OpenWikiCommand): string {
  if (command === "chat") {
    return `
- This is an interactive chat turn.
- Answer the additional instruction directly.
- Do not create or update OpenWiki documentation unless the user explicitly asks you to modify documentation.
- If asked how to initialize or update the wiki, explain that pi supports \`/openwiki init\` and \`/openwiki update\`.
`.trim();
  }

  if (command === "init") {
    return `
- This is an initial documentation run.
- Assume openwiki/ does not yet contain useful documentation.
- Build the documentation structure from scratch.
- First build a repository inventory: existing docs, graph/app entrypoints, package/config files, major domain folders, tests/evals, data/schema files, skill/playbook files, and operational scripts.
- Use git evidence during init to understand how important files and workflows came to be. Prefer recent commits and targeted git blame/show on high-signal files.
- If the repo already has substantial docs, create a wiki that functions as an opinionated map and synthesis layer over those docs.
- Create openwiki/quickstart.md first, then the linked section pages.
- Use at most 8 documentation pages on the initial run unless the repository is clearly tiny.
- Do not try to document every source file. Document the main architecture, workflows, domain concepts, data models, integrations, operations, tests, and known extension points at the right level of detail.
- The pi OpenWiki extension will record successful run metadata in openwiki/.last-update.json after you finish.
`.trim();
  }

  return `
- This is a maintenance update run.
- Inspect the existing openwiki/ documentation before editing.
- Read openwiki/.last-update.json if it exists.
- Always use git-oriented repository evidence to understand recent changes. Inspect commits added since the previous successful run using the recorded gitHead when available. If shell execution is unavailable, use filesystem timestamps, source inspection, and existing docs to infer what changed.
- Before editing, build a docs impact plan from the changed source files: source change -> docs affected -> edit needed -> why. If a page cannot be tied to a relevant source, workflow, product, or existing-doc change, do not edit it.
- Update runs must be surgical. Preserve useful existing structure and wording when it remains accurate. Prefer replacing one stale sentence over adding new paragraphs.
- Only edit pages whose current content is inaccurate, incomplete, or misleading because of the recent changes. Do not refresh every page.
- Keep each concept in one canonical page. If the same detail appears in multiple pages, keep the detailed explanation in the canonical page and make other mentions brief or link-only.
- Do not make formatting-only edits. Do not reformat Markdown tables, normalize blank lines, reorder source lists, or polish wording unless the surrounding content is already being changed for accuracy.
- Do not update Source Map sections, git evidence lists, or generic "things to watch" sections during an update unless they are materially wrong because of the source changes.
- Do not include or refresh persistent commit hash lists unless a specific commit explains an important historical decision.
- Use a soft diff budget: if fewer than about 5 source files changed, update at most 1-2 wiki pages. Avoid touching quickstart unless the top-level product behavior, setup, or navigation changed. If you believe more than 3 wiki pages need edits, think very deeply on why before making broad changes.
- Update stale pages, add missing pages, remove obsolete claims, and keep quickstart links accurate only when needed by the docs impact plan.
- Updates may be a no-op. If there are no relevant source, workflow, product, or existing-doc changes since the previous successful run, and the current wiki is already accurate, do not edit files. Say that the wiki is already current.
- The pi OpenWiki extension will record successful run metadata in openwiki/.last-update.json after you finish.
`.trim();
}

function createCommandPrompt(
  command: OpenWikiCommand,
  context: RunContext,
  additionalInstruction: string | null = null,
): string {
  if (command === "chat") {
    return formatChatInstruction(additionalInstruction);
  }

  if (command === "init") {
    return appendAdditionalInstruction(
      `
Initialize OpenWiki documentation for this repository.

Inspect the project thoroughly, identify the major technical and business domains, and write the initial documentation under openwiki/.

Start with openwiki/quickstart.md as the entrypoint. Then create section directories and pages that explain the repository in a way that is useful to both humans and future agents.

Git context:
${context.gitSummary}
`.trim(),
      additionalInstruction,
    );
  }

  return appendAdditionalInstruction(
    `
Update the existing OpenWiki documentation for this repository.

Inspect openwiki/, identify recent source changes, and refresh only the documentation pages directly affected by those changes. Use the git evidence below when available. Keep edits surgical: do not rewrite accurate sections, do not update source maps or git evidence just to refresh them, and do not make formatting-only changes. If the wiki is already current, do not edit files. The pi OpenWiki extension will update openwiki/.last-update.json only when OpenWiki content changes.

Last update metadata:
${formatLastUpdate(context.lastUpdate)}

Git change summary:
${context.gitSummary}
`.trim(),
    additionalInstruction,
  );
}

function appendAdditionalInstruction(prompt: string, additionalInstruction: string | null): string {
  if (additionalInstruction === null || additionalInstruction.trim().length === 0) {
    return prompt;
  }

  return `
${prompt}

Additional instruction:
${additionalInstruction.trim()}
`.trim();
}

function formatLastUpdate(lastUpdate: UpdateMetadata | null): string {
  if (lastUpdate === null) {
    return "No previous OpenWiki update metadata was found.";
  }

  return JSON.stringify(lastUpdate, null, 2);
}

function normalizeUpdateMetadata(metadata: UpdateMetadata): UpdateMetadata {
  if (metadata.gitHead === undefined || isGitCommitSha(metadata.gitHead)) {
    return metadata;
  }

  return { ...metadata, gitHead: undefined };
}

function formatOptionalInstruction(additionalInstruction: string | null): string {
  const trimmedInstruction = additionalInstruction?.trim();
  return trimmedInstruction !== undefined && trimmedInstruction.length > 0
    ? trimmedInstruction
    : "(none)";
}

function formatChatInstruction(additionalInstruction: string | null): string {
  const trimmedInstruction = additionalInstruction?.trim();
  return trimmedInstruction !== undefined && trimmedInstruction.length > 0
    ? trimmedInstruction
    : "Start an OpenWiki chat.";
}

function formatOpenWikiPrompt(command: OpenWikiCommand): string {
  return `Run OpenWiki ${command}. Follow the OpenWiki command context injected into this turn's system prompt.`;
}

async function createRunContext(
  pi: ExtensionAPI,
  command: OpenWikiCommand,
  cwd: string,
): Promise<RunContext> {
  const lastUpdate = await readLastUpdate(cwd);

  if (command === "chat") {
    return {
      lastUpdate,
      gitSummary: "Not applicable for chat.",
    };
  }

  return {
    lastUpdate,
    gitSummary: await createGitSummary(pi, command, cwd, lastUpdate),
  };
}

async function readLastUpdate(cwd: string): Promise<UpdateMetadata | null> {
  const metadataFile = path.join(cwd, UPDATE_METADATA_PATH);

  try {
    const rawMetadata = await readFile(metadataFile, "utf8");
    const parsedMetadata: unknown = JSON.parse(rawMetadata);

    if (!Value.Check(UpdateMetadataSchema, parsedMetadata)) {
      return null;
    }

    return normalizeUpdateMetadata(Value.Parse(UpdateMetadataSchema, parsedMetadata));
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function writeLastUpdateMetadata(
  pi: ExtensionAPI,
  command: Exclude<OpenWikiCommand, "chat">,
  ctx: ExtensionContext,
  modelId: string,
): Promise<void> {
  const metadataFile = path.join(ctx.cwd, UPDATE_METADATA_PATH);
  const metadata: UpdateMetadata = {
    updatedAt: new Date().toISOString(),
    command,
    gitHead: await getGitHead(pi, ctx.cwd),
    model: modelId,
  };

  await mkdir(path.dirname(metadataFile), { recursive: true });
  await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  ctx.ui.notify(`OpenWiki metadata updated: ${UPDATE_METADATA_PATH}`, "info");
}

async function createOpenWikiContentSnapshot(cwd: string): Promise<OpenWikiContentSnapshot> {
  const openWikiDir = path.join(cwd, OPEN_WIKI_DIR);
  const chunks: Array<string | Buffer> = [];

  await addDirectoryToSnapshot(chunks, openWikiDir, "");

  return digestSnapshot(chunks);
}

async function addDirectoryToSnapshot(
  chunks: Array<string | Buffer>,
  directory: string,
  relativeDirectory: string,
): Promise<void> {
  let entries: Dirent[];

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isExpectedSnapshotRaceError(error)) {
      chunks.push("missing");
      return;
    }

    throw error;
  }

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);

    if (relativePath === path.basename(UPDATE_METADATA_PATH)) {
      continue;
    }

    if (entry.isDirectory()) {
      chunks.push(`dir:${relativePath}\0`);
      await addDirectoryToSnapshot(chunks, entryPath, relativePath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileContent = await readSnapshotFile(entryPath);
    if (fileContent === null) {
      continue;
    }

    chunks.push(`file:${relativePath}\0`, fileContent, "\0");
  }
}

async function digestSnapshot(chunks: Array<string | Buffer>): Promise<string> {
  const bytes = Buffer.concat(
    chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)),
  );
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

async function readSnapshotFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isExpectedSnapshotRaceError(error)) {
      return null;
    }

    throw error;
  }
}

async function createGitSummary(
  pi: ExtensionAPI,
  command: OpenWikiCommand,
  cwd: string,
  lastUpdate: UpdateMetadata | null,
): Promise<string> {
  const sections: string[] = [];
  const status = await runGit(pi, cwd, ["status", "--short"]);
  const head = await getGitHead(pi, cwd);

  sections.push(formatGitSection("git status --short", status));
  sections.push(formatGitSection("git rev-parse HEAD", head ?? "(unknown)"));

  const lastUpdateGitHead = lastUpdate?.gitHead;

  if (
    command === "update" &&
    lastUpdateGitHead !== undefined &&
    isGitCommitSha(lastUpdateGitHead)
  ) {
    const logSinceLastHead = await runGit(pi, cwd, [
      "log",
      `${lastUpdateGitHead}..HEAD`,
      "--name-status",
      "--oneline",
    ]);

    sections.push(
      formatGitSection(
        `git log ${lastUpdateGitHead}..HEAD --name-status --oneline`,
        logSinceLastHead,
      ),
    );
  } else if (command === "update" && hasText(lastUpdate?.updatedAt)) {
    const logSinceLastUpdate = await runGit(pi, cwd, [
      "log",
      "--since",
      lastUpdate.updatedAt,
      "--name-status",
      "--oneline",
    ]);

    sections.push(
      formatGitSection(
        `git log --since ${lastUpdate.updatedAt} --name-status --oneline`,
        logSinceLastUpdate,
      ),
    );
  } else {
    const recentLog = await runGit(pi, cwd, [
      "log",
      "--max-count=20",
      "--name-status",
      "--oneline",
    ]);

    if (command === "update") {
      sections.push("No prior OpenWiki update timestamp was found.");
    }

    sections.push(formatGitSection("git log --max-count=20 --name-status --oneline", recentLog));
  }

  const diff = await runGit(pi, cwd, ["diff", "--name-status", "HEAD"]);
  sections.push(formatGitSection("git diff --name-status HEAD", diff));

  return sections.join("\n\n");
}

async function getGitHead(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const head = await runGit(pi, cwd, ["rev-parse", "HEAD"]);
  const trimmedHead = head.trim();

  return isGitCommitSha(trimmedHead) ? trimmedHead : undefined;
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr, code } = await pi.exec("git", ["--no-pager", ...args], {
      cwd,
      timeout: 30_000,
    });
    const output = joinGitOutput(stdout, stderr);

    return code === 0 ? output : formatGitFailure(code, output);
  } catch (error) {
    return `git failed: ${errorMessage(error)}`;
  }
}

function formatGitSection(command: string, output: string): string {
  return [`$ ${command}`, output.length > 0 ? output : "(no output)"].join("\n");
}

function getCurrentModelId(ctx: ExtensionContext): string {
  if (ctx.model === undefined) {
    return "unknown";
  }

  return `${ctx.model.provider}/${ctx.model.id}`;
}

function joinGitOutput(stdout: string | undefined, stderr: string | undefined): string {
  return [stdout?.trim(), stderr?.trim()]
    .filter((output): output is string => output !== undefined && output.length > 0)
    .join("\n")
    .trim();
}

function formatGitFailure(code: number, output: string): string {
  const status = `git exited with code ${code}`;
  return output.length > 0 ? `${status}\n${output}` : status;
}

function isGitCommitSha(value: string): boolean {
  return GIT_COMMIT_SHA_PATTERN.test(value);
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function isFileNotFoundError(error: unknown): boolean {
  return readErrorCode(error) === "ENOENT";
}

function isExpectedSnapshotRaceError(error: unknown): boolean {
  const code = readErrorCode(error);
  return code !== undefined && ["EISDIR", "ENOENT", "ENOTDIR"].includes(code);
}

function readErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

export const __openWikiExtensionInternalsForTests = {
  parseOpenWikiCommand,
  createModeInstructions,
  createCommandPrompt,
  appendAdditionalInstruction,
  formatLastUpdate,
  createDynamicSystemPrompt,
  isGitCommitSha,
  getGitHead,
  parseOpenWikiInputText,
  formatOpenWikiPrompt,
};
