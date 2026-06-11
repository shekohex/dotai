import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AuthToken } from "./auth.js";
import {
  WRAPPER_RAW_PACKAGE_ENDPOINT,
  WRAPPER_REPOSITORY,
  type ReleaseChannel,
} from "./version.js";

export interface LatestPackageRelease {
  channel: ReleaseChannel;
  version: string;
  commit?: string;
  note?: string;
}

const RegistryMetadataSchema = Type.Object(
  {
    "dist-tags": Type.Optional(
      Type.Object(
        {
          latest: Type.Optional(Type.String()),
          preview: Type.Optional(Type.String()),
        },
        { additionalProperties: Type.String() },
      ),
    ),
  },
  { additionalProperties: true },
);

const GitHubReleaseSchema = Type.Object(
  {
    target_commitish: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export async function getLatestPackageRelease(
  channel: ReleaseChannel,
  token: AuthToken,
): Promise<LatestPackageRelease> {
  const metadata = await fetchRegistryMetadata(token);
  const version = resolveDistTag(metadata, channel);
  const previewRelease = channel === "preview" ? await fetchPreviewRelease(token) : undefined;
  const latestRelease: LatestPackageRelease = {
    channel,
    version,
  };
  if (previewRelease?.targetCommit !== undefined) {
    latestRelease.commit = previewRelease.targetCommit;
  }
  if (previewRelease?.note !== undefined) {
    latestRelease.note = previewRelease.note;
  }
  return latestRelease;
}

export function isCurrentRelease(
  current: { version: string; commit?: string },
  latest: LatestPackageRelease,
): boolean {
  if (current.version === latest.version) {
    return true;
  }
  if (current.commit === undefined || latest.commit === undefined) {
    return false;
  }
  return latest.commit.startsWith(current.commit) || current.commit.startsWith(latest.commit);
}

async function fetchRegistryMetadata(token: AuthToken): Promise<unknown> {
  const response = await fetch(WRAPPER_RAW_PACKAGE_ENDPOINT, {
    headers: {
      authorization: `Bearer ${token.value}`,
      accept: "application/vnd.npm.install-v1+json",
    },
  });
  if (!response.ok) {
    throw new Error(`failed to fetch package metadata (HTTP ${response.status})`);
  }
  return response.json();
}

function resolveDistTag(metadata: unknown, channel: ReleaseChannel): string {
  if (!Value.Check(RegistryMetadataSchema, metadata)) {
    throw new Error("invalid package metadata from GitHub Packages");
  }
  const distTags = metadata["dist-tags"];
  const version =
    channel === "preview" ? distTags?.preview : (distTags?.latest ?? distTags?.preview);
  if (version === undefined || version.length === 0) {
    throw new Error(`missing ${channel} dist-tag for @shekohex/agent`);
  }
  return version;
}

async function fetchPreviewRelease(
  token: AuthToken,
): Promise<{ targetCommit?: string; note?: string } | undefined> {
  const response = await fetch(
    `https://api.github.com/repos/${WRAPPER_REPOSITORY}/releases/tags/preview`,
    {
      headers: {
        authorization: `Bearer ${token.value}`,
        accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) {
    return undefined;
  }
  const data = (await response.json()) as unknown;
  if (!Value.Check(GitHubReleaseSchema, data)) {
    return undefined;
  }
  const previewRelease: { targetCommit?: string; note?: string } = {};
  if (data.target_commitish !== undefined) {
    previewRelease.targetCommit = data.target_commitish;
  }
  if (data.body !== undefined) {
    previewRelease.note = data.body;
  }
  return previewRelease;
}
