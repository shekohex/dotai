# Branch names use repo-configurable templates

Pi Conductor will derive run branch names from a per-repository branch template. The default is `pi/${{ github.issue.number }}-${{ github.issue.slug }}`, while repositories can choose templates such as `${{ conductor.branchPrefix }}/${{ conductor.branchKind }}-${{ github.issue.number }}-${{ github.issue.slug }}` to fit their branch conventions without changing conductor code. V1 supports `${{ }}` expressions only; legacy `{issue}` placeholders are rejected.
