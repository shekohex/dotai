# Config init detects current repository

`pi conductor config init` will inspect the current git/GitHub repository, then create or update `~/.pi/agent/conductor/config.json` with an initial managed-repository entry and sensible conductor defaults. If GitHub Project owner or number cannot be inferred unambiguously, it writes TODO placeholders and `config validate` reports them until filled. When run inside a repository, it also creates a minimal `.pi/WORKFLOW.md` template if one does not already exist.
