import { createHash } from "node:crypto";
import { NOTIFY_DEFAULT_BASE_URL, type ResolvedNotifySettings } from "./types.js";

const NOTIFY_DEFAULT_TOPIC = "pi";
const NOTIFY_DEFAULT_PUBLISH_TIMEOUT_MS = 15_000;
const NOTIFY_DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const NOTIFY_DEFAULT_RETRY_BASE_DELAY_MS = 500;
const NOTIFY_DEFAULT_SUBSCRIBE_POLL_INTERVAL_MS = 10_000;

function createDefaultSigningSecret(): string {
  return createHash("sha256")
    .update(`${NOTIFY_DEFAULT_BASE_URL}:${NOTIFY_DEFAULT_TOPIC}`)
    .digest("hex");
}

export function resolveNotifySettings(): ResolvedNotifySettings {
  return {
    enabled: true,
    tool: {
      enabled: false,
    },
    baseUrl: NOTIFY_DEFAULT_BASE_URL,
    defaultTopic: NOTIFY_DEFAULT_TOPIC,
    allowAnonymous: true,
    publishTimeoutMs: NOTIFY_DEFAULT_PUBLISH_TIMEOUT_MS,
    debugEvents: false,
    defaultTags: ["pi"],
    defaultPriority: "default",
    retryMaxAttempts: NOTIFY_DEFAULT_RETRY_MAX_ATTEMPTS,
    retryBaseDelayMs: NOTIFY_DEFAULT_RETRY_BASE_DELAY_MS,
    subscribe: {
      enabled: false,
      topics: [NOTIFY_DEFAULT_TOPIC],
      mode: "json",
      since: "all",
      poll: false,
      pollIntervalMs: NOTIFY_DEFAULT_SUBSCRIBE_POLL_INTERVAL_MS,
    },
    callbackServer: {
      enabled: true,
      host: "127.0.0.1",
      signingSecret: createDefaultSigningSecret(),
    },
  };
}

export {
  NOTIFY_DEFAULT_PUBLISH_TIMEOUT_MS,
  NOTIFY_DEFAULT_RETRY_BASE_DELAY_MS,
  NOTIFY_DEFAULT_RETRY_MAX_ATTEMPTS,
  NOTIFY_DEFAULT_SUBSCRIBE_POLL_INTERVAL_MS,
  NOTIFY_DEFAULT_TOPIC,
};
