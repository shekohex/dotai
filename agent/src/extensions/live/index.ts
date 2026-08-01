import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageEndEvent,
  type MessageStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import {
  LIVE_DELEGATION_MESSAGE_TYPE,
  LIVE_TRANSCRIPT_ENTRY_TYPE,
  LiveSessionController,
  type LiveDelegationMessageDetails,
  type LiveTranscriptEntryData,
} from "./controller.js";
import { configureLiveDiagnostics, LIVE_DIAGNOSTIC_LOG_PATH } from "./diagnostics.js";
import { LivePairingServer, type LivePairingMode } from "./pairing/server.js";
import { LiveVisualizer } from "./visualizer.js";
import {
  defaultLiveSettings,
  getLiveSettings,
  normalizeLiveVoice,
  resolveLiveIdentity,
  type LiveSettings,
} from "./settings.js";
import { isUnknownRecord } from "../../utils/unknown-value.js";
import {
  applyLiveDelegationConversationContext,
  omitEmptyLiveDelegationAssistantTurns,
} from "./provider-context.js";
import { getLiveSessionCoordinator } from "../../live-session/coordinator.js";
import { MODE_ACTIVATE_EVENT } from "../modes/index.js";
import { enforceLiveWritePolicy } from "./write-policy.js";

const ANIMATION_INTERVAL_MS = 80;

interface LiveCommandOptions {
  mode: LivePairingMode;
  sshTargetHint?: string;
  directHost?: string;
  voice?: string;
}

interface ActiveLiveSession {
  controller: LiveSessionController;
  pairing: LivePairingServer;
  stop(): Promise<void>;
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function parseLiveCommand(
  args: string,
  settings: LiveSettings = defaultLiveSettings,
): LiveCommandOptions {
  const options: LiveCommandOptions = {
    mode: settings.transport,
    sshTargetHint: settings.sshTarget,
    directHost: settings.directHost,
    voice: settings.voice,
  };
  for (const token of args.trim().split(/\s+/u).filter(Boolean)) {
    if (
      token === "auto" ||
      token === "local" ||
      token === "coder" ||
      token === "ssh" ||
      token === "direct"
    ) {
      options.mode = token;
      continue;
    }
    const separator = token.indexOf("=");
    const key = separator >= 0 ? token.slice(0, separator) : "";
    const value = separator >= 0 ? token.slice(separator + 1) : "";
    if (key === "target" && value) options.sshTargetHint = value;
    else if (key === "host" && value) options.directHost = value;
    else if (key === "voice" && value) options.voice = normalizeLiveVoice(value);
    else throw new Error(`Unknown /live option: ${token}`);
  }
  return options;
}

function endpointSummary(pairing: LivePairingServer): string {
  return pairing.descriptor.endpoints.map((endpoint) => endpoint.type).join(" + ");
}

async function copyPairingUri(uri: string, ctx: ExtensionContext): Promise<void> {
  try {
    await copyToClipboard(uri);
    ctx.ui.notify("Pi Live pairing URL copied to clipboard", "info");
  } catch (cause) {
    ctx.ui.notify(`Pi Live could not copy pairing URL: ${errorFrom(cause).message}`, "warning");
  }
}

async function activateLiveMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pi.events.emit(MODE_ACTIVATE_EVENT, {
      ctx,
      mode: "live",
      reason: "apply",
      source: "command",
      done: { resolve, reject },
    });
  });
}

function livePanel(
  visualizer: LiveVisualizer,
  interval: NodeJS.Timeout,
): Component & { dispose(): void } {
  return {
    wantsKeyRelease: false,
    render: (width) => visualizer.render(width),
    handleInput: (data) => {
      visualizer.handleInput(data);
    },
    invalidate: () => {
      visualizer.invalidate();
    },
    dispose() {
      clearInterval(interval);
    },
  };
}

function registerTranscriptRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<LiveTranscriptEntryData>(
    LIVE_TRANSCRIPT_ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      const transcript = entry.data ?? {
        role: "assistant",
        text: "Voice transcript unavailable",
        turn: 0,
        timestamp: new Date(entry.timestamp).getTime(),
      };
      const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
      const speaker = transcript.role === "user" ? "you" : "Pi";
      const label = theme.fg("accent", theme.bold(`[live · ${speaker}]`));
      box.addChild(new Text(`${label} ${theme.fg("customMessageText", transcript.text)}`, 0, 0));
      if (expanded) {
        box.addChild(
          new Text(theme.fg("dim", new Date(transcript.timestamp).toLocaleString()), 0, 0),
        );
      }
      return box;
    },
  );
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "Live delegation unavailable";
  const text: string[] = [];
  for (const item of content as unknown[]) {
    if (!isUnknownRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    text.push(item.text);
  }
  return text.join("\n");
}

function delegationRelationLabel(details: LiveDelegationMessageDetails): string {
  const relation = details.transcriptRelation;
  switch (relation) {
    case "verbatim":
      return "direct voice request";
    case "synthesized":
      return "synthesized workspace task";
    case "unknown":
      return "workspace task";
    default:
      return "workspace task";
  }
}

function registerDelegationRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<LiveDelegationMessageDetails>(
    LIVE_DELEGATION_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details ?? {
        delegationId: "unknown",
        sourceTurn: 0,
        transcriptRelation: "unknown",
      };
      const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
      const title = theme.fg("accent", theme.bold("◆ Pi Live → workspace"));
      const request = theme.fg("customMessageText", messageContentText(message.content));
      const lines = [title, "", request];
      if (expanded) {
        lines.push(
          "",
          theme.fg(
            "dim",
            `${delegationRelationLabel(details)} · Triggers AgentSession · voice turn ${details.sourceTurn} · ${details.delegationId}`,
          ),
        );
      }
      box.addChild(new Text(lines.join("\n"), 0, 0));
      return box;
    },
  );
}

// eslint-disable-next-line max-lines-per-function -- command UI and lifecycle share one active session.
export default function liveExtension(pi: ExtensionAPI): void {
  let active: ActiveLiveSession | undefined;
  let liveModeActive = false;
  const coordinator = getLiveSessionCoordinator(pi);
  registerTranscriptRenderer(pi);
  registerDelegationRenderers(pi);

  pi.registerFlag("live", {
    description: "Start in live coordinator mode and launch Pi Live voice",
    type: "boolean",
  });

  pi.on("context", (event) => {
    if (active === undefined) {
      // eslint-disable-next-line unicorn/no-useless-undefined -- undefined means no context change.
      return undefined;
    }
    const withoutEmptyTurns = omitEmptyLiveDelegationAssistantTurns(event.messages);
    const messages = withoutEmptyTurns ?? event.messages;
    const withConversationContext = applyLiveDelegationConversationContext(messages);
    if (withoutEmptyTurns === undefined && withConversationContext === undefined) {
      // eslint-disable-next-line unicorn/no-useless-undefined -- undefined means no context change.
      return undefined;
    }
    return { messages: withConversationContext ?? withoutEmptyTurns ?? event.messages };
  });

  const liveCommand = {
    description: "Start a local-microphone Codex Live session via the Pi Live macOS app",
    getArgumentCompletions(prefix: string) {
      const values = [
        { value: "auto", label: "auto", description: "Coder, SSH, and local adapters" },
        { value: "local", label: "local", description: "Pi and app on this Mac" },
        { value: "coder", label: "coder", description: "Coder private app URL" },
        {
          value: "ssh target=",
          label: "ssh target=host",
          description: "SSH local-forward adapter",
        },
        {
          value: "direct host=",
          label: "direct host=host",
          description: "Direct private/LAN endpoint",
        },
      ];
      const normalized = prefix.trim().toLowerCase();
      const matches = values.filter((item) => item.value.startsWith(normalized));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string, ctx: ExtensionContext): Promise<void> {
      if (active) {
        await active.stop();
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/live currently requires interactive TUI mode", "error");
        return;
      }
      const settings = getLiveSettings();
      configureLiveDiagnostics(settings.diagnosticsEnabled);
      let options: LiveCommandOptions;
      try {
        options = parseLiveCommand(args, settings);
      } catch (cause) {
        ctx.ui.notify(errorFrom(cause).message, "error");
        return;
      }
      if (!settings.enabled) {
        ctx.ui.notify("Pi Live is disabled in settings.json", "warning");
        return;
      }
      await activateLiveMode(pi, ctx);
      const pairing = new LivePairingServer({
        sessionId: ctx.sessionManager.getSessionId(),
        mode: options.mode,
        sshTargetHint: options.sshTargetHint,
        directHost: options.directHost,
        pairingTtlMs: settings.pairingTtlMs,
        heartbeatMs: settings.heartbeatMs,
        reconnectGraceMs: settings.reconnectGraceMs,
      });
      try {
        const descriptor = await pairing.start();
        await copyPairingUri(descriptor.uri, ctx);
        if (settings.diagnosticsEnabled) {
          ctx.ui.notify(`Pi Live diagnostics: ${LIVE_DIAGNOSTIC_LOG_PATH}`, "info");
        }
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          let finished = false;
          let controller: LiveSessionController;
          const finish = (error?: Error): void => {
            if (finished) return;
            finished = true;
            if (active?.controller === controller) active = undefined;
            if (error) ctx.ui.notify(`Pi Live: ${error.message}`, "error");
            done();
          };
          const visualizer = new LiveVisualizer({
            theme,
            endpointSummary: endpointSummary(pairing),
            requestRender: () => {
              tui.requestRender();
            },
            onStop: () => {
              void controller.stop();
            },
            onToggleMute: () => {
              controller.toggleMute();
            },
            onCopy: () => {
              void copyPairingUri(descriptor.uri, ctx);
            },
          });
          controller = new LiveSessionController({
            pi,
            context: ctx,
            pairing,
            identity: resolveLiveIdentity(settings.identity),
            appOpenTimeoutMs: settings.appOpenTimeoutMs,
            voice: options.voice,
            customInstructions: settings.instructions,
            coordinator,
            callbacks: {
              onPhase(phase) {
                visualizer.setPhase(phase);
                tui.requestRender();
              },
              onLevels(input) {
                visualizer.setInputLevel(input);
                tui.requestRender();
              },
              onTranscript(transcript) {
                if (transcript === undefined) visualizer.clearTranscript();
                else visualizer.setTranscript(transcript.text);
                tui.requestRender();
              },
              onAgentFailure(message) {
                ctx.ui.notify(`Pi Live: ${message}`, "error");
              },
              onTerminal: finish,
            },
          });
          const stop = async (): Promise<void> => {
            await controller.stop();
            finish();
          };
          active = { controller, pairing, stop };
          let frame = 0;
          const interval = setInterval(() => {
            frame += 1;
            visualizer.setFrame(frame);
            tui.requestRender();
          }, ANIMATION_INTERVAL_MS);
          queueMicrotask(() => {
            void controller.start().catch((cause) => {
              finish(errorFrom(cause));
            });
          });
          return livePanel(visualizer, interval);
        });
      } catch (cause) {
        await pairing.close();
        ctx.ui.notify(`Pi Live failed: ${errorFrom(cause).message}`, "error");
      } finally {
        const current = active as ActiveLiveSession | undefined;
        if (current?.pairing === pairing) active = undefined;
      }
    },
  };
  pi.registerCommand("live", liveCommand);

  pi.on("session_start", (_event, ctx) => {
    if (pi.getFlag("live") !== true) return;
    queueMicrotask(() => {
      void liveCommand.handler("", ctx);
    });
  });
  pi.events.on("modes:changed", (data) => {
    liveModeActive = isUnknownRecord(data) && data.mode === "live";
  });
  pi.on("tool_call", (event, ctx) => {
    if (!liveModeActive || event.type !== "tool_call") {
      // eslint-disable-next-line unicorn/no-useless-undefined -- undefined allows tool execution.
      return undefined;
    }
    return enforceLiveWritePolicy(event.toolName, event.input, ctx.cwd);
  });

  pi.on("message_end", (event: MessageEndEvent) => {
    active?.controller.handleMessageEnd(event);
  });
  pi.on("message_update", (event) => {
    active?.controller.handleMessageUpdate(event);
  });
  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer" && event.source !== "extension") {
      active?.controller.handlePiSteer(event.text);
    }
  });
  pi.on("message_start", (event: MessageStartEvent) => {
    active?.controller.handleMessageStart(event.message);
  });
  pi.on("agent_end", (event) => {
    active?.controller.handleAgentEnd(event.messages);
  });
  pi.on("agent_settled", () => {
    active?.controller.handleAgentSettled();
  });
  pi.on("session_shutdown", async () => {
    const session = active;
    active = undefined;
    if (session !== undefined) await session.stop();
  });
}

export const _test = { parseLiveCommand };
