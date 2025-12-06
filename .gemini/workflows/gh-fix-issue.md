---
description: Automatically fix a GitHub issue by analyzing the codebase and implementing changes
---
Analyze and fix the GitHub issue specified.

1. Get issue details:
// turbo
```bash
gh issue view <issue-number>
```

2. Ensure correct git branch:
   - If not on appropriate branch, switch or create: `git checkout -b shady/<new-branch-name>`

3. Understand the problem from issue description and comments

4. Search codebase for relevant files

5. Implement necessary changes to fix the issue

6. Write and run tests if requested in the issue

7. Ensure code passes linting/type checking if requested

8. Create commit with Conventional Commits format:
// turbo
```bash
git add <files> && git commit -m "<type>(scope): <description>"
```

9. Push and create draft PR:
// turbo
```bash
git push -u origin HEAD && gh pr create --draft --fill
```

10. Update the issue with PR link and context (no emojis)
