---
name: gh-fix-issue
agent: plan
description: Automatically fix a GitHub issue by analyzing the codebase and implementing changes.
---

Please analyze and fix the GitHub issue: $ARGUMENTS.

Follow these steps:

1. Use `gh issue view` to get the issue details
2. IMPORTANT: Before you make any changes, ensure you are on the correct git branch
   - If not, switch to the appropriate branch using `git checkout <branch-name>`
   - If the branch does not exist, create it using `git checkout -b shady/<new-branch-name>`
3. Understand the problem described in the issue description and any comments in that issue too.
4. Search the codebase for relevant files using `code-searcher` agent.
5. Implement the necessary changes to fix the issue
6. Write and run tests to verify the fix (only if asked to do so in the issue description)
7. Ensure code passes linting and type checking (only if asked to do so in the issue description)
8. Create a descriptive commit message by using the `git-commiter` subagent
9. Push and create a PR against the branch we used as our base in step 4 as a draft PR, without any emojis.
10. Remember to update the issue with any relevant information, including links to the PR and any important context.

Remember to use the GitHub CLI (`gh`) for all GitHub-related tasks.
