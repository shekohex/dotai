---
name: brainstorming
description: Explore an unresolved idea or compare design approaches with the user. Use for requested ideation, not an already specified implementation.
---

# Brainstorming Ideas Into Designs

Turn an unresolved idea into a design with clear outcomes and tradeoffs. Use existing conversation context before asking questions.

1. Inspect the files or docs needed to understand the proposed change. Identify purpose, constraints, and success criteria.
2. Ask about decisions that materially change the design and cannot be inferred. Keep questions focused; continue independent investigation while awaiting answers.
3. Compare plausible approaches when there is a real tradeoff. Recommend one with its costs; a straightforward change need not manufacture alternatives.
4. Present the design at the depth needed for review: relevant boundaries, data flow, failure behavior, and validation. Use one coherent proposal unless the user requested a section-by-section interview.

When a durable design is requested, save it to the user-specified location or `docs/plans/YYYY-MM-DD-<topic>-design.md`. Do not commit merely because a design was written.

Completion means material design decisions are resolved or explicitly identified as open. For design-only work, deliver the design. If implementation is already requested, continue into implementation and validation; wait only for a requested review checkpoint or a material unresolved decision.
