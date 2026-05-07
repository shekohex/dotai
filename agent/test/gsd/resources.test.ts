import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadBundledDoc,
  loadBundledPrompt,
  loadBundledTemplate,
} from "../../src/extensions/gsd/resources.js";
import { listGsdRoles } from "../../src/extensions/gsd/roles.js";

describe("gsd bundled resources", () => {
  it("loads shipped docs", () => {
    expect(loadBundledDoc("overview.md")).toContain("# Built-in GSD For Our Agent");
    expect(loadBundledDoc("architecture.md")).toContain("# GSD Architecture");
    expect(loadBundledDoc("user-guide.md")).toContain("# GSD User Guide");
    expect(loadBundledDoc("command-reference.md")).toContain("# GSD Command Reference");
    expect(loadBundledDoc("role-reference.md")).toContain("# GSD Role Reference");
    expect(loadBundledDoc("compatibility.md")).toContain("# GSD Compatibility Notes");
    expect(loadBundledDoc("checklist.md")).toContain("# GSD Delivery Checklist");
    expect(loadBundledDoc("audit.md")).toContain("# GSD Audit");
  });

  it("loads shipped prompt resources for every gsd role", () => {
    for (const role of listGsdRoles()) {
      const prompt = loadBundledPrompt(role);
      expect(prompt.startsWith("---\n")).toBeFalsy();
      expect(prompt).toContain("<role>");
      expect(prompt.includes("~/.claude/get-shit-done")).toBeFalsy();
    }
  });

  it("keeps codebase mapper prompt aligned with direct-write orchestrator contract", () => {
    const prompt = loadBundledPrompt("codebase-mapper");

    expect(prompt).toContain("write analysis documents directly to `.planning/codebase/`");
    expect(prompt).toContain("WRITE DOCUMENTS DIRECTLY.");
    expect(prompt).toContain("Return confirmation only");
  });

  it("keeps intel updater prompt aligned with local refresh contract", () => {
    const prompt = loadBundledPrompt("intel-updater");

    expect(prompt).toContain("`files.json`");
    expect(prompt).toContain("`apis.json`");
    expect(prompt).toContain("`deps.json`");
    expect(prompt).toContain("`arch.md`");
    expect(prompt).toContain("`stack.json`");
    expect(prompt).toContain("intel validate");
    expect(prompt).toContain("intel snapshot");
    expect(prompt).toContain("## INTEL UPDATE COMPLETE");
    expect(prompt).not.toContain("Glob");
    expect(prompt).not.toContain("Grep");
    expect(prompt).not.toContain("gsd-sdk query intel.extract-exports");
  });

  it("loads shipped templates", () => {
    expect(loadBundledTemplate("state.md")).toContain("STATE");
    expect(loadBundledTemplate("project.md")).toContain("Project");
    expect(loadBundledTemplate("requirements.md")).toContain("Requirements");
    expect(loadBundledTemplate("roadmap.md")).toContain("Roadmap");
    expect(loadBundledTemplate("roadmap-empty.md")).toContain("No phases yet.");
    expect(loadBundledTemplate("context.md")).toContain("Context");
    expect(loadBundledTemplate("research.md")).toContain("Research");
    expect(loadBundledTemplate("VALIDATION.md")).toContain("Validation");
    expect(loadBundledTemplate("UAT.md")).toContain("UAT");
  });

  it("ships workflow resources for new-project parity", () => {
    expect(loadBundledDoc("command-reference.md")).toContain("new-project");
  });

  it("new-project workflow encodes approval gate and deterministic instruction generation", () => {
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/new-project.md"),
      "utf8",
    );

    expect(workflow).toContain("If `commit_docs: false`, add `.planning/` to `.gitignore`");
    expect(workflow).toContain("## 8. Roadmap Approval");
    expect(workflow).toContain(
      "If `--auto`, skip this approval loop and treat roadmap as auto-approved.",
    );
    expect(workflow).toContain("If `--auto`, skip interactive requirements approval");
    expect(workflow).toContain('generate-claude-md --output "$INSTRUCTION_FILE_PATH"');
    expect(workflow).toContain(
      "This is local adapted workflow, not full upstream shell/runtime parity.",
    );
    expect(workflow).toContain("If `IS_BROWNFIELD=true`, do not ask generic greenfield intake");
    expect(workflow).toContain("If `IS_BROWNFIELD=true` and `NEEDS_CODEBASE_MAP=true`");
    expect(workflow).toContain(
      "If `CODEBASE_DOCS` is non-empty, read those `.planning/codebase/*.md` docs",
    );
    expect(workflow).toContain(
      "If brownfield codebase docs exist, infer current system capabilities/constraints",
    );
    expect(workflow).toContain("If steering metadata says `GIT_WORKTREE_READY=true`");
    expect(workflow).toContain("HAS_ACCIDENTAL_NESTED_GIT_REPO=true");
    expect(workflow).toContain("Researcher task contract:");
    expect(workflow).toContain("Roadmapper delegation contract:");
  });
});
