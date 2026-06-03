export const meta = {
  name: "codebase_audit",
  description: __description__,
  phases: [{ title: "Individual Checks" }, { title: "Cross-Validation" }, { title: "Report" }],
};

phase("Individual Checks");
const scope = __scope__;
const findings = await parallel(__checkAgents__);

phase("Cross-Validation");
const validated = await agent(
  "Cross-validate these audit findings. Remove false positives and confirm real issues:\n" +
    JSON.stringify(findings),
  { label: "validator", mode: "review" },
);

phase("Report");
const report = await agent(
  "Generate a prioritized audit report with actionable recommendations:\n" + validated,
  { label: "report-writer", mode: "docs" },
);

return { findings, validated, report };
