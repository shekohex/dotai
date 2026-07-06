import { randomBytes } from "node:crypto";

const UUID_HEX_GROUPS = [8, 12, 16, 20];

export function createUuidV7(date = new Date()): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(date.getTime());

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let cursor = 0;
  const groups: string[] = [];
  for (const groupEnd of UUID_HEX_GROUPS) {
    groups.push(hex.slice(cursor, groupEnd));
    cursor = groupEnd;
  }
  groups.push(hex.slice(cursor));
  return groups.join("-");
}

export function slugify(value: string, maxLength = 48): string {
  const slug = value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replaceAll(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "work";
}

export function createRunId(input: { owner: string; repo: string; issueNumber: number }): string {
  return [
    sanitizeRunIdSegment(input.owner),
    sanitizeRunIdSegment(input.repo),
    String(input.issueNumber),
    createUuidV7(),
  ].join("__");
}

export function renderBranchTemplate(
  template: string,
  input: {
    prefix?: string;
    kind?: string;
    issue: number;
    slug: string;
    repo: string;
    owner: string;
  },
): string {
  const values: Record<string, string> = {
    prefix: sanitizeBranchSegment(input.prefix ?? "pi"),
    kind: sanitizeBranchSegment(input.kind ?? "issue"),
    issue: String(input.issue),
    slug: sanitizeBranchSegment(input.slug),
    repo: sanitizeBranchSegment(input.repo),
    owner: sanitizeBranchSegment(input.owner),
  };

  for (const placeholder of template.matchAll(/\{([^}]+)\}/g)) {
    const key = placeholder[1];
    if (key === undefined || values[key] === undefined) {
      throw new Error(`Unsupported branch template placeholder ${placeholder[0]}`);
    }
  }

  const rendered = template.replaceAll(/\{([a-z]+)\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Unsupported branch template placeholder ${match}`);
    }
    return value;
  });

  return rendered
    .replaceAll(/[^A-Za-z0-9._/-]+/g, "-")
    .replaceAll(/\/+/g, "/")
    .replaceAll(/(^|\/)\.(?=\/|$)/g, "$1dot")
    .replaceAll(/^-+|-+$/g, "")
    .replaceAll(/\/-+|-+\//g, "/");
}

function sanitizeRunIdSegment(value: string): string {
  return slugify(value, 64).replaceAll("-", "_");
}

function sanitizeBranchSegment(value: string): string {
  return slugify(value, 64);
}
