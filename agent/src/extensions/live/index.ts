import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import {
  LIVE_DELEGATION_MESSAGE_TYPE,
  LIVE_REJECTED_DELEGATION_ENTRY_TYPE,
  LIVE_TRANSCRIPT_ENTRY_TYPE,
  LiveSessionController,
  type LiveDelegationMessageDetails,
  type LiveRejectedDelegationEntryData,
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

async function copyPairingUri(uri: string, ctx: ExtensionCommandContext): Promise<void> {
  try {
    await copyToClipboard(uri);
    ctx.ui.notify("Pi Live pairing URL copied to clipboard", "info");
  } catch (cause) {
    ctx.ui.notify(`Pi Live could not copy pairing URL: ${errorFrom(cause).message}`, "warning");
  }
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
  if (details.normalizedBy !== undefined) return "translated workspace task";
  const relation = details.transcriptRelation;
  switch (relation) {
    case "verbatim":
      return "verbatim voice request";
    case "synthesized":
      return "synthesized workspace task";
    case "unknown":
      return "workspace task";
    default:
      return "workspace task";
  }
}

function delegationRelationTone(details: LiveDelegationMessageDetails): "success" | "warning" {
  if (details.normalizedBy !== undefined) return "success";
  return details.transcriptRelation === "verbatim" ? "warning" : "success";
}

function delegationLanguageLabel(details: LiveDelegationMessageDetails): string {
  if (details.normalizedBy !== undefined) return `normalized by ${details.normalizedBy}`;
  if (details.languageAssessment === "english") return "English task";
  return "short command";
}

function registerDelegationRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<LiveDelegationMessageDetails>(
    LIVE_DELEGATION_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details ?? {
        delegationId: "unknown",
        sourceTurn: 0,
        transcriptRelation: "unknown",
        languageAssessment: "short-ambiguous",
      };
      const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
      const title = theme.fg("accent", theme.bold("◆ Pi Live → workspace"));
      const relationTone = delegationRelationTone(details);
      const relation = theme.fg(relationTone, delegationRelationLabel(details));
      const request = theme.fg("customMessageText", messageContentText(message.content));
      const lines = [`${title}  ${relation}`, "", request];
      if (details.originalRequest !== undefined) {
        lines.push(
          "",
          theme.fg("dim", "Original voice delegation"),
          theme.fg("muted", details.originalRequest),
        );
      }
      if (expanded) {
        lines.push(
          "",
          theme.fg(
            "dim",
            `Triggers AgentSession · voice turn ${details.sourceTurn} · ${delegationLanguageLabel(details)} · ${details.delegationId}`,
          ),
        );
      }
      box.addChild(new Text(lines.join("\n"), 0, 0));
      return box;
    },
  );

  pi.registerEntryRenderer<LiveRejectedDelegationEntryData>(
    LIVE_REJECTED_DELEGATION_ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      const details = entry.data;
      const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
      const title = theme.fg("warning", theme.bold("◇ Pi Live delegation failed"));
      const body = theme.fg(
        "customMessageText",
        details?.request ?? "Non-English delegation unavailable",
      );
      const lines = [`${title}  ${theme.fg("dim", "normalization unavailable")}`, "", body];
      if (expanded && details !== undefined) {
        lines.push(
          "",
          theme.fg(
            "dim",
            `Not sent to AgentSession · ${details.detectedLanguage} · ${details.message} · ${details.delegationId}`,
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
  registerTranscriptRenderer(pi);
  registerDelegationRenderers(pi);

  pi.registerCommand("live", {
    description: "Start a local-microphone Codex Live session via the Pi Live macOS app",
    getArgumentCompletions(prefix) {
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
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
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
      if (!settings.enabled) {
        ctx.ui.notify("Pi Live is disabled in settings.json", "warning");
        return;
      }
      let options: LiveCommandOptions;
      try {
        options = parseLiveCommand(args, settings);
      } catch (cause) {
        ctx.ui.notify(errorFrom(cause).message, "error");
        return;
      }
      const pairing = new LivePairingServer({
        sessionId: ctx.sessionManager.getSessionId(),
        mode: options.mode,
        sshTargetHint: options.sshTargetHint,
        directHost: options.directHost,
        pairingTtlMs: settings.pairingTtlMs,
        heartbeatMs: settings.heartbeatMs,
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
  });

  pi.on("message_end", (event: MessageEndEvent) => {
    active?.controller.handleMessageEnd(event);
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
