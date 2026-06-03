export const meta = {
  name: "multi_perspective_analysis",
  description: __description__,
  phases: [{ title: "Perspective Analysis" }, { title: "Synthesis" }],
};

phase("Perspective Analysis");
const topic = __topic__;
const analyses = await parallel(__perspectiveAgents__);

phase("Synthesis");
const synthesis = await agent(
  "Synthesize these different perspectives into a balanced analysis:\n" +
    "Analyses: " +
    JSON.stringify(analyses) +
    "\n" +
    "Topic: " +
    topic,
  { label: "synthesizer" },
);

return { analyses, synthesis };
