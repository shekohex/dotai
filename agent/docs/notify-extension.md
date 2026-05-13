# Notify Extension

`notify` adds ntfy-based notifications and notification event plumbing for Pi.

## Auth

Auth provider id: `ntfy`

Supported stored credential shapes:

- bearer token: `tk_...`
- basic auth: `username:password`

Resolution follows local auth storage conventions used by extensions like `litellm`.

## Events

Outbound request event:

- channel: `notify:publish`
- payload schema: `NotifyPublishPayloadSchema` from `src/extensions/notify/types.ts`

Outbound telemetry events:

- `notify:published`
- `notify:failed`
- `notify:received`
- `notify:action_invoked`
- `notify:action_response`

## Producer Example

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitNotifyPublish } from "../src/extensions/notify/index.js";

export default function demo(pi: ExtensionAPI) {
  emitNotifyPublish(pi, {
    topic: ["my-team", "me"],
    title: "Goal complete",
    message: "Planner finished successfully.",
    tags: ["goal", "complete"],
    markdown: true,
    meta: { sourceExtension: "demo" },
  });
}
```

## Action Callbacks

Actions can include callback metadata. Notify creates signed callback URLs for callback-enabled `http` actions and emits `notify:action_invoked` when user clicks them.

Non-HTTP actions keep original ntfy behavior. Current callback bridge does not rewrite `view`, `copy`, or `broadcast` actions.

Example using direct callback helper:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNotifyCallbackAction, publishNotify } from "../src/extensions/notify/index.js";

export default function demo(pi: ExtensionAPI) {
  publishNotify(
    pi,
    {
      topic: "pi",
      title: "Worker failed",
      message: "Retry job?",
      actions: [
        createNotifyCallbackAction({
          key: "retry-job",
          label: "Retry",
          payload: { jobId: "job-123" },
        }),
      ],
      meta: { sourceExtension: "demo", correlationId: "job-123" },
    },
    {
      onAction: async ({ pi, action }) => {
        pi.events.emit("jobs:retry", {
          jobId: action.callbackPayload,
          correlationId: action.correlationId,
        });
      },
    },
  );
}
```

Use callback server public URLs, not localhost-only URLs. Notify resolves public URL through existing browser-access helpers so Coder-hosted sessions work with remote ntfy clients.

Extension does not need to know callback URL. Notify creates signed public callback URL, receives action click, and invokes registered handler.

## Commands

- `/notify status`
- `/notify auth`
- `/notify test [message]`
- `/notify emit [message]`

## Notes

- publish path uses ntfy JSON API against server root
- multi-topic publish fans out into one request per topic
- transient failures retry with bounded exponential backoff
- final failures surface `ctx.ui.notify()` in interactive sessions
- defaults are opinionated in `src/extensions/notify/settings.ts`
