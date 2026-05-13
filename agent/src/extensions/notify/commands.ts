import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotifyAuthHeaders, resolveNotifyCredential } from "./auth.js";
import { createNotifyClient } from "./client.js";
import { resolveNotifySettings } from "./settings.js";
import { NOTIFY_AUTH_PROVIDER, NOTIFY_PUBLISH_EVENT, type NotifyPublishPayload } from "./types.js";

function parseTestMessage(
  args: string,
  settings: ReturnType<typeof resolveNotifySettings>,
): NotifyPublishPayload | null {
  const trimmedArgs = args.trim();
  const message = trimmedArgs.length > 0 ? trimmedArgs : "Test notification from Pi";
  const topic = settings.defaultTopic;
  if (topic === undefined) {
    return null;
  }
  return {
    topic,
    message,
    title: "Pi Notify Test",
    meta: { sourceExtension: "notify", eventName: "notify:test" },
  };
}

async function handleTestCommand(args: string, ctx: ExtensionContext): Promise<void> {
  const settings = resolveNotifySettings();
  const payload = parseTestMessage(args, settings);
  if (!payload) {
    ctx.ui.notify("notify default topic missing", "warning");
    return;
  }
  const credential = await resolveNotifyCredential(ctx);
  const auth = createNotifyAuthHeaders(credential, settings.allowAnonymous);
  if (!auth.configured && !settings.allowAnonymous) {
    ctx.ui.notify("notify auth missing", "error");
    return;
  }
  const client = createNotifyClient();
  const result = await client.publishMany({ payload, auth, settings });
  ctx.ui.notify(
    result.failures.length > 0
      ? `notify failed: ${result.failures[0]?.error ?? "unknown"}`
      : "notify sent",
    result.failures.length > 0 ? "error" : "info",
  );
}

export function registerNotifyCommands(pi: ExtensionAPI): void {
  pi.registerCommand("notify", {
    description: "Notify status, auth, and test publishing",
    getArgumentCompletions(argumentPrefix) {
      const completions = ["status", "auth", "test", "test hello", "emit", "emit hello"];
      const prefix = argumentPrefix.trim().toLowerCase();
      const items = completions
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args
        .trim()
        .split(/\s+/)
        .filter((value) => value.length > 0);
      if (subcommand === "test") {
        await handleTestCommand(rest.join(" "), ctx);
        return;
      }
      if (subcommand === "auth") {
        const credential = await resolveNotifyCredential(ctx);
        const auth = createNotifyAuthHeaders(credential, resolveNotifySettings().allowAnonymous);
        ctx.ui.notify(
          `${NOTIFY_AUTH_PROVIDER}: ${auth.label}`,
          auth.configured ? "info" : "warning",
        );
        return;
      }
      if (subcommand === "status") {
        const settings = resolveNotifySettings();
        ctx.ui.notify(
          `notify enabled=${settings.enabled} base=${settings.baseUrl} topic=${settings.defaultTopic ?? "unset"}`,
          "info",
        );
        return;
      }
      if (subcommand === "emit") {
        const settings = resolveNotifySettings();
        if (settings.defaultTopic === undefined) {
          ctx.ui.notify("notify default topic missing", "warning");
          return;
        }
        const joined = rest.join(" ");
        pi.events.emit(NOTIFY_PUBLISH_EVENT, {
          topic: settings.defaultTopic,
          message: joined.length > 0 ? joined : "Event publish test",
          meta: { sourceExtension: "notify", eventName: "notify:emit" },
        } satisfies NotifyPublishPayload);
        ctx.ui.notify("notify event emitted", "info");
        return;
      }
      ctx.ui.notify("Usage: /notify status|auth|test [message]|emit [message]", "info");
    },
  });
}
