import { createTwoFilesPatch, diffLines } from "diff";
import { ToolExecutionComponent, keyHint, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyPatchTool } from "../src/extensions/patch.js";
import { webFetchTool } from "../src/extensions/fetch.js";
import { sessionQueryTool } from "../src/extensions/session-query.js";
import { webSearchTool } from "../src/extensions/websearch.js";
import {
  createBashToolOverrideDefinition,
  createEditToolOverrideDefinition,
  createReadToolOverrideDefinition,
  createWriteToolOverrideDefinition,
} from "../src/extensions/coreui/tools.js";
import { shortenPathForTool } from "../src/extensions/coreui/path.js";

type ToolResultContent = Array<{ type: string; text?: string }>;

export type ToolPreviewResult = {
  content: ToolResultContent;
  details?: unknown;
};

export type ToolPreviewAnimation = {
  frameDurationMs: number;
  partialFrames: ToolPreviewResult[];
};

export type ToolPreviewScenario = {
  id: string;
  title: string;
  toolName: string;
  toolDefinition: ToolDefinition<any, any>;
  args: Record<string, unknown>;
  cwd: string;
  argsComplete?: boolean;
  successResult?: ToolPreviewResult;
  partialResult?: ToolPreviewResult;
  errorResult?: ToolPreviewResult;
  previewAnimation?: ToolPreviewAnimation;
};

export type ToolPreviewPanel = {
  id: string;
  label: string;
  expanded: boolean;
  result?: ToolPreviewResult;
  isPartial?: boolean;
  isError?: boolean;
};

type PreviewTui = {
  requestRender(): void;
};

const fakeTui: PreviewTui = {
  requestRender() {},
};

const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;

export function getToolPreviewScenarios(cwd = process.cwd()): ToolPreviewScenario[] {
  const patchFile = joinPath(cwd, "src/extensions/patch.ts");
  const previewFile = joinPath(cwd, "src/tool-preview-demo.ts");
  const deletedFile = joinPath(cwd, "src/tool-preview-old.ts");
  const movedSourceFile = joinPath(cwd, "src/tool-preview-legacy.ts");
  const movedTargetFile = joinPath(cwd, "src/tool-preview-modern.ts");
  const readFile = joinPath(cwd, "README.md");
  const editFile = joinPath(cwd, "src/extensions/coreui/tools.ts");
  const writeFile = joinPath(cwd, "src/extensions/preview-look.ts");
  const sessionPath = joinPath(cwd, ".pi/agent/sessions/example/2026-04-10T15-42-47-701Z_0e990a27-4131-4b96-9440-9c813db0e009.jsonl");
  const bashDefinition = createBashToolOverrideDefinition();
  const batchReadDefinition = createReadBatchPreviewDefinition(cwd);
  const webSearchAnswer = [
    "Next.js 16 is the current major release, published in October 2025.",
    "The official release post highlights a stable Turbopack for builds, improved caching defaults, and React 19.2 alignment.",
    "The upgrade guide also calls out cacheComponents replacing the older ppr flag, plus continued server/client boundary improvements.",
    "Teams upgrading should review the breaking changes list and re-run production builds because build pipeline defaults changed.",
    "Official docs remain the best source for migration steps and flag-by-flag behavior.",
    "Community summaries exist, but the release blog and upgrade guide are the primary references.",
    "If you need exact migration steps, compare the release notes with the versioned upgrade guide before enabling new defaults in CI.",
  ].join("\n");
  const webSearchMarkdown = [
    webSearchAnswer,
    "",
    "## Sources",
    "- [Next.js 16](<https://nextjs.org/blog/next-16>)",
    "- [Version 16 Upgrade Guide](<https://nextjs.org/docs/app/guides/upgrading/version-16>)",
    "- [Next.js 16 docs](<https://nextjs.org/docs/app/getting-started/installation>)",
    "",
    "## Search queries",
    "- next.js 16 release date official",
    "- next.js 16 upgrade guide",
    "- next.js 16 breaking changes",
  ].join("\n");
  const webSearchText = [
    webSearchAnswer,
    "",
    "Sources:",
    "- Next.js 16 — https://nextjs.org/blog/next-16",
    "- Version 16 Upgrade Guide — https://nextjs.org/docs/app/guides/upgrading/version-16",
    "- Next.js 16 docs — https://nextjs.org/docs/app/getting-started/installation",
    "",
    "Search queries:",
    "- next.js 16 release date official",
    "- next.js 16 upgrade guide",
    "- next.js 16 breaking changes",
  ].join("\n");
  const webSearchMinimalAnswer = "Bun 1.3.0 is not released yet in this preview fixture.";

  const beforePatch = [
    "const title = \"before\";",
    "const count = 1;",
    "console.log(title, count);",
    "",
  ].join("\n");
  const afterPatch = [
    "const title = \"after\";",
    "const count = 2;",
    "console.log(title.toUpperCase(), count);",
    "",
  ].join("\n");
  const createdFile = ["export const preview = true;", ""].join("\n");
  const deletedBefore = ["export const oldPreview = false;", ""].join("\n");
  const movedBefore = ["export const legacyPreview = false;", ""].join("\n");
  const movedAfter = ["export const modernPreview = true;", ""].join("\n");

  return [
    {
      id: "apply_patch:streaming-call",
      title: "apply_patch streaming call",
      toolName: applyPatchTool.name,
      toolDefinition: applyPatchTool,
      cwd,
      argsComplete: false,
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: src/extensions/patch.ts",
          "@@ const title = \"before\";",
          "-const title = \"before\";",
          "+const title = \"after\";",
          "*** Add File: src/tool-preview-demo.ts",
          "+export const preview = true;",
        ].join("\n"),
      },
    },
    {
      id: "webfetch:compact",
      title: "webfetch compact preview",
      toolName: webFetchTool.name,
      toolDefinition: webFetchTool,
      cwd,
      args: {
        url: "https://example.com/docs/pi/fetch-preview",
        timeout: 10,
        format: "markdown",
      },
      partialResult: {
        content: [{
          type: "text",
          text: [
            "Fetch preview",
            "=============",
            "",
            "Streaming body chunk",
          ].join("\n"),
        }],
        details: {
          url: "https://example.com/docs/pi/fetch-preview",
          finalUrl: "https://example.com/docs/pi/fetch-preview",
          format: "markdown",
          status: 200,
          statusText: "OK",
          contentType: "text/html; charset=utf-8",
          bytes: 412,
          durationMs: 0,
          timeoutSeconds: 10,
          body: [
            "Fetch preview",
            "=============",
            "",
            "Streaming body chunk",
          ].join("\n"),
          isBinary: false,
        },
      },
      previewAnimation: {
        frameDurationMs: 1000,
        partialFrames: [
          {
            content: [{
              type: "text",
              text: "Fetch preview",
            }],
            details: {
              url: "https://example.com/docs/pi/fetch-preview",
              finalUrl: "https://example.com/docs/pi/fetch-preview",
              format: "markdown",
              status: 200,
              statusText: "OK",
              contentType: "text/html; charset=utf-8",
              bytes: 96,
              durationMs: 0,
              timeoutSeconds: 10,
              body: "Fetch preview",
              isBinary: false,
            },
          },
          {
            content: [{
              type: "text",
              text: [
                "Fetch preview",
                "=============",
              ].join("\n"),
            }],
            details: {
              url: "https://example.com/docs/pi/fetch-preview",
              finalUrl: "https://example.com/docs/pi/fetch-preview",
              format: "markdown",
              status: 200,
              statusText: "OK",
              contentType: "text/html; charset=utf-8",
              bytes: 224,
              durationMs: 1000,
              timeoutSeconds: 10,
              body: [
                "Fetch preview",
                "=============",
              ].join("\n"),
              isBinary: false,
            },
          },
          {
            content: [{
              type: "text",
              text: [
                "Fetch preview",
                "=============",
                "",
                "Streaming body chunk",
              ].join("\n"),
            }],
            details: {
              url: "https://example.com/docs/pi/fetch-preview",
              finalUrl: "https://example.com/docs/pi/fetch-preview",
              format: "markdown",
              status: 200,
              statusText: "OK",
              contentType: "text/html; charset=utf-8",
              bytes: 412,
              durationMs: 2000,
              timeoutSeconds: 10,
              body: [
                "Fetch preview",
                "=============",
                "",
                "Streaming body chunk",
              ].join("\n"),
              isBinary: false,
            },
          },
        ],
      },
      successResult: {
        content: [{
          type: "text",
          text: [
            "URL: https://example.com/docs/pi/fetch-preview",
            "Status: 200 OK",
            "Content-Type: text/html; charset=utf-8",
            "Bytes: 2.2KB",
            "",
            "Fetch preview",
            "=============",
            "",
            "This is the expanded preview body.",
            "",
            "[Output truncated: showing 18 of 42 lines. Full output saved to: /tmp/pi-fetch-preview.txt]",
          ].join("\n"),
        }],
        details: {
          url: "https://example.com/docs/pi/fetch-preview",
          finalUrl: "https://example.com/docs/pi/fetch-preview",
          format: "markdown",
          status: 200,
          statusText: "OK",
          contentType: "text/html; charset=utf-8",
          bytes: 2236,
          durationMs: 4000,
          timeoutSeconds: 10,
          body: [
            "Fetch preview",
            "=============",
            "",
            "This is the expanded preview body.",
            "",
            "[Output truncated: showing 18 of 42 lines. Full output saved to: /tmp/pi-fetch-preview.txt]",
          ].join("\n"),
          isBinary: false,
          truncation: {
            content: "Fetch preview\n=============",
            truncated: true,
            truncatedBy: "lines",
            totalLines: 42,
            totalBytes: 2236,
            outputLines: 18,
            outputBytes: 987,
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines: 2000,
            maxBytes: 51200,
          },
          fullOutputPath: "/tmp/pi-fetch-preview.txt",
        },
      },
      errorResult: {
        content: [{ type: "text", text: "Request timed out after 10s" }],
      },
    },
    {
      id: "websearch:grounded-answer",
      title: "websearch grounded answer",
      toolName: webSearchTool.name,
      toolDefinition: webSearchTool,
      cwd,
      args: {
        query: "When did Next.js 16 release and what changed?",
        model: "gemini-2.5-flash",
        timeoutMs: 30000,
      },
      partialResult: {
        content: [{ type: "text", text: "Next.js 16 released in October 2025." }],
        details: {
          query: "When did Next.js 16 release and what changed?",
          model: "gemini-2.5-flash",
          timeoutMs: 30000,
          durationMs: 0,
          endpoint: "",
          answer: "Next.js 16 released in October 2025.",
          markdown: "Next.js 16 released in October 2025.",
          searchQueries: [],
          sources: [],
        },
      },
      previewAnimation: {
        frameDurationMs: 1000,
        partialFrames: [
          {
            content: [{ type: "text", text: "Next.js 16 released in October 2025." }],
            details: {
              query: "When did Next.js 16 release and what changed?",
              model: "gemini-2.5-flash",
              timeoutMs: 30000,
              durationMs: 0,
              endpoint: "",
              answer: "Next.js 16 released in October 2025.",
              markdown: "Next.js 16 released in October 2025.",
              searchQueries: [],
              sources: [],
            },
          },
          {
            content: [{ type: "text", text: [
              "Next.js 16 released in October 2025.",
              "The release stabilized Turbopack builds.",
            ].join("\n") }],
            details: {
              query: "When did Next.js 16 release and what changed?",
              model: "gemini-2.5-flash",
              timeoutMs: 30000,
              durationMs: 1000,
              endpoint: "",
              answer: [
                "Next.js 16 released in October 2025.",
                "The release stabilized Turbopack builds.",
              ].join("\n"),
              markdown: [
                "Next.js 16 released in October 2025.",
                "The release stabilized Turbopack builds.",
              ].join("\n"),
              searchQueries: [],
              sources: [],
            },
          },
          {
            content: [{ type: "text", text: [
              "Next.js 16 released in October 2025.",
              "The release stabilized Turbopack builds.",
              "The upgrade guide also replaces ppr with cacheComponents.",
              "Caching defaults changed for production builds.",
              "React 19.2 alignment is part of the release.",
              "Official upgrade docs remain the primary source.",
              "Teams should re-run production build verification.",
            ].join("\n") }],
            details: {
              query: "When did Next.js 16 release and what changed?",
              model: "gemini-2.5-flash",
              timeoutMs: 30000,
              durationMs: 2000,
              endpoint: "",
              answer: [
                "Next.js 16 released in October 2025.",
                "The release stabilized Turbopack builds.",
                "The upgrade guide also replaces ppr with cacheComponents.",
                "Caching defaults changed for production builds.",
                "React 19.2 alignment is part of the release.",
                "Official upgrade docs remain the primary source.",
                "Teams should re-run production build verification.",
              ].join("\n"),
              markdown: [
                "Next.js 16 released in October 2025.",
                "The release stabilized Turbopack builds.",
                "The upgrade guide also replaces ppr with cacheComponents.",
                "Caching defaults changed for production builds.",
                "React 19.2 alignment is part of the release.",
                "Official upgrade docs remain the primary source.",
                "Teams should re-run production build verification.",
              ].join("\n"),
              searchQueries: [],
              sources: [],
            },
          },
        ],
      },
      successResult: {
        content: [{ type: "text", text: webSearchText }],
        details: {
          query: "When did Next.js 16 release and what changed?",
          model: "gemini-2.5-flash",
          timeoutMs: 30000,
          durationMs: 5000,
          endpoint: "https://litellm.example.test/v1beta/models/gemini-2.5-flash:generateContent",
          answer: webSearchAnswer,
          markdown: webSearchMarkdown,
          searchQueries: [
            "next.js 16 release date official",
            "next.js 16 upgrade guide",
            "next.js 16 breaking changes",
          ],
          sources: [
            { title: "Next.js 16", url: "https://nextjs.org/blog/next-16" },
            { title: "Version 16 Upgrade Guide", url: "https://nextjs.org/docs/app/guides/upgrading/version-16" },
            { title: "Next.js 16 docs", url: "https://nextjs.org/docs/app/getting-started/installation" },
          ],
        },
      },
      errorResult: {
        content: [{ type: "text", text: "LiteLLM websearch failed: 503 Service Unavailable" }],
      },
    },
    {
      id: "websearch:minimal-answer",
      title: "websearch minimal answer",
      toolName: webSearchTool.name,
      toolDefinition: webSearchTool,
      cwd,
      args: {
        query: "Has Bun 1.3.0 released yet?",
        model: "gemini-2.5-flash-lite",
      },
      successResult: {
        content: [{ type: "text", text: webSearchMinimalAnswer }],
        details: {
          query: "Has Bun 1.3.0 released yet?",
          model: "gemini-2.5-flash-lite",
          timeoutMs: 30000,
          durationMs: 3000,
          endpoint: "https://litellm.example.test/v1beta/models/gemini-2.5-flash-lite:generateContent",
          answer: webSearchMinimalAnswer,
          markdown: webSearchMinimalAnswer,
          searchQueries: [],
          sources: [],
        },
      },
      errorResult: {
        content: [{ type: "text", text: "LiteLLM API key not configured." }],
      },
    },
    {
      id: "session_query:compact",
      title: "session_query compact preview",
      toolName: sessionQueryTool.name,
      toolDefinition: sessionQueryTool,
      cwd,
      args: {
        sessionPath,
        question: "What files were modified in the parent session?",
      },
      partialResult: {
        content: [{
          type: "text",
          text: [
            "Modified files included src/extensions/coreui/tools.ts and src/extensions/patch.ts.",
            "The tests in test/tool-preview.test.ts were updated too.",
          ].join("\n"),
        }],
        details: {
          sessionPath,
          sessionUuid: "0e990a27",
          question: "What files were modified in the parent session?",
          messageCount: 42,
          answer: [
            "Modified files included src/extensions/coreui/tools.ts and src/extensions/patch.ts.",
            "The tests in test/tool-preview.test.ts were updated too.",
          ].join("\n"),
        },
      },
      previewAnimation: {
        frameDurationMs: 1000,
        partialFrames: [
          {
            content: [{
              type: "text",
              text: "Modified files included src/extensions/coreui/tools.ts and src/extensions/patch.ts.",
            }],
            details: {
              sessionPath,
              sessionUuid: "0e990a27",
              question: "What files were modified in the parent session?",
              messageCount: 42,
              answer: "Modified files included src/extensions/coreui/tools.ts and src/extensions/patch.ts.",
            },
          },
          {
            content: [{
              type: "text",
              text: [
                "Modified files included src/extensions/coreui/tools.ts and src/extensions/patch.ts.",
                "The tests in test/tool-preview.test.ts were updated too.",
              ].join("\n"),
            }],
            details: {
              sessionPath,
              sessionUuid: "0e990a27",
              question: "What files were modified in the parent session?",
              messageCount: 42,
              answer: [
                "Modified files included src/extensions/coreui/tools.ts and src/extensions/patch.ts.",
                "The tests in test/tool-preview.test.ts were updated too.",
              ].join("\n"),
            },
          },
        ],
      },
      successResult: {
        content: [{
          type: "text",
          text: "Modified files included src/extensions/coreui/tools.ts, src/extensions/patch.ts, and test/tool-preview.test.ts.",
        }],
        details: {
          sessionPath,
          sessionUuid: "0e990a27",
          question: "What files were modified in the parent session?",
          messageCount: 42,
          answer: "Modified files included src/extensions/coreui/tools.ts, src/extensions/patch.ts, and test/tool-preview.test.ts.",
        },
      },
      errorResult: {
        content: [{ type: "text", text: "Session file not found" }],
      },
    },
    {
      id: "apply_patch:single-file",
      title: "apply_patch single-file patch",
      toolName: applyPatchTool.name,
      toolDefinition: applyPatchTool,
      cwd,
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: src/extensions/patch.ts",
          "@@ const title = \"before\";",
          "-const title = \"before\";",
          "+const title = \"after\";",
          "*** End Patch",
        ].join("\n"),
      },
      successResult: {
        content: [{ type: "text", text: "Success. Updated the following files:\nM src/extensions/patch.ts" }],
        details: {
          diff: createPatchDiff(patchFile, beforePatch, afterPatch),
          files: [
            createPatchFileDetails({
              filePath: patchFile,
              relativePath: "src/extensions/patch.ts",
              type: "update",
              before: beforePatch,
              after: afterPatch,
            }),
          ],
          targets: [{ relativePath: "src/extensions/patch.ts", type: "update" }],
          totalFiles: 1,
          completedFiles: 1,
        },
      },
      partialResult: {
        content: [{ type: "text", text: "Patching 0/1 files" }],
        details: {
          files: [],
          targets: [{ relativePath: "src/extensions/patch.ts", type: "update" }],
          totalFiles: 1,
          completedFiles: 0,
        },
      },
      previewAnimation: {
        frameDurationMs: 1200,
        partialFrames: [
          {
            content: [{ type: "text", text: "Patching 0/1 files" }],
            details: {
              files: [],
              targets: [{ relativePath: "src/extensions/patch.ts", type: "update" }],
              totalFiles: 1,
              completedFiles: 0,
            },
          },
          {
            content: [{ type: "text", text: "Patching 1/1 files" }],
            details: {
              files: [
                createPatchFileDetails({
                  filePath: patchFile,
                  relativePath: "src/extensions/patch.ts",
                  type: "update",
                  before: beforePatch,
                  after: afterPatch,
                }),
              ],
              targets: [{ relativePath: "src/extensions/patch.ts", type: "update" }],
              totalFiles: 1,
              completedFiles: 1,
            },
          },
        ],
      },
      errorResult: {
        content: [{ type: "text", text: "apply_patch verification failed: no hunks found" }],
      },
    },
    {
      id: "apply_patch:multi-file",
      title: "apply_patch multi-file patch",
      toolName: applyPatchTool.name,
      toolDefinition: applyPatchTool,
      cwd,
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: src/extensions/patch.ts",
          "@@ const title = \"before\";",
          "-const title = \"before\";",
          "+const title = \"after\";",
          "*** Add File: src/tool-preview-demo.ts",
          "+export const preview = true;",
          "*** Delete File: src/tool-preview-old.ts",
          "*** Update File: src/tool-preview-legacy.ts",
          "*** Move to: src/tool-preview-modern.ts",
          "@@ export const legacyPreview = false;",
          "-export const legacyPreview = false;",
          "+export const modernPreview = true;",
          "*** End Patch",
        ].join("\n"),
      },
      successResult: {
        content: [
          {
            type: "text",
            text: [
              "Success. Updated the following files:",
              "M src/extensions/patch.ts",
              "A src/tool-preview-demo.ts",
              "D src/tool-preview-old.ts",
              "M src/tool-preview-modern.ts",
            ].join("\n"),
          },
        ],
        details: {
          diff: [
            createPatchDiff(patchFile, beforePatch, afterPatch),
            createPatchDiff(previewFile, "", createdFile),
            createPatchDiff(deletedFile, deletedBefore, ""),
            createPatchDiff(movedSourceFile, movedBefore, movedAfter),
          ].join("\n"),
          files: [
            createPatchFileDetails({
              filePath: patchFile,
              relativePath: "src/extensions/patch.ts",
              type: "update",
              before: beforePatch,
              after: afterPatch,
            }),
            createPatchFileDetails({
              filePath: previewFile,
              relativePath: "src/tool-preview-demo.ts",
              type: "add",
              before: "",
              after: createdFile,
            }),
            createPatchFileDetails({
              filePath: deletedFile,
              relativePath: "src/tool-preview-old.ts",
              type: "delete",
              before: deletedBefore,
              after: "",
            }),
            createPatchFileDetails({
              filePath: movedSourceFile,
              relativePath: "src/tool-preview-modern.ts",
              type: "move",
              before: movedBefore,
              after: movedAfter,
              movePath: movedTargetFile,
            }),
          ],
          targets: [
            { relativePath: "src/extensions/patch.ts", type: "update" },
            { relativePath: "src/tool-preview-demo.ts", type: "add" },
            { relativePath: "src/tool-preview-old.ts", type: "delete" },
            { relativePath: "src/tool-preview-modern.ts", type: "move", sourcePath: "src/tool-preview-legacy.ts" },
          ],
          totalFiles: 4,
          completedFiles: 4,
        },
      },
      partialResult: {
        content: [{ type: "text", text: "Patching 2/4 files" }],
        details: {
          files: [
            createPatchFileDetails({
              filePath: patchFile,
              relativePath: "src/extensions/patch.ts",
              type: "update",
              before: beforePatch,
              after: afterPatch,
            }),
            createPatchFileDetails({
              filePath: previewFile,
              relativePath: "src/tool-preview-demo.ts",
              type: "add",
              before: "",
              after: createdFile,
            }),
          ],
          targets: [
            { relativePath: "src/extensions/patch.ts", type: "update" },
            { relativePath: "src/tool-preview-demo.ts", type: "add" },
            { relativePath: "src/tool-preview-old.ts", type: "delete" },
            { relativePath: "src/tool-preview-modern.ts", type: "move", sourcePath: "src/tool-preview-legacy.ts" },
          ],
          totalFiles: 4,
          completedFiles: 2,
        },
      },
      previewAnimation: {
        frameDurationMs: 1200,
        partialFrames: [
          {
            content: [{ type: "text", text: "Patching 0/4 files" }],
            details: {
              files: [],
              targets: [
                { relativePath: "src/extensions/patch.ts", type: "update" },
                { relativePath: "src/tool-preview-demo.ts", type: "add" },
                { relativePath: "src/tool-preview-old.ts", type: "delete" },
                { relativePath: "src/tool-preview-modern.ts", type: "move", sourcePath: "src/tool-preview-legacy.ts" },
              ],
              totalFiles: 4,
              completedFiles: 0,
            },
          },
          {
            content: [{ type: "text", text: "Patching 1/4 files" }],
            details: {
              files: [
                createPatchFileDetails({
                  filePath: patchFile,
                  relativePath: "src/extensions/patch.ts",
                  type: "update",
                  before: beforePatch,
                  after: afterPatch,
                }),
              ],
              targets: [
                { relativePath: "src/extensions/patch.ts", type: "update" },
                { relativePath: "src/tool-preview-demo.ts", type: "add" },
                { relativePath: "src/tool-preview-old.ts", type: "delete" },
                { relativePath: "src/tool-preview-modern.ts", type: "move", sourcePath: "src/tool-preview-legacy.ts" },
              ],
              totalFiles: 4,
              completedFiles: 1,
            },
          },
          {
            content: [{ type: "text", text: "Patching 2/4 files" }],
            details: {
              files: [
                createPatchFileDetails({
                  filePath: patchFile,
                  relativePath: "src/extensions/patch.ts",
                  type: "update",
                  before: beforePatch,
                  after: afterPatch,
                }),
                createPatchFileDetails({
                  filePath: previewFile,
                  relativePath: "src/tool-preview-demo.ts",
                  type: "add",
                  before: "",
                  after: createdFile,
                }),
              ],
              targets: [
                { relativePath: "src/extensions/patch.ts", type: "update" },
                { relativePath: "src/tool-preview-demo.ts", type: "add" },
                { relativePath: "src/tool-preview-old.ts", type: "delete" },
                { relativePath: "src/tool-preview-modern.ts", type: "move", sourcePath: "src/tool-preview-legacy.ts" },
              ],
              totalFiles: 4,
              completedFiles: 2,
            },
          },
          {
            content: [{ type: "text", text: "Patching 3/4 files" }],
            details: {
              files: [
                createPatchFileDetails({
                  filePath: patchFile,
                  relativePath: "src/extensions/patch.ts",
                  type: "update",
                  before: beforePatch,
                  after: afterPatch,
                }),
                createPatchFileDetails({
                  filePath: previewFile,
                  relativePath: "src/tool-preview-demo.ts",
                  type: "add",
                  before: "",
                  after: createdFile,
                }),
                createPatchFileDetails({
                  filePath: deletedFile,
                  relativePath: "src/tool-preview-old.ts",
                  type: "delete",
                  before: deletedBefore,
                  after: "",
                }),
              ],
              targets: [
                { relativePath: "src/extensions/patch.ts", type: "update" },
                { relativePath: "src/tool-preview-demo.ts", type: "add" },
                { relativePath: "src/tool-preview-old.ts", type: "delete" },
                { relativePath: "src/tool-preview-modern.ts", type: "move", sourcePath: "src/tool-preview-legacy.ts" },
              ],
              totalFiles: 4,
              completedFiles: 3,
            },
          },
        ],
      },
      errorResult: {
        content: [{ type: "text", text: "patch rejected: empty patch" }],
      },
    },
    {
      id: "bash:compact",
      title: "core UI compact bash",
      toolName: bashDefinition.name,
      toolDefinition: bashDefinition,
      cwd,
      args: {
        command: "npm run test:tool-preview",
        description: "Runs tool preview tests",
        timeout: 120,
      },
      partialResult: {
        content: [{ type: "text", text: "\n> @shekohex/agent@0.65.2 test:tool-preview\n> node --import tsx --test ./test/tool-preview.test.ts\n" }],
      },
      previewAnimation: {
        frameDurationMs: 1000,
        partialFrames: [
          {
            content: [{ type: "text", text: "> @shekohex/agent@0.65.2 test:tool-preview" }],
          },
          {
            content: [{ type: "text", text: [
              "> @shekohex/agent@0.65.2 test:tool-preview",
              "> node --import tsx --test ./test/tool-preview.test.ts",
            ].join("\n") }],
          },
          {
            content: [{ type: "text", text: [
              "> @shekohex/agent@0.65.2 test:tool-preview",
              "> node --import tsx --test ./test/tool-preview.test.ts",
              "",
              "✔ apply_patch preview renders collapsed and expanded states",
            ].join("\n") }],
          },
          {
            content: [{ type: "text", text: [
              "> @shekohex/agent@0.65.2 test:tool-preview",
              "> node --import tsx --test ./test/tool-preview.test.ts",
              "",
              "✔ apply_patch preview renders collapsed and expanded states",
              "✔ all preview scenarios render within width 120",
            ].join("\n") }],
          },
        ],
      },
      successResult: {
        content: [
          {
            type: "text",
            text: [
              "> @shekohex/agent@0.65.2 test:tool-preview",
              "> node --import tsx --test ./test/tool-preview.test.ts",
              "",
              "✔ apply_patch preview renders collapsed and expanded states",
              "✔ all preview scenarios render within width 120",
              "exit code: 0",
            ].join("\n"),
          },
        ],
        details: {
          durationMs: 2000,
        },
      },
      errorResult: {
        content: [
          {
            type: "text",
            text: [
              "stderr: preview command failed",
              "at runPreview (/tmp/tool-preview.ts:12:3)",
              "at main (/tmp/tool-preview.ts:32:1)",
              "bash: preview command failed",
              "exit code: 1",
            ].join("\n"),
          },
        ],
        details: {
          durationMs: 2000,
        },
      },
    },
    {
      id: "bash:multiline-call",
      title: "core UI multiline bash call",
      toolName: bashDefinition.name,
      toolDefinition: bashDefinition,
      cwd,
      args: {
        command: [
          "node --import tsx - <<'EOF'",
          "import { readFile } from 'node:fs/promises';",
          "const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];",
          "for (const file of files) {",
          "  console.log(file);",
          "}",
          "console.log(await readFile('package.json', 'utf8'));",
          "EOF",
        ].join("\n"),
        description: "Reads package.json using multiline script",
        timeout: 120,
      },
      partialResult: {
        content: [{ type: "text", text: "src/a.ts\nsrc/b.ts\nsrc/c.ts" }],
      },
      successResult: {
        content: [{ type: "text", text: "src/a.ts\nsrc/b.ts\nsrc/c.ts\nexit code: 0" }],
      },
      errorResult: {
        content: [
          {
            type: "text",
            text: [
              "stderr: " + "x".repeat(220),
              "exit code: 1",
            ].join("\n"),
          },
        ],
      },
    },
    {
      id: "read:compact",
      title: "core UI compact read",
      toolName: "read",
      toolDefinition: createReadToolOverrideDefinition(),
      cwd,
      args: { path: readFile, offset: 20, limit: 40 },
      successResult: {
        content: [
          {
            type: "text",
            text: [
              "## Preview Harness",
              "",
              "Use this fixture to preview the compact read renderer.",
              "It should collapse cleanly and expand on demand.",
              "",
            ].join("\n"),
          },
        ],
      },
      partialResult: {
        content: [{ type: "text", text: "Loading preview fixture..." }],
      },
      errorResult: {
        content: [{ type: "text", text: "File not found: README.md" }],
      },
    },
    {
      id: "read:skill-file",
      title: "core UI read SKILL.md",
      toolName: "read",
      toolDefinition: createReadToolOverrideDefinition(),
      cwd,
      args: { path: joinPath(cwd, ".pi/agent/skills/git-commiting/SKILL.md") },
      successResult: {
        content: [
          {
            type: "text",
            text: [
              "# Git Commit Skill",
              "",
              "Read this skill before making git commits.",
            ].join("\n"),
          },
        ],
      },
      partialResult: {
        content: [{ type: "text", text: "Loading skill..." }],
      },
      errorResult: {
        content: [{ type: "text", text: "File not found: SKILL.md" }],
      },
    },
    {
      id: "read:batch",
      title: "grouped read batch",
      toolName: batchReadDefinition.name,
      toolDefinition: batchReadDefinition,
      cwd,
      args: {
        toolName: "read",
        noun: "reads",
        items: [
          { path: readFile, summary: "42 lines" },
          { path: editFile, summary: "18 lines" },
          { path: patchFile, summary: "27 lines" },
        ],
      },
      partialResult: {
        content: [{ type: "text", text: "reading batch" }],
        details: {
          completed: 2,
          items: [
            { path: readFile, summary: "42 lines" },
            { path: editFile, summary: "18 lines" },
            { path: patchFile, summary: "queued" },
          ],
        },
      },
      successResult: {
        content: [{ type: "text", text: "read batch complete" }],
        details: {
          completed: 3,
          items: [
            { path: readFile, summary: "42 lines" },
            { path: editFile, summary: "18 lines" },
            { path: patchFile, summary: "27 lines" },
          ],
        },
      },
      errorResult: {
        content: [{ type: "text", text: "failed to batch reads" }],
      },
    },
    {
      id: "edit:compact",
      title: "core UI compact edit",
      toolName: "edit",
      toolDefinition: createEditToolOverrideDefinition(),
      cwd,
      args: {
        path: editFile,
        edits: [{ oldText: "return new Text(\"\", 0, 0);", newText: "return new Text(\"preview\", 0, 0);" }],
      },
      successResult: {
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/extensions/coreui/tools.ts." }],
        details: {
          diff: createPatchDiff(
            editFile,
            ["return new Text(\"\", 0, 0);", ""].join("\n"),
            ["return new Text(\"preview\", 0, 0);", ""].join("\n"),
          ),
          firstChangedLine: 1,
        },
      },
      partialResult: {
        content: [{ type: "text", text: "Editing src/extensions/coreui/tools.ts..." }],
        details: {
          diff: [
            "--- src/extensions/coreui/tools.ts",
            "+++ src/extensions/coreui/tools.ts",
            "@@ -1,1 +1,1 @@",
            "-return new Text(\"\", 0, 0);",
            "+return new Text(\"preview\", 0, 0);",
          ].join("\n"),
        },
      },
      previewAnimation: {
        frameDurationMs: 1000,
        partialFrames: [
          {
            content: [{ type: "text", text: "Editing src/extensions/coreui/tools.ts..." }],
            details: {
              diff: [
                "--- src/extensions/coreui/tools.ts",
                "+++ src/extensions/coreui/tools.ts",
                "@@ -1,1 +1,1 @@",
              ].join("\n"),
            },
          },
          {
            content: [{ type: "text", text: "Editing src/extensions/coreui/tools.ts..." }],
            details: {
              diff: [
                "--- src/extensions/coreui/tools.ts",
                "+++ src/extensions/coreui/tools.ts",
                "@@ -1,1 +1,1 @@",
                "-return new Text(\"\", 0, 0);",
              ].join("\n"),
            },
          },
          {
            content: [{ type: "text", text: "Editing src/extensions/coreui/tools.ts..." }],
            details: {
              diff: [
                "--- src/extensions/coreui/tools.ts",
                "+++ src/extensions/coreui/tools.ts",
                "@@ -1,1 +1,1 @@",
                "-return new Text(\"\", 0, 0);",
                "+return new Text(\"preview\", 0, 0);",
              ].join("\n"),
            },
          },
        ],
      },
      errorResult: {
        content: [{ type: "text", text: "apply_patch verification failed: Failed to read file to update" }],
      },
    },
    {
      id: "write:compact",
      title: "core UI compact write",
      toolName: "write",
      toolDefinition: createWriteToolOverrideDefinition(),
      cwd,
      args: {
        path: writeFile,
        content: ["export const previewLook = 'compact';", ""].join("\n"),
      },
      successResult: {
        content: [{ type: "text", text: `Successfully wrote ${writeFile}` }],
      },
      partialResult: {
        content: [{ type: "text", text: [
          "export const previewLook = 'compact';",
          "export const previewMode = 'streaming';",
        ].join("\n") }],
      },
      previewAnimation: {
        frameDurationMs: 1000,
        partialFrames: [
          {
            content: [{ type: "text", text: "export const previewLook = 'compact';" }],
          },
          {
            content: [{ type: "text", text: [
              "export const previewLook = 'compact';",
              "export const previewMode = 'streaming';",
            ].join("\n") }],
          },
          {
            content: [{ type: "text", text: [
              "export const previewLook = 'compact';",
              "export const previewMode = 'streaming';",
              "export const previewTail = 5;",
              "export const previewExpanded = true;",
              "export const previewHint = 'ctrl+o';",
              "export const previewPaused = false;",
            ].join("\n") }],
          },
        ],
      },
      errorResult: {
        content: [{ type: "text", text: "Permission denied" }],
      },
    },
  ];
}

export function getToolPreviewPanels(scenario: ToolPreviewScenario): ToolPreviewPanel[] {
  const panels: ToolPreviewPanel[] = [
    { id: "call-collapsed", label: "Call · collapsed", expanded: false },
    { id: "call-expanded", label: "Call · expanded", expanded: true },
  ];

  if (scenario.partialResult) {
    panels.push(
      { id: "partial-collapsed", label: "Partial · collapsed", expanded: false, result: scenario.partialResult, isPartial: true },
      { id: "partial-expanded", label: "Partial · expanded", expanded: true, result: scenario.partialResult, isPartial: true },
    );
  }

  if (scenario.successResult) {
    panels.push(
      { id: "success-collapsed", label: "Success · collapsed", expanded: false, result: scenario.successResult },
      { id: "success-expanded", label: "Success · expanded", expanded: true, result: scenario.successResult },
    );
  }

  if (scenario.errorResult) {
    panels.push(
      { id: "error-collapsed", label: "Error · collapsed", expanded: false, result: scenario.errorResult, isError: true },
      { id: "error-expanded", label: "Error · expanded", expanded: true, result: scenario.errorResult, isError: true },
    );
  }

  return panels;
}

export function createPreviewComponent(
  scenario: ToolPreviewScenario,
  panel: ToolPreviewPanel,
  tui: PreviewTui = fakeTui,
  animationMs = 0,
) {
  const component = new ToolExecutionComponent(
    scenario.toolName,
    `${scenario.id}:${panel.id}`,
    scenario.args,
    {},
    scenario.toolDefinition,
    tui as never,
    scenario.cwd,
  );

  component.setExpanded(panel.expanded);
  component.markExecutionStarted();
  if (scenario.argsComplete !== false) {
    component.setArgsComplete();
  }

  const result = resolvePreviewResult(scenario, panel, animationMs);

  if (result?.details && typeof result.details === "object") {
    const durationMs = (result.details as { durationMs?: unknown }).durationMs;
    if (typeof durationMs === "number") {
      const rendererState = (component as unknown as { rendererState?: { startedAt?: number; endedAt?: number } }).rendererState;
      if (rendererState) {
        const now = Date.now();
        rendererState.startedAt = now - durationMs;
        if (panel.isPartial) {
          rendererState.endedAt = undefined;
        } else {
          rendererState.endedAt = now;
        }
      }
    }
  }

  if (result) {
    component.updateResult(
      {
        content: result.content,
        details: result.details,
        isError: panel.isError ?? false,
      },
      panel.isPartial ?? false,
    );
  }

  return component;
}

export function renderPreviewLines(scenario: ToolPreviewScenario, panel: ToolPreviewPanel, width = 120): string[] {
  return createPreviewComponent(scenario, panel, fakeTui, 0).render(width);
}

export function renderPreviewText(scenario: ToolPreviewScenario, panel: ToolPreviewPanel, width = 120): string {
  return renderPreviewLines(scenario, panel, width).join("\n");
}

export function assertVisibleWidths(lines: string[], width: number): void {
  for (const line of lines) {
    if (visibleWidth(line) > width) {
      throw new Error(`Visible width exceeded ${width}: ${visibleWidth(line)}`);
    }
  }
}

function createPatchDiff(filePath: string, before: string, after: string): string {
  return createTwoFilesPatch(filePath, filePath, before, after);
}

function createPatchFileDetails(input: {
  filePath: string;
  relativePath: string;
  type: "add" | "update" | "delete" | "move";
  before: string;
  after: string;
  movePath?: string;
}) {
  return {
    filePath: input.filePath,
    relativePath: input.relativePath,
    type: input.type,
    diff: createPatchDiff(input.filePath, input.before, input.after),
    before: input.before,
    after: input.after,
    additions: countDiffLines(input.before, input.after, true),
    deletions: countDiffLines(input.before, input.after, false),
    movePath: input.movePath,
  };
}

function countDiffLines(before: string, after: string, added: boolean): number {
  let count = 0;
  for (const change of diffLines(before, after)) {
    if (added && change.added) {
      count += change.count || 0;
    }
    if (!added && change.removed) {
      count += change.count || 0;
    }
  }
  return count;
}

function joinPath(cwd: string, relativePath: string): string {
  return `${cwd.replace(/\\/g, "/")}/${relativePath}`;
}

export function resolvePreviewResult(
  scenario: ToolPreviewScenario,
  panel: ToolPreviewPanel,
  animationMs = 0,
): ToolPreviewResult | undefined {
  if (!panel.isPartial || !scenario.previewAnimation || scenario.previewAnimation.partialFrames.length === 0) {
    return panel.result;
  }

  const { frameDurationMs, partialFrames } = scenario.previewAnimation;
  const frameIndex = Math.floor(animationMs / frameDurationMs) % partialFrames.length;
  return partialFrames[frameIndex] ?? panel.result;
}

function createReadBatchPreviewDefinition(cwd: string): ToolDefinition<any, any> {
  return {
    name: "read_batch_preview",
    label: "read batch",
    description: "Preview grouped read batch rendering.",
    parameters: Type.Object(
      {
        toolName: Type.String(),
        noun: Type.String(),
        items: Type.Array(
          Type.Object({
            path: Type.String(),
            summary: Type.Optional(Type.String()),
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute() {
      return { content: [] };
    },
    renderCall(args, theme, context) {
      const summary = summarizeBatchItems(args.items, args.noun, cwd);
      const status = context.isError
        ? theme.fg("error", "✗ failed to batch")
        : context.isPartial
          ? theme.fg("dim", "… batching")
          : theme.fg("muted", "✓ batched");
      return new Text(`${status} ${theme.fg("accent", summary)}`, TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
    },
    renderResult(result, options, theme, context) {
      const details = result.details as
        | {
            completed?: number;
            items?: Array<{ path: string; summary?: string }>;
          }
        | undefined;

      if (context.isError) {
        const message = result.content.find((item) => item.type === "text")?.text ?? "failed to batch";
        return new Text(theme.fg("error", `↳ ${message}`), TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
      }

      const items = details?.items ?? args.items;
      if (!options.expanded) {
        const progress = context.isPartial && typeof details?.completed === "number"
          ? `${details.completed}/${items.length} complete`
          : summarizeBatchItems(items, args.noun, cwd);
        const suffix = context.isPartial ? progress : `${progress} · ${keyHint("app.tools.expand", "expand")}`;
        return new Text(theme.fg("dim", `↳ ${suffix}`), TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
      }

      const lines = items.map((item) => {
        const label = shortenPathForTool(item.path, cwd);
        const summary = item.summary ? theme.fg("muted", ` · ${item.summary}`) : "";
        return `${theme.fg("muted", "✓ read")} ${theme.fg("accent", label)}${summary}`;
      });

      return new Text(lines.join("\n"), TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
    },
  };
}

function summarizeBatchItems(items: Array<{ path: string; summary?: string }>, noun: string, cwd: string): string {
  const labels = items.map((item) => shortenPathForTool(item.path, cwd));
  const shown = labels.slice(0, 3).join(", ");
  const remaining = labels.length - 3;
  return `${items.length} ${noun} · ${shown}${remaining > 0 ? ` +${remaining} more` : ""}`;
}
