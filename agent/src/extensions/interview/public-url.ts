import { Type } from "typebox";
import { Value } from "typebox/value";

const CoderEnvironmentSchema = Type.Object(
  {
    CODER: Type.Optional(Type.String()),
    CODER_URL: Type.Optional(Type.String()),
    CODER_AGENT_URL: Type.Optional(Type.String()),
    CODER_WILDCARD_ACCESS_URL: Type.Optional(Type.String()),
    CODER_WORKSPACE_NAME: Type.Optional(Type.String()),
    CODER_WORKSPACE_OWNER_NAME: Type.Optional(Type.String()),
    CODER_WORKSPACE_AGENT_NAME: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

interface CoderEnvironment {
  CODER?: string;
  CODER_URL?: string;
  CODER_AGENT_URL?: string;
  CODER_WILDCARD_ACCESS_URL?: string;
  CODER_WORKSPACE_NAME?: string;
  CODER_WORKSPACE_OWNER_NAME?: string;
  CODER_WORKSPACE_AGENT_NAME?: string;
}

function readCoderEnvironment(environment: NodeJS.ProcessEnv): CoderEnvironment {
  if (!Value.Check(CoderEnvironmentSchema, environment)) {
    return {};
  }
  return Value.Parse(CoderEnvironmentSchema, environment);
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function isRunningInCoderWorkspace(environment: NodeJS.ProcessEnv = process.env): boolean {
  const coderEnvironment = readCoderEnvironment(environment);
  return coderEnvironment.CODER === "true";
}

export function resolveCoderPublicBaseUrl(
  port: number,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const coderEnvironment = readCoderEnvironment(environment);
  if (coderEnvironment.CODER !== "true") {
    return null;
  }

  const owner = coderEnvironment.CODER_WORKSPACE_OWNER_NAME?.trim();
  const workspace = coderEnvironment.CODER_WORKSPACE_NAME?.trim();
  const agent = coderEnvironment.CODER_WORKSPACE_AGENT_NAME?.trim();
  const wildcardAccessUrl = coderEnvironment.CODER_WILDCARD_ACCESS_URL?.trim();
  if (hasText(wildcardAccessUrl) && hasText(owner) && hasText(workspace) && hasText(agent)) {
    const wildcardUrl = new URL(wildcardAccessUrl);
    const wildcardHost = wildcardUrl.host.replace(/^\*\./, "");
    const protocol = hasText(wildcardUrl.protocol) ? wildcardUrl.protocol : "https:";
    return `${protocol}//${port}--${agent}--${workspace}--${owner}.${wildcardHost}/`;
  }

  const coderUrl = coderEnvironment.CODER_URL?.trim();
  const coderAgentUrl = coderEnvironment.CODER_AGENT_URL?.trim();
  const coderBaseUrl = hasText(coderUrl) ? coderUrl : coderAgentUrl;
  if (!hasText(coderBaseUrl) || !hasText(owner) || !hasText(workspace) || !hasText(agent)) {
    return null;
  }

  const baseUrl = new URL(trimTrailingSlashes(coderBaseUrl));
  return `${baseUrl.protocol}//${port}--${agent}--${workspace}--${owner}.${baseUrl.host}/`;
}
