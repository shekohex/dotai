import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const SHARE_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".webm", ".mp3", ".m4a", ".wav", ".ogg", ".pdf", ".html", ".htm",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
]);
const IMAGE_MAX_BYTES = 4 * 1024 ** 2;

/**
 * The real path of a file an agent may show: inside its working directory or the temp directory,
 * no dotfiles or dot folders on the way, and no symlink out. Everything else is refused, so an
 * agent can't use a render to read secrets off the host.
 */
export async function resolveShowable(paseo: PaseoApi, agentId: string, requested: string): Promise<string> {
  const agent = paseo.agents.ref(agentId);
  await agent.refresh();
  const cwd = agent.cwd;
  if (!cwd) throw new Error("Unknown agent working directory");
  const roots = (await Promise.all([cwd, tmpdir()].map((root) => realpath(root).catch(() => null)))).filter(
    (root): root is string => root !== null,
  );
  const real = await realpath(path.resolve(cwd, requested)).catch(() => null);
  if (!real) throw new Error(`File not found: ${requested}`);
  const root = roots.find((candidate) => real.startsWith(`${candidate}${path.sep}`));
  if (!root) throw new Error("Only files inside the agent's working directory or the temp directory can be shown");
  const relative = path.relative(root, real).split(path.sep);
  if (relative.some((part) => part.startsWith("."))) throw new Error("Hidden files and folders can't be shown");
  const info = await stat(real);
  if (!info.isFile()) throw new Error("Not a file");
  return real;
}

export async function readImage(
  paseo: PaseoApi,
  agentId: string,
  requested: string,
): Promise<{ mime: string; data: string }> {
  const real = await resolveShowable(paseo, agentId, requested);
  const mime = IMAGE_MIME[path.extname(real).toLowerCase()];
  if (!mime) throw new Error("Image must be png, jpg, gif or webp");
  const info = await stat(real);
  if (info.size > IMAGE_MAX_BYTES) throw new Error("Image is larger than 4 MB");
  return { mime, data: (await readFile(real)).toString("base64") };
}

export async function shareableFile(paseo: PaseoApi, agentId: string, requested: string): Promise<string> {
  const real = await resolveShowable(paseo, agentId, requested);
  if (!SHARE_EXTENSIONS.has(path.extname(real).toLowerCase())) throw new Error("This file type can't be opened");
  return real;
}
