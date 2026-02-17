---
name: gh-address-pr-reviews
agent: plan
description: Automatically fix a GitHub PR reviews by analyzing the codebase changes and the PR Reviews and implementing changes.
---

Please analyze and fix all the PR Reviews on GitHub PR: $ARGUMENTS.

Follow these steps:

1. Use `gh pr view` to get the PR details
2. Understand the problems described in the PR reviews and any PR Comments
3. Search the codebase for relevant files using the code-searcher subagent when possible
4. Implement the necessary changes to fix the PR reviews and address all of them one by one, in separate commits
5. Write and run tests to verify the fix (only if applicable)
6. Ensure code passes linting and type checking (before committing each change, only if asked to do so in the PR reviews)
7. Create a descriptive commit message by using the `git-commiter` subagent
8. Prepare the changes to be pushed and then push them to the remote repository on the same branch.
9. Create a comment on the PR with a summary of the changes made and any relevant context.
10. IMPORTANT: Do not use any emojis in your comments.

Remember to use the GitHub CLI (`gh`) for all GitHub-related tasks.
