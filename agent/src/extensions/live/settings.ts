import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";

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

export type LiveSettings = Required<Omit<Static<typeof LiveSettingsSchema>, "identity">> & {
  identity: Required<Static<typeof LiveIdentitySettingsSchema>>;
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
  voice: "spruce",
  transport: "coder",
  sshTarget: "",
  directHost: "",
  pairingTtlMs: 120_000,
  heartbeatMs: 10_000,
  appOpenTimeoutMs: 25_000,
} as const satisfies LiveSettings;

/** @returns {LiveSettings} Merged global Pi Live settings. */
export function getLiveSettings(): LiveSettings {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  if (!existsSync(settingsPath)) return defaultLiveSettings;
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) return defaultLiveSettings;
  const settings = Value.Parse(AgentSettingsSchema, parsed).live;
  if (settings === undefined) return defaultLiveSettings;
  return {
    ...defaultLiveSettings,
    ...settings,
    identity: { ...defaultLiveSettings.identity, ...settings.identity },
  };
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
