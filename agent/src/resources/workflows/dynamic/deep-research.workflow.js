export const meta = {
  name: "deep_research",
  description: "Deep research with real web search and cross-checked claims",
  phases: [{ title: "Queries" }, { title: "Gather" }, { title: "Verify" }, { title: "Report" }],
};

const question = (args && args.question) || "";
const angles = (args && args.angles) || 4;
const minSupport = (args && args.minSupport) || 2;

phase("Queries");
const plan = await agent(
  "You are planning web research for this question:\n" +
    question +
    "\n\nProduce " +
    angles +
    " diverse, specific search queries that together cover the question from different angles.",
  {
    label: "plan queries",
    schema: {
      type: "object",
      properties: { queries: { type: "array", items: { type: "string" } } },
      required: ["queries"],
    },
  },
);
const queries = (plan.queries || []).slice(0, angles);

phase("Gather");
const gathered = await parallel(
  queries.map(
    (q, i) => () =>
      agent(
        "Research this query using the websearch tool.\nQuery: " +
          q +
          "\n\nCall websearch with the query. Extract concrete, verifiable factual claims from the answer and citations, " +
          "each tagged with exact source URLs returned by websearch. Do NOT invent sources or claims.",
        {
          label: "research " + (i + 1),
          schema: {
            type: "object",
            properties: {
              sources: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    claims: { type: "array", items: { type: "string" } },
                  },
                  required: ["url", "claims"],
                },
              },
            },
            required: ["sources"],
          },
        },
      ),
  ),
);
const allSources = gathered.filter(Boolean).flatMap((g) => (g && g.sources) || []);

phase("Verify");
const verdict = await agent(
  "Cross-check these research sources. Group claims that assert the same fact across different source URLs. " +
    "Keep a claim only if it is supported by at least " +
    minSupport +
    " distinct source URLs OR by one clearly authoritative source. " +
    "Discard claims found in a single weak source or that conflict with others.\n\nSOURCES JSON:\n" +
    JSON.stringify(allSources),
  {
    label: "cross-check",
    schema: {
      type: "object",
      properties: {
        supported: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string" },
              sources: { type: "array", items: { type: "string" } },
            },
            required: ["claim", "sources"],
          },
        },
        discarded: { type: "array", items: { type: "string" } },
      },
      required: ["supported"],
    },
  },
);

phase("Report");
const report = await agent(
  "Write a concise, well-structured research report that answers the question using ONLY the supported claims below. " +
    "Cite source URLs inline next to each claim. If the evidence is thin, say so explicitly.\n\n" +
    "QUESTION: " +
    question +
    "\n\nSUPPORTED CLAIMS JSON:\n" +
    JSON.stringify((verdict && verdict.supported) || []),
  { label: "write report" },
);

return { question, queries, supported: (verdict && verdict.supported) || [], report };
