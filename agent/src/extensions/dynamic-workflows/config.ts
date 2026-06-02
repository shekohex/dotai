/** Configuration constants for pi-dynamic-workflows. */

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/** Default timeout for a single agent in milliseconds (30 minutes). */
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Maximum concurrent agents (matches Claude Code limit). */
export const MAX_CONCURRENCY = 16;

/** Default token budget if none specified. */
export const DEFAULT_TOKEN_BUDGET = null;

/** Directory for persisting workflow run state. */
export const WORKFLOW_RUNS_DIR = ".pi/workflows/runs";

/** Directory for saved workflow commands. */
export const WORKFLOW_SAVED_DIR = ".pi/workflows/saved";

/** User-level saved workflows directory. */
export const USER_WORKFLOW_SAVED_DIR = "~/.pi/workflows/saved";
