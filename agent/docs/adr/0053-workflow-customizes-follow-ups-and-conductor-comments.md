# Workflow customizes Follow-Ups and Conductor Comments

`.pi/WORKFLOW.md` frontmatter will own repository-specific Follow-Up and Conductor Comment text.

Synthetic feedback is customized through Follow-Up Rules, not a separate template namespace. For example, PR merge conflicts route as `feedback.kind == 'merge_conflict'`, so repositories override that message with a normal Follow-Up Rule.

Follow-Ups use ordered `followUpRules`. Every rule whose optional `if` expression matches renders its `template`. Rules without `if` always match. Matching templates are processed in author order; consecutive templates with the same `delivery` are joined with a blank line, and a delivery change starts a separate send. `delivery` defaults to `followUp`, but rules may choose `steer`. If no rule matches, Conductor uses the built-in feedback message.

Conductor-authored GitHub issue comments use `conductorComments` keyed by lifecycle action: `prAssociated`, `runCompleted`, `runStopped`, and `runBlocked`. Each entry can provide `template` and `enabled`; `enabled: false` suppresses that specific comment. When a comment is posted, Conductor appends its hidden `<!-- pi-conductor -->` marker outside the repository-authored template.

Templates and rule expressions use the same GitHub-style expression engine as workflow prompts. They render from live API/reconciliation state, not raw webhook payloads, so polling, retry, and webhook recovery share the same behavior. The expression context exposes GitHub-style names such as `github.pull_request`, `github.review`, `github.comment`, `github.review_comment`, `github.check`, plus normalized `feedback.*` and `conductor.*` data. `pi conductor config validate` validates all Follow-Up Rules and Conductor Comment Templates against sample structured contexts.

Every rendered Follow-Up includes a safety instruction telling the Pi session to include `<!-- pi-conductor -->` when it posts any GitHub comment or review response for that feedback. This is not repository-customizable because it prevents Conductor from routing the agent's own response back into the same session. Templates may reference the marker as `conductor.commentMarker`.
