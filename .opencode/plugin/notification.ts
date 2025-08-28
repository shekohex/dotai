import type { Plugin } from "@opencode-ai/plugin";
import type { App, Event } from "@opencode-ai/sdk";

const notificationConfig = {
  enabled: true,
  ntfyTopic: "opencode" as const,
  ntfyIcon: "https://opencode.ai/favicon.svg" as const,
  priority: 5,
};

export const NotificationPlugin: Plugin = async ({ app, client, $ }) => {
  return {
    event: async ({ event }) => {
      await sendNtfyNotification($, event, app);
    },
  };
};

type BunShell = Parameters<Plugin>[0]["$"];

function isNtfyAvailable($: BunShell): boolean {
  // Check if the ntfy command is available
  return !!$`command -v ntfy`;
}

function isNotificationEnabled(): boolean {
  return notificationConfig.enabled;
}

async function sendNtfyNotification(
  $: BunShell,
  event: Event,
  app: App,
): Promise<void> {
  if (!isNtfyAvailable($)) {
    console.warn("ntfy command is not available");
    return Promise.resolve();
  }
  if (!isNotificationEnabled()) {
    return Promise.resolve();
  }


  const projectName = app.path.cwd.split("/").pop();
  let title = "Opencode";
  if (projectName) {
    title = `[${projectName}] ${title}`;
  }

  if (event.type !== "session.idle" && event.type !== "session.error") {
    return Promise.resolve();
  }

  let formattedMessage = '';
  if (event.type === "session.error") {
    formattedMessage = `${event.properties.error?.name}: ${event.properties.error?.data.message}\nProject: ${projectName}\nHost: ${app.hostname}`;
    notificationConfig.priority = 5; // set high priority for error notifications
  } else {
    formattedMessage = `I'm waiting for your response.\nProject: ${projectName}\nHost: ${app.hostname}`;
    notificationConfig.priority = 3;
  }

  const sessionId = event.properties.sessionID ?? 'unknown';
  // Get the project name from the cwd
  // route the output to /dev/null, stdout and stderr are not needed
  await $`ntfy send --title "${title}" --icon ${notificationConfig.ntfyIcon} --priority ${notificationConfig.priority} --tags robot,${sessionId} ${notificationConfig.ntfyTopic} ${formattedMessage} &> /dev/null`;
}
