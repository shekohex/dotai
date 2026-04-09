---
name: git-commiting
description: "Read this skill before making git commits; use this skill when the user asks you to commit the code, or before pushing or making a new github pull request"
---

# Creating git commits

Create a git commit for the current changes using a concise Conventional Commits-style subject.

1. List all staged and unstaged changes in the repository.
2. Analyze each change and group related changes together (by feature, fix, refactor, etc.).
3. When using `git diff`, ALWAYS use `--no-ext-diff`, and focus on the actual code changes.
4. For each group, generate a commit message in the Conventional Commits format (<https://www.conventionalcommits.org/en/v1.0.0/>):
  <type>[optional scope]: <description>
  [optional body]
  [optional footer(s)]
5. If changes are unrelated, create multiple commits.
6. (Optional) Run `git log -n 50 --pretty=format:%s` to see commonly used scopes.
7. Only group changes that are logically related and should be committed together.
8. Be atomic and precise. Never mix unrelated changes in a single commit.
9. Always do `git add <files> && git commit -m "<message>"` for each commit you create, to ensure the changes are properly staged and committed in one step.
10. Output a summary of the commits you create, including the files in each commit.
