import { describe, expect, it } from "vitest";
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
});
