# Configuration has global, repo, and CLI layers

Pi Conductor will use a global registry for managed GitHub Projects and repositories, repository-owned `.pi/WORKFLOW.md` files for prompt and policy, and CLI flags for command-specific overrides. This supports multi-repo orchestration while keeping implementation policy versioned with the target repository.
