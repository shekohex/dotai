# CLI overrides workflow overrides global config

Pi Conductor resolves configuration with CLI flags first, repository `.pi/WORKFLOW.md` second, and global registry defaults last. This makes explicit operator commands authoritative while preserving repo-owned policy and global managed-project defaults.
