Bring local grouped `/gsd ...` command surface into credible high-parity alignment with upstream GSD without fake support claims.

Acceptance:

- active command slice reaches 90%+ credible parity before moving on
- claimed score matches `docs/gsd-command-coverage-audit.md`
- required full checks pass: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`

Non-goals:

- fake support for deferred branches
- unrelated command refactors
- backward compatibility work not required by current grouped command UX
