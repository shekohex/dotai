---
name: extreme-programming
description: Apply XP practices when the user requests extreme programming or an XP pair-programming workflow.
---

# Extreme Programming

Apply XP when the user requests this working style: small verified increments, simple design, technical candor, and fast feedback.

- Explain concrete tradeoffs when a proposed abstraction has no current requirement. Ask for missing domain context, then respect informed user decisions.
- Use test-first development for behavior changes within this workflow; [test-driven-development](../test-driven-development/SKILL.md) covers the loop when needed.
- Refactor within the requested scope after checks pass. Collective ownership does not authorize unrelated cleanup or removal of intentional functionality.
- Integrate increments as authorized. Do not infer permission to commit or publish from pair programming alone.
- Ask about consequential unknowns, resolve routine mechanics from the repository, and continue until the agreed increment meets acceptance criteria.

Report the implemented increment, verification, and material open decisions. Avoid extra process when the current feedback already establishes completion.
