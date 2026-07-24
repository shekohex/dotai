import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";
import { isUnknownRecord } from "../../utils/unknown-value.js";
import { normalizeLiveVoiceName, type LiveVoice } from "./voices.js";

const LiveIdentitySettingsSchema = Type.Object(
  {
    firstName: Type.Optional(Type.String()),
    lastName: Type.Optional(Type.String()),
    username: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const LiveSettingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    identity: Type.Optional(LiveIdentitySettingsSchema),
    voice: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String({ maxLength: 8_000 })),
    transport: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("local"),
        Type.Literal("coder"),
        Type.Literal("ssh"),
        Type.Literal("direct"),
      ]),
    ),
    sshTarget: Type.Optional(Type.String()),
    directHost: Type.Optional(Type.String()),
    pairingTtlMs: Type.Optional(Type.Number({ minimum: 1_000 })),
    heartbeatMs: Type.Optional(Type.Number({ minimum: 1_000 })),
    appOpenTimeoutMs: Type.Optional(Type.Number({ minimum: 1_000 })),
  },
  { additionalProperties: true },
);

const AgentSettingsSchema = Type.Object(
  { live: Type.Optional(LiveSettingsSchema) },
  { additionalProperties: true },
);

export type LiveSettings = Required<
  Omit<Static<typeof LiveSettingsSchema>, "identity" | "voice">
> & {
  identity: Required<Static<typeof LiveIdentitySettingsSchema>>;
  voice: LiveVoice;
};

export interface ResolvedLiveIdentity {
  firstName: string;
  lastName: string;
  username: string;
  displayName: string;
}

export const defaultLiveSettings = {
  enabled: true,
  identity: {
    firstName: "Shady",
    lastName: "Khalifa",
    username: "shekohex",
  },
  voice: "sol",
  instructions: "",
  transport: "coder",
  sshTarget: "",
  directHost: "",
  pairingTtlMs: 120_000,
  heartbeatMs: 10_000,
  appOpenTimeoutMs: 25_000,
} as const satisfies LiveSettings;

/**
 * Maps legacy Pi Live voice defaults to a Codex Live voice accepted by signaling.
 *
 * @param {string} voice Configured or command-level voice.
 * @returns {string} Voice sent to Codex Live.
 */
export function normalizeLiveVoice(voice: string): string {
  return normalizeLiveVoiceName(voice);
}

/** @returns {LiveSettings} Merged global Pi Live settings. */
export function getLiveSettings(): LiveSettings {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  if (!existsSync(settingsPath)) return defaultLiveSettings;
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) return defaultLiveSettings;
  const settings = Value.Parse(AgentSettingsSchema, parsed).live;
  if (settings === undefined) return defaultLiveSettings;
  let voice: LiveVoice = defaultLiveSettings.voice;
  try {
    voice = normalizeLiveVoiceName(settings.voice ?? defaultLiveSettings.voice);
  } catch {}
  return {
    ...defaultLiveSettings,
    ...settings,
    voice,
    identity: { ...defaultLiveSettings.identity, ...settings.identity },
  };
}

/**
 * Atomically persists the voice selected by the paired macOS client.
 *
 * @param {string} voice Voice selected in the macOS app.
 * @returns {LiveVoice} Persisted lowercase voice identifier.
 */
export function setLiveVoice(voice: string): LiveVoice {
  const normalized = normalizeLiveVoiceName(voice);
  updateLiveSettings((live) => {
    live.voice = normalized;
  });
  return normalized;
}

/**
 * Atomically persists custom live-model behavior preferences from the macOS app.
 *
 * @param {string} instructions User-authored live assistant preferences.
 * @returns {string} Persisted trimmed instructions.
 */
export function setLiveInstructions(instructions: string): string {
  const normalized = instructions.trim();
  if (normalized.length > 8_000) throw new Error("Pi Live instructions exceed 8,000 characters");
  updateLiveSettings((live) => {
    live.instructions = normalized;
  });
  return normalized;
}

function updateLiveSettings(update: (live: Record<string, unknown>) => void): void {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  let root: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!isUnknownRecord(parsed)) {
      throw new Error("Pi settings.json must contain an object");
    }
    root = { ...parsed };
  }
  const currentLive = root.live;
  const live = isUnknownRecord(currentLive) ? { ...currentLive } : {};
  update(live);
  root.live = live;
  mkdirSync(dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, settingsPath);
}

/**
 * Resolves configured identity fields with OS account fallbacks.
 *
 * @param {LiveSettings["identity"]} configured Configured identity overrides.
 * @returns {ResolvedLiveIdentity} Identity used by the live model prompt.
 */
export function resolveLiveIdentity(configured: LiveSettings["identity"]): ResolvedLiveIdentity {
  let osUsername = "user";
  try {
    const candidate = os.userInfo().username.trim();
    if (candidate.length > 0) osUsername = candidate;
  } catch {}
  const username = configured.username.trim() || osUsername;
  const inferredParts = username.split(/[._\-\s]+/u).filter((part) => part.length > 0);
  const firstName = configured.firstName.trim() || inferredParts[0] || "there";
  const lastName = configured.lastName.trim();
  return {
    firstName,
    lastName,
    username,
    displayName: [firstName, lastName].filter((part) => part.length > 0).join(" "),
  };
}
