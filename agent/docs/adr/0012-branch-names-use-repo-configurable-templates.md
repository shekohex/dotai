# Branch names use repo-configurable templates

Pi Conductor will derive run branch names from a per-repository branch template. The default is `pi/{issue}-{slug}`, while repositories can choose templates such as `{prefix}/{kind}-{issue}-{slug}` to fit their branch conventions without changing conductor code. V1 supports `{prefix}`, `{kind}`, `{issue}`, `{slug}`, `{repo}`, and `{owner}` placeholders only.
