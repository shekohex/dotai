import { createTwoFilesPatch, diffLines } from "diff";
import { ToolExecutionComponent, keyHint, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyPatchTool } from "../src/extensions/patch.js";
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
  const bashDefinition = createBashToolOverrideDefinition();
  const batchReadDefinition = createReadBatchPreviewDefinition(cwd);

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
