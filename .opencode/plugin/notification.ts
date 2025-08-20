import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";

const notificationConfig = {
  enabled: true,
  ntfyTopic: "opencode",
  ntfyIcon: "https://opencode.ai/favicon.svg",
} as const;

export const NotificationPlugin: Plugin = async ({ app, client, $ }) => {
  return {
    event: async ({ event }) => {
      await sendNtfyNotification($, event, app.path.cwd, app.hostname);
    },
  };
};

type BunShell = Parameters<Plugin>[0]["$"];

function isNtfyAvailable($: BunShell): boolean {
  // Check if the ntfy command is available
  return !!$`command -v ntfy`;
}

async function sendNtfyNotification(
  $: BunShell,
  event: Event,
  cwd: string,
  hostname: string
): Promise<void> {
  if (!isNtfyAvailable($)) {
    console.warn("ntfy command is not available");
    return Promise.resolve();
  }

  if (event.type !== "session.idle") {
    // only send notifications for idle sessions
    return Promise.resolve();
  }

  const sessionId = event.properties.sessionID;
  // Get the project name from the cwd
  const projectName = cwd.split("/").pop();
  let title = "Opencode";
  let formattedMessage = `I'm waiting for your response.\nProject: ${projectName}\nHost: ${hostname}`;
  if (projectName) {
    title = `[${projectName}] ${title}`;
  }
  // route the output to /dev/null, stdout and stderr are not needed
  await $`ntfy send --title "${title}" --icon ${notificationConfig.ntfyIcon} --priority 5 --tags robot ${notificationConfig.ntfyTopic} ${formattedMessage} &> /dev/null`;
}
