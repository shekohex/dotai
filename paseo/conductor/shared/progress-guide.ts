import { DEFAULT_TICKET_PREFIX, displayTicketId } from "./progress.js";

/** Returned by `progress` with op=help. Adapted from the paseo-progress skill to this single tool. */
export const progressGuide = (
  templatesDir: string,
  prefix = DEFAULT_TICKET_PREFIX,
): string => {
  const t1 = displayTicketId("T01", prefix);
  const t3 = displayTicketId("T03", prefix);
  return `# Progress dashboard

The user watches a live dashboard fed by this tool. Record each change when it happens, in plain words for a product manager. One tool, \`progress\`; \`op\` picks the action. Replies are tiny; don't echo them.

Ids: tickets ${t1} (write ${t3} or just 3), questions Q1, stuck flags S1, deliverables D1.

## 1. Set up
1. op=show; continue an open run for this job, else op=start title=<job> text=<spec or folder>.
2. One op=ticket per unit of work: title="Ticket 01: <title>" estimate=<minutes> labels=[...] waitsFor=[tickets it needs first] source=<spec, optional>.

## 2. Work a ticket
- Start: op=ticket id=${t3} status=working stage=Build (a conductor handing it off adds agent=<worker id>).
- Next stage: op=ticket id=${t3} stage=Review percent=60.
- Between events: op=ticker ticket=${t3} text="<doing now>" percent=<0-100>.
- Output to review: op=deliver title=<what it shows> target=<absolute path or URL> ticket=${t3}.
- End: op=ticket id=${t3} status=done, or status=skipped note=<why>.
One agent may work several tickets; pass ticket= on every ticker, deliver, ask, and stuck.

## 3. Links and mentions
- Split big work into sub-tasks with parent=${t1}; the parent's percent rolls up and it closes when all are done.
- waitsFor=[${t3}] orders tickets; related=[...] connects them; [] clears.
- Write #${t3} in any text to link it.

## 4. Good updates
A milestone is op=ticket id=${t3} kind=<feat|fix|refactor|test|build|docs|research|review|plan|deploy|chore> note=<title> body=<details>.
- Title: what changed, under 70 chars, like a commit. Good: "Search box filters tickets by label". Bad: "Working on stuff", "Done step 2".
- Body: optional; why, what is left, links. Skip it when the title says it all.

## 5. Labels
1-3 short lowercase labels per ticket for the area (ui, api, docs, infra) or concern (perf, security). Reuse labels from op=show before inventing one. labels=[...] replaces the set; labels=[] clears it.

## 6. Estimates, percent, ETA
- Estimate total minutes of agent work, plus about 30% for review and fixes. Unknown work: estimate the first step and revise.
- Report percent at each stage (Build ~50, Review ~70, Fixes ~85, Verify ~95). Without it, the dashboard guesses from time and caps at 90%.
- When scope changes, send both with the reason: op=ticket id=${t3} estimate=180 percent=40 note="Bigger than planned: two more endpoints".
- Done tickets ran long? Estimate the rest higher.

## 7. Questions
op=ask title=<short> text=<1-2 sentences> options=[{key:"A",label,detail},...] recommend=<key> ticket=${t3} files=[...] (multi=true lets the user pick several; recommend then lists keys like A,C).
- Build nothing the answer affects until it comes; work on the rest. If nothing is left, say what you wait on.
- A worker's question also reaches the conductor, which answers when it can. Answers arrive as system notes.
- The user answered in chat: op=answer id=Q7 choice=A words="<their words>". op=withdraw id=Q7 drops one.

## 8. Blocked and stuck
- Waiting on another ticket: set waitsFor, not blocked; it shows as waiting, then ready.
- Held up outside the run: op=ticket id=${t3} status=blocked note=<what it waits on>. Your next update on it, or an answer to its question, sets it working again.
- A blocker outside tickets: op=stuck text=<reason>; your next update or op=unstuck id=S1 clears it.

## 9. Check-ins and subagents
- After 15 minutes without an update on a working ticket, its agent gets a check-in note: answer it with a real update.
- Hand a subagent its ticket id in the brief and ask for stage updates and a ticker line between stages.

## 10. Finish
Settle every ticket, question, and stuck flag, then op=finish title=<one-line outcome>. It refuses and says what is open.

## 11. Rich pages
Copy one of ${templatesDir}/{explainer,report,gallery,comparison}.html into a new folder, fill it in, put assets beside it (relative links), then op=deliver target=<that .html>.
`;
};
