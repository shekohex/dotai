---
description: Create atomic git commits with Conventional Commits format
---
Review all staged and unstaged changes in the repository.

1. List changes with `git status` and `git diff --no-ext-diff`
// turbo

2. Group related changes logically (by feature, fix, refactor, etc.)

3. For each group, create a commit in Conventional Commits format:
   - `feat` for new features
   - `fix` for bug fixes
   - `refactor` for refactoring
   - `docs` for documentation
   - `test` for tests
   - `chore` for maintenance

4. Stage and commit each group atomically:
// turbo
```bash
git add <files> && git commit -m "<type>[scope]: <description>"
```

5. Use imperative mood, be concise. Add scope if limited to a module.

6. Output summary of commits created. Warn if uncommitted changes remain.
