/** Save and load reusable workflow commands. */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { USER_WORKFLOW_SAVED_DIR, WORKFLOW_SAVED_DIR } from "./config.js";

export interface SavedWorkflow {
  /** Command name (filename without extension). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** The workflow script. */
  script: string;
  /** Optional parameter schema for parameterized workflows. */
  parameters?: Record<
    string,
    { type: string; description?: string; required?: boolean; default?: unknown }
  >;
  /** Where this workflow is saved. */
  location: "project" | "user";
  /** Full file path. */
  path: string;
  /** When it was saved. */
  savedAt: string;
}

export interface WorkflowStorage {
  /** Save a workflow. */
  save(
    workflow: Omit<SavedWorkflow, "path" | "savedAt">,
    location?: "project" | "user",
  ): SavedWorkflow;
  /** Load a workflow by name. */
  load(name: string): SavedWorkflow | null;
  /** List all saved workflows. */
  list(): SavedWorkflow[];
  /** Delete a saved workflow. */
  delete(name: string, location?: "project" | "user"): boolean;
}

const SavedWorkflowFileSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  script: Type.String(),
  parameters: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        type: Type.String(),
        description: Type.Optional(Type.String()),
        required: Type.Optional(Type.Boolean()),
        default: Type.Optional(Type.Unknown()),
      }),
    ),
  ),
  savedAt: Type.String(),
});

function parseSavedWorkflowFile(text: string): Omit<SavedWorkflow, "location" | "path"> | null {
  const parsed: unknown = JSON.parse(text);
  if (!Value.Check(SavedWorkflowFileSchema, parsed)) return null;
  return Value.Parse(SavedWorkflowFileSchema, parsed);
}

export function createWorkflowStorage(cwd: string): WorkflowStorage {
  const projectDir = join(cwd, WORKFLOW_SAVED_DIR);
  const userDir = USER_WORKFLOW_SAVED_DIR.replace("~", process.env.HOME ?? "");

  const ensureDir = (dir: string) => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  };

  const workflowPath = (name: string, location: "project" | "user") => {
    const dir = location === "project" ? projectDir : userDir;
    return join(dir, `${name}.json`);
  };

  const loadFromFile = (path: string, location: "project" | "user"): SavedWorkflow | null => {
    try {
      if (!existsSync(path)) return null;
      const data = parseSavedWorkflowFile(readFileSync(path, "utf-8"));
      if (data === null) return null;
      return {
        ...data,
        location,
        path,
      };
    } catch {
      return null;
    }
  };

  return {
    save(workflow, location = "project") {
      const dir = location === "project" ? projectDir : userDir;
      ensureDir(dir);

      const path = workflowPath(workflow.name, location);
      const saved: SavedWorkflow = {
        ...workflow,
        location,
        path,
        savedAt: new Date().toISOString(),
      };

      writeFileSync(path, JSON.stringify(saved, null, 2));
      return saved;
    },

    load(name: string): SavedWorkflow | null {
      // Project takes precedence over user
      const projectPath = workflowPath(name, "project");
      const project = loadFromFile(projectPath, "project");
      if (project) return project;

      const userPath = workflowPath(name, "user");
      return loadFromFile(userPath, "user");
    },

    list(): SavedWorkflow[] {
      const workflows: SavedWorkflow[] = [];

      // Load project workflows
      if (existsSync(projectDir)) {
        for (const file of readdirSync(projectDir).filter((f) => f.endsWith(".json"))) {
          const wf = loadFromFile(join(projectDir, file), "project");
          if (wf) workflows.push(wf);
        }
      }

      // Load user workflows
      if (existsSync(userDir)) {
        for (const file of readdirSync(userDir).filter((f) => f.endsWith(".json"))) {
          const wf = loadFromFile(join(userDir, file), "user");
          if (wf) workflows.push(wf);
        }
      }

      return workflows.toSorted((a, b) => a.name.localeCompare(b.name));
    },

    delete(name: string, location?: "project" | "user"): boolean {
      const locations = location ? [location] : (["project", "user"] as const);
      let deleted = false;

      for (const loc of locations) {
        const path = workflowPath(name, loc);
        if (existsSync(path)) {
          unlinkSync(path);
          deleted = true;
        }
      }

      return deleted;
    },
  };
}
