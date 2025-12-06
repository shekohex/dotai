---
description: Automatically address GitHub PR reviews by implementing requested changes
---
Analyze and fix all PR reviews on the specified GitHub PR.

1. Get PR details:
// turbo
```bash
gh pr view <pr-number>
```

2. Review all PR comments and review feedback

3. Search codebase for relevant context

4. Address each review comment one by one, in separate commits

5. Write and run tests if applicable

6. Ensure code passes linting/type checking if requested in reviews

7. For each fix, create atomic commit:
// turbo
```bash
git add <files> && git commit -m "<type>(scope): address review - <description>"
```

8. Push changes:
// turbo
```bash
git push
```

9. Comment on the PR with summary of changes made (no emojis)
