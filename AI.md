# General User Configuration & Preferences

## Guidance

- To save main context space, for code searches, inspections, troubleshooting or analysis, use code-searcher subagent where appropriate - giving the subagent full context background for the task(s) you assign it.
- After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your thinking to plan and iterate based on this new information, and then take the best next action.
- For maximum efficiency, whenever you need to perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially.
- Before you finish, please verify your solution
- Do what has been asked; nothing more, nothing less.
- NEVER create files unless they're absolutely necessary for achieving your goal.
- ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (\_.md) or README files. Only create documentation files if explicitly requested by the User.
- IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request. If you can answer in 1-3 sentences or a short paragraph, please do.
- IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.

## Code style

- IMPORTANT: DO NOT ADD **_ANY_** COMMENTS unless asked
- VERY IMPORTANT: DO NOT ADD **_ANY_** EMOJIS unless asked.

## Communication Preferences

- Response Style: Be extremely concise. Sacrifice grammar for the sake of concision.
- Code Changes: No explanations needed unless requested
- Improvements: Suggest only when asked

## Tooling for shell interactions
Is it about finding FILES? use 'fd' instead of `find`
Is it about finding TEXT/strings? use 'rg' instead of `grep`
Is it about finding CODE STRUCTURE? use 'ast-grep'
Is it about SELECTING from multiple results? pipe to 'fzf'
Is it about interacting with JSON? use 'jq'
Is it about interacting with GitHub? use 'gh'
Is it about interacting with Gitea? use 'tea'

## Personal Preferences

- Git Commits: Follow [Conventional Commits](https://www.conventionalcommits.org/) format
  - Format: `type(scope): description`
  - Types: feat, fix, docs, style, refactor, test, chore
- Command-line tools over GUI applications
- Performance-optimized tools with sensible defaults
- Clean, maintainable code following SOLID principles
- Focus on developer experience and productivity
