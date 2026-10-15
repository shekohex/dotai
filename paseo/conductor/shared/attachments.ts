/**
 * Anything the user can open from the dashboard: a deliverable, a ticket's write-up, or a
 * file on a question. Targets are paths or http(s) URLs, as agents recorded them.
 * Icons and kinds follow the Progress plugin by Steve Castaneda (MIT).
 */

export interface Attachment {
  target: string;
  title: string;
}

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const VIDEO = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const TEXT = new Set([
  ".md",
  ".txt",
  ".log",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".csv",
]);

export function isLink(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

function extension(target: string): string {
  return target.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
}

export function previewKind(target: string): "image" | "text" | null {
  if (isLink(target)) return null;
  const ext = extension(target);
  if (IMAGE.has(ext)) return "image";
  return TEXT.has(ext) ? "text" : null;
}

/** Whether the preview dialog shows it in the app; the rest open on the host. */
export function canPreview(attachment: Attachment): boolean {
  return previewKind(attachment.target) !== null;
}

export function attachmentIcon(attachment: Attachment): string {
  const { target } = attachment;
  if (isLink(target)) return "Globe";
  if (/[\\/]$/.test(target)) return "Folder";
  const ext = extension(target);
  if (IMAGE.has(ext)) return "Image";
  if (VIDEO.has(ext)) return "Video";
  if (ext === ".html" || ext === ".htm") return "AppWindow";
  return TEXT.has(ext) ? "FileText" : "File";
}

/** The name people recognize: a file or folder's own name, or a link's site. */
export function shortName(attachment: Attachment): string {
  if (isLink(attachment.target)) {
    try {
      return new URL(attachment.target).host.replace(/^www\./, "");
    } catch {
      return attachment.target;
    }
  }
  return (
    attachment.target
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? attachment.target
  );
}

export function fileAttachment(target: string): Attachment {
  return { target, title: shortName({ target, title: target }) };
}
