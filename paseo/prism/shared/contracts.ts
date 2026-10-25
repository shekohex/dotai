import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const compareSchema = z
  .object({
    /** uncommitted: working tree vs HEAD. committed: HEAD vs the base branch. all: working tree vs the base branch. */
    mode: z.enum(["uncommitted", "committed", "all"]),
    /** Branch to compare against; null picks the repository's default branch. */
    baseRef: z.string().nullable(),
  })
  .strict();
export type Compare = z.infer<typeof compareSchema>;

export const DEFAULT_COMPARE: Compare = { mode: "uncommitted", baseRef: null };

/** A Highlights syntax theme: its bundled name and whether it is a dark or light theme. */
export const syntaxThemeSchema = z
  .object({ name: z.string(), appearance: z.enum(["dark", "light"]) })
  .strict();
export type SyntaxTheme = z.infer<typeof syntaxThemeSchema>;

export const changedFileSchema = z
  .object({
    path: z.string(),
    oldPath: z.string().nullable(),
    status: z.enum(["modified", "added", "deleted", "renamed", "untracked", "conflicted"]),
    staged: z.boolean(),
    unstaged: z.boolean(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
    /** Changes whenever the file's content changes, so cached diffs never go stale. */
    rev: z.string(),
  })
  .strict();
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const statusRpc = defineRpc({
  name: "prism.status",
  input: z.object({ cwd: z.string(), compare: compareSchema }).strict(),
  output: z
    .object({
      isGit: z.boolean(),
      branch: z.string().nullable(),
      upstream: z.string().nullable(),
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      files: z.array(changedFileSchema),
      /** The repository's default branch, if one could be found. */
      defaultBase: z.string().nullable(),
      /** The comparison actually applied; falls back to uncommitted when no base branch resolves. */
      applied: compareSchema,
    })
    .strict(),
});

export const branchesRpc = defineRpc({
  name: "prism.branches",
  input: z.object({ cwd: z.string() }).strict(),
  output: z
    .object({
      current: z.string().nullable(),
      defaultBase: z.string().nullable(),
      branches: z.array(z.string()),
    })
    .strict(),
});

export const diffRpc = defineRpc({
  name: "prism.diff",
  input: z
    .object({
      cwd: z.string(),
      path: z.string(),
      oldPath: z.string().nullable(),
      compare: compareSchema,
      ignoreWhitespace: z.boolean(),
      /** Name of the bundled Highlights theme that colors the tokens. */
      syntax: z.string(),
    })
    .strict(),
  output: z
    .object({
      patch: z.string(),
      binary: z.boolean(),
      tooLarge: z.boolean(),
      /** Colored tokens for each non-hunk row of the parsed patch, in order. Null when not highlighted. */
      tokens: z.array(z.array(z.tuple([z.string(), z.string()]))).nullable(),
    })
    .strict(),
});

export const filesRpc = defineRpc({
  name: "prism.files",
  input: z.object({ cwd: z.string(), includeIgnored: z.boolean() }).strict(),
  output: z
    .object({
      /** Directories end with a slash; ignored directories are listed without their contents. */
      paths: z.array(z.string()),
      /** The subset of `paths` that git ignores. */
      ignored: z.array(z.string()),
      truncated: z.boolean(),
    })
    .strict(),
});

/** Pierre's DOM components ship as one script, served in slices so no single message is huge. */
export const webBundleRpc = defineRpc({
  name: "prism.web-bundle",
  input: z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive() }).strict(),
  output: z.object({ total: z.number().int().nonnegative(), chunk: z.string() }).strict(),
});

/** Picks the bundled Highlights theme matching the host theme (or the user's explicit choice). */
export const syntaxThemeRpc = defineRpc({
  name: "prism.syntax-theme",
  input: z
    .object({
      choice: z.string(),
      /** The host theme's surface color, matched against each theme's editor background. */
      background: z.string(),
      appearance: z.enum(["dark", "light"]),
    })
    .strict(),
  output: syntaxThemeSchema,
});

export const syntaxThemesRpc = defineRpc({
  name: "prism.syntax-themes",
  input: z.object({}).strict(),
  output: z.object({ themes: z.array(syntaxThemeSchema) }).strict(),
});

export const mediaKindSchema = z.enum(["text", "image", "video", "audio", "pdf"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const fileRpc = defineRpc({
  name: "prism.file",
  input: z.object({ cwd: z.string(), path: z.string(), syntax: z.string() }).strict(),
  output: z
    .object({
      content: z.string(),
      /** Colored tokens per line, null for unknown languages and big files. */
      tokens: z.array(z.array(z.tuple([z.string(), z.string()]))).nullable(),
      binary: z.boolean(),
      tooLarge: z.boolean(),
      mtimeMs: z.number(),
      /** What the file is, by its extension; anything else is text or an unreadable binary. */
      kind: mediaKindSchema,
      mimeType: z.string(),
      size: z.number().int().nonnegative(),
    })
    .strict(),
});

/** A slice of a file, base64 encoded, for media that is assembled on the client. */
export const fileBytesRpc = defineRpc({
  name: "prism.file-bytes",
  input: z.object({ cwd: z.string(), path: z.string(), offset: z.number().int().nonnegative(), length: z.number().int().positive() }).strict(),
  output: z.object({ chunk: z.string() }).strict(),
});

/** URLs that serve one media file with HTTP Range, best first, valid for hours. Empty if it is not media. */
export const mediaUrlRpc = defineRpc({
  name: "prism.media-url",
  input: z.object({ cwd: z.string(), path: z.string() }).strict(),
  output: z.object({ urls: z.array(z.string()) }).strict(),
});

export const writeFileRpc = defineRpc({
  name: "prism.write-file",
  input: z.object({ cwd: z.string(), path: z.string(), content: z.string(), expectedMtimeMs: z.number() }).strict(),
  output: z.object({ mtimeMs: z.number() }).strict(),
});

/** Pierre's file-type icons as standalone SVG, for lists the host draws natively. */
export const fileIconsRpc = defineRpc({
  name: "prism.file-icons",
  input: z.object({ names: z.array(z.string()).max(500) }).strict(),
  output: z
    .object({ icons: z.record(z.string(), z.object({ svg: z.string(), token: z.string().nullable() }).strict()) })
    .strict(),
});
