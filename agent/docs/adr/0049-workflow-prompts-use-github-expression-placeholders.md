# Workflow prompts use GitHub expression placeholders

The Markdown body of `.pi/WORKFLOW.md` will use the same GitHub Actions-like expression syntax as launch rules. Prompt templates can reference values such as `${{ github.issue.title }}` or conductor aliases from the normalized run context. Missing referenced values fail validation or dispatch with a clear error instead of rendering empty strings.
