
# General User Configuration & Preferences

## AI Guidance

* Ignore GEMINI.md and GEMINI-*.md files
* To save main context space, for code searches, inspections, troubleshooting or analysis, use code-searcher subagent where appropriate - giving the subagent full context background for the task(s) you assign it.
* After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your thinking to plan and iterate based on this new information, and then take the best next action.
* For maximum efficiency, whenever you need to perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially.
* Before you finish, please verify your solution
* Do what has been asked; nothing more, nothing less.
* NEVER create files unless they're absolutely necessary for achieving your goal.
* ALWAYS prefer editing an existing file to creating a new one.
* NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.

## Coding Style

- **Variable Names**: Descriptive and meaningful
- **Comments**:
  - Minimal inline comments (only when necessary for clarity)
  - Comprehensive doc comments (JSDoc, Rustdoc) for functions and modules
  - Use less Emojis and more concise language in comments and documentation, README, and markdown files.
- **Architecture**:
  - Domain-Driven Development (DDD)
  - Separation of Concerns (SoC)

## Communication Preferences

- **Response Style**: Concise and to-the-point
- **Code Changes**: No explanations needed unless requested
- **Code Review Approach**: Act as a highly skilled engineer
- **Improvements**: Suggest only when asked

## Command Line Tools

- **Search**: `rg` (ripgrep) instead of `grep`
- **File Finding**: `fd` instead of `find`
- **Text Processing**: `jq` for JSON, `yq` for YAML
- **Git Commits**: Follow [Conventional Commits](https://www.conventionalcommits.org/) format
  - Format: `type(scope): description`
  - Types: feat, fix, docs, style, refactor, test, chore
**Git Branching**: Use `shady/<feature>` for feature branches
- **GitHub Interaction**: gh (GitHub CLI)
- **Gitea Interaction**: Use `tea` (Gitea CLI) for Gitea repositories
- **Shell**: Prefer `zsh` over `bash`

## Personal Preferences

- Command-line tools over GUI applications
- Performance-optimized tools with sensible defaults
- Clean, maintainable code following SOLID principles
- Focus on developer experience and productivity
