import { readdirSync } from "node:fs";
import { join } from "node:path";

import { escapeXml } from "../../utils/xml.js";
import { loadWorkflowResource, workflowResourcesDir } from "./resource-workflows.js";
import { parseWorkflowScript } from "./workflow.js";

export interface BuiltinWorkflowDefinition {
  commandName: string;
  description: string;
  filePath: string;
  fileName: string;
  workflowName: string;
}

export function listBuiltinWorkflows(): BuiltinWorkflowDefinition[] {
  return readdirSync(workflowResourcesDir)
    .filter((fileName) => fileName.endsWith(".workflow.js"))
    .flatMap((fileName) => loadBuiltinWorkflow(fileName))
    .toSorted((left, right) => left.commandName.localeCompare(right.commandName));
}

export function listRunnableBuiltinWorkflows(): BuiltinWorkflowDefinition[] {
  return listBuiltinWorkflows().filter((workflow) => workflow.workflowName !== "goal");
}

export function formatBuiltinWorkflowsForSystemPrompt(
  workflows: BuiltinWorkflowDefinition[],
): string {
  if (workflows.length === 0) return "";
  const lines = [
    "Workflows: /wf:<name> => src/resources/workflows/dynamic/<name>.workflow.js; workflow scriptFile+args.",
    "<workflows>",
  ];

  for (const workflow of workflows) {
    lines.push(
      `  <wf n="${escapeXml(workflow.workflowName)}">${escapeXml(workflow.description)}</wf>`,
    );
  }

  lines.push("</workflows>");
  return lines.join("\n");
}

export function buildBuiltinWorkflowInvocationPrompt(
  workflow: BuiltinWorkflowDefinition,
  userContext: string,
): string {
  const context = userContext.trim() || "No additional context provided.";
  const sections = [
    `Use built-in dynamic workflow \`${workflow.commandName}\`.`,
    "",
    "<workflow_description>",
    workflow.description,
    "</workflow_description>",
    "",
    `Workflow file: \`${workflow.fileName}\``,
    "",
    "Read the workflow file before running it. Do not modify the built-in file.",
    "If customization is needed, copy it to a project/worktree path and run the copy.",
    "Build the required args from the workflow file, current conversation, repo state, and additional context below.",
    "For any task/question/context arg, write a detailed standalone prompt for the workflow. Include the actual goal, relevant files/diff/constraints/evidence, and what success should look like.",
    "Do not pass the raw additional context through unchanged unless it is already sufficiently detailed.",
    "Then call the `workflow` tool with `scriptFile` and `args`.",
    "",
    "<additional_context>",
    context,
    "</additional_context>",
  ];
  return sections.join("\n");
}

function loadBuiltinWorkflow(fileName: string): BuiltinWorkflowDefinition[] {
  const filePath = join(workflowResourcesDir, fileName);
  const script = loadWorkflowResource(fileName);
  if (script.includes("__description__") || script.includes("__perspectiveAgents__")) return [];
  try {
    const { meta } = parseWorkflowScript(script);
    const workflowName = meta.name.replaceAll("_", "-");
    return [
      {
        commandName: `wf:${workflowName}`,
        description: meta.description,
        filePath,
        fileName,
        workflowName,
      },
    ];
  } catch {
    return [];
  }
}
