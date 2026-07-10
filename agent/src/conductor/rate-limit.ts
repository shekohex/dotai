import { errorMessage } from "../utils/error-message.js";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { noopConductorLogger, type ConductorLogger } from "./logging.js";
import type { ConductorStore } from "./store/types.js";

export const GITHUB_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const GitHubRateLimitStateSchema = Type.Object({
  blockedUntil: Type.String(),
  reason: Type.String(),
});
const GraphqlRateLimitSchema = Type.Object({
  limit: Type.Number({ minimum: 1 }),
  remaining: Type.Number({ minimum: 0 }),
  resetAt: Type.String(),
});
type GraphqlRateLimit = Static<typeof GraphqlRateLimitSchema>;

export class GitHubRateLimitGate {
  private blockedUntilMs = 0;
  private loaded = false;
  private loadPromise: Promise<void> | undefined;

  constructor(
    private readonly options: {
      host?: string;
      logger?: ConductorLogger;
      now?: () => Date;
      store?: Pick<ConductorStore, "getGitHubSyncState" | "setGitHubSyncState">;
    } = {},
  ) {}

  async assertOpen(): Promise<void> {
    await this.load();
    const now = this.now().getTime();
    if (this.blockedUntilMs <= now) return;
    throw new Error(
      `GitHub rate limit gate closed until ${new Date(this.blockedUntilMs).toISOString()}`,
    );
  }

  async recordFailure(error: unknown): Promise<void> {
    if (!isRateLimitError(error)) return;
    await this.load();
    const blockedUntilMs = rateLimitRetryAt(error, this.now()).getTime();
    await this.blockUntil(blockedUntilMs, errorMessage(error));
  }

  async recordGraphqlBudget(value: unknown): Promise<void> {
    if (value === undefined) return;
    let budget: GraphqlRateLimit;
    try {
      budget = Value.Parse(GraphqlRateLimitSchema, value);
    } catch {
      return;
    }
    const reserve = Math.max(100, Math.ceil(budget.limit * 0.1));
    if (budget.remaining > reserve) return;
    await this.load();
    const resetAtMs = Date.parse(budget.resetAt);
    if (!Number.isFinite(resetAtMs)) return;
    await this.blockUntil(
      resetAtMs,
      `GraphQL budget reserve reached: ${budget.remaining} remaining`,
    );
  }

  private async blockUntil(blockedUntilMs: number, reason: string): Promise<void> {
    if (blockedUntilMs <= this.blockedUntilMs) return;
    this.blockedUntilMs = blockedUntilMs;
    const state = Value.Parse(GitHubRateLimitStateSchema, {
      blockedUntil: new Date(blockedUntilMs).toISOString(),
      reason,
    });
    this.logger().warn("GitHub rate limit gate closed", {
      host: this.host(),
      reason,
      until: state.blockedUntil,
    });
    try {
      await this.options.store?.setGitHubSyncState({
        key: this.stateKey(),
        value: state,
        updatedAt: this.now().toISOString(),
      });
    } catch (error) {
      this.logger().warn("GitHub rate limit state persistence failed", {
        error: errorMessage(error),
        host: this.host(),
      });
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.loadState().finally(() => {
      this.loadPromise = undefined;
    });
    await this.loadPromise;
  }

  private async loadState(): Promise<void> {
    const stored = await this.options.store?.getGitHubSyncState(this.stateKey());
    if (stored !== undefined) {
      try {
        const state = Value.Parse(GitHubRateLimitStateSchema, stored.value);
        this.blockedUntilMs = Date.parse(state.blockedUntil);
        this.logger().info("GitHub rate limit state restored", {
          active: this.blockedUntilMs > this.now().getTime(),
          host: this.host(),
          reason: state.reason,
          until: state.blockedUntil,
        });
      } catch (error) {
        this.logger().warn("GitHub rate limit state invalid", {
          error: errorMessage(error),
          host: this.host(),
        });
      }
    }
    this.loaded = true;
  }

  private stateKey(): string {
    return `github-rate-limit:${this.host()}`;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private host(): string {
    return this.options.host ?? process.env.GH_HOST ?? "github.com";
  }

  private logger(): ConductorLogger {
    return this.options.logger ?? noopConductorLogger;
  }
}

export function isRateLimitError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("secondary rate") ||
    message.includes("abuse detection")
  );
}

export function rateLimitRetryAt(error: unknown, now = new Date()): Date {
  const message = errorMessage(error);
  const gateRetryAt = /rate limit gate closed until (\S+)/iu.exec(message)?.[1];
  if (gateRetryAt !== undefined) {
    const parsed = Date.parse(gateRetryAt);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  const retryAfter = /retry-after[^0-9]*(\d+)/iu.exec(message)?.[1];
  if (retryAfter !== undefined) {
    return new Date(now.getTime() + Number(retryAfter) * 1000);
  }
  const reset = /x-ratelimit-reset[^0-9]*(\d{10,})/iu.exec(message)?.[1];
  if (reset !== undefined) return new Date(Number(reset) * 1000);
  const normalized = message.toLowerCase();
  if (normalized.includes("secondary rate") || normalized.includes("abuse")) {
    return new Date(now.getTime() + 60_000);
  }
  return new Date(now.getTime() + GITHUB_RATE_LIMIT_BACKOFF_MS);
}
