# Learned knowledge

Private product knowledge lives under `~/.agents/projects/<product-id>`. Stable repository knowledge belongs in existing docs or `<repo>/.agents/project`. Repository changes use documentation-worker PR and normal merge approval.

Record explicit user preference immediately with scope, source event, timestamp, and supersession history. Inferred preference stays candidate. Repetition may increase confidence but never silently activates behavior-changing inference.

Promote only verified, reusable, non-secret knowledge: architecture, stable product decisions, proven setup/test/release/recovery workflows, repeated failure root causes, and user preferences affecting future execution.

Keep temporary failures, stale commits, running-agent IDs, and transient environment facts in operational history.

Every state tool response includes neutral reminder to consider whether durable knowledge or preference changed. Tool does not infer candidates. Coordinator judges, deduplicates, supersedes stale entries, and keeps audit history.

Use progressive disclosure: startup loads scoped knowledge only. Query full entries and evidence on demand. Never use raw transcripts as durable context.

