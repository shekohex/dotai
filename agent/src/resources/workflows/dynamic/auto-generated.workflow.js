export const meta = {
  name: "auto_generated",
  description: __description__,
  phases: [{ title: "Analyze" }, { title: "Execute" }, { title: "Verify" }],
};

phase("Analyze");
const analysis = await agent("Analyze this task and break it into subtasks: " + __analysisTask__, {
  label: "task analysis",
});

phase("Execute");
const results = await parallel([
  () => agent("Execute subtask 1 based on: " + analysis, { label: "subtask-1" }),
]);

phase("Verify");
const verification = await agent("Verify these results are correct: " + JSON.stringify(results), {
  label: "verification",
});

return { analysis, results, verification };
