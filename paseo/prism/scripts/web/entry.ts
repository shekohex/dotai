// Web and desktop only: Pierre's DOM components behind a small API the plugin's React Native code drives.
import { File, FileDiff, canUseWASM, type DiffLineAnnotation, getSharedHighlighter, parsePatchFiles } from "@pierre/diffs";
import { themes as catalog } from "@pierre/highlights/themes/loader";
import { Editor } from "@pierre/diffs/edit";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { FileTree, createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";

import { ICON_COLORS, TOKEN_COLORS } from "../../shared/file-icon-colors.js";
import type { Author } from "../../shared/review.js";
import type {
  DiffSide,
  DiffViewProps,
  FileIconProps,
  FileViewProps,
  MarkdownViewProps,
  MediaViewProps,
  PierreApi,
  PierreColors,
  PierreView,
  ReviewComment,
  TreeViewProps,
} from "../../shared/pierre-api.js";

type ZedTheme = { appearance?: string; style: Record<string, unknown> };
const registeredThemes = new Map<string, Promise<void>>();
let patchCounter = 0;

/**
 * Registers a bundled Highlights theme with the backend. Pierre's own theme lookup cannot be used:
 * diffs 1.6.0 hands its resolver a `fallbackLoader` that the published `@pierre/theming` 1.0.1
 * ignores, so the theme is registered on the shared resolver directly.
 */
function themeFor(props: { syntax: string }): { name: string; ready: Promise<void> } {
  const name = props.syntax;
  let ready = registeredThemes.get(name);
  if (!ready) {
    const load = (catalog as Record<string, (() => Promise<{ default: ZedTheme }>) | undefined>)[name];
    ready = Promise.all([
      getSharedHighlighter({ themes: [], langs: [], preferredHighlighter: "highlights" }),
      load?.(),
    ]).then(([highlighter, module]) => {
      if (!module) return;
      const zed = module.default;
      const background = String(zed.style["editor.background"] ?? zed.style.background ?? "#000000");
      const foreground = String(zed.style["editor.foreground"] ?? zed.style.text ?? "#ffffff");
      highlighter.themeResolver.registerThemeIfAbsent(name, (async () => ({
        name,
        type: zed.appearance === "light" ? "light" : "dark",
        colors: { foreground, "editor.foreground": foreground, background, "editor.background": background },
        zed,
        fg: foreground,
        bg: background,
      })) as never);
      return highlighter.themeResolver.resolveThemes([name]).then(() => undefined);
    });
    registeredThemes.set(name, ready);
  }
  return { name, ready };
}

function setVars(element: HTMLElement, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) element.style.setProperty(name, value);
}

function alpha(color: string, amount: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(amount * 100)}%, transparent)`;
}

function diffVars(colors: PierreColors, font: DiffViewProps["code"]): Record<string, string> {
  return {
    "--diffs-font-family": font.family,
    "--diffs-header-font-family": font.family,
    "--diffs-font-size": `${font.size}px`,
    "--diffs-line-height": `${font.lineHeight}px`,
    "--diffs-bg-context-override": colors.surface0,
    "--diffs-bg-context-gutter-override": colors.surface0,
    "--diffs-bg-buffer-override": colors.surface1,
    "--diffs-bg-separator-override": colors.surface1,
    "--diffs-bg-hover-override": alpha(colors.foreground, 0.06),
    "--diffs-bg-selection-override": alpha(colors.accent, 0.2),
    "--diffs-bg-selection-number-override": alpha(colors.accent, 0.3),
    "--diffs-fg-number-override": colors.foregroundMuted,
  };
}

type AnnotationMeta = { kind: "comment"; comment: ReviewComment } | { kind: "draft" };

function styled<T extends HTMLElement>(element: T, style: Partial<CSSStyleDeclaration>): T {
  Object.assign(element.style, style);
  return element;
}

function textButton(label: string, color: string, onClick: () => void): HTMLButtonElement {
  const button = styled(document.createElement("button"), {
    background: "none",
    border: "none",
    color,
    cursor: "pointer",
    font: "inherit",
    padding: "2px 8px",
  });
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const units: [number, string][] = [[86_400, "day"], [3_600, "hour"], [60, "minute"]];
  for (const [size, unit] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

function avatarNode(author: Author | null, colors: PierreColors): HTMLElement {
  const size = { width: "20px", height: "20px", borderRadius: "50%", flex: "none" };
  if (author?.avatarUrl) {
    const image = styled(document.createElement("img"), size);
    image.src = author.avatarUrl;
    image.alt = author.login;
    return image;
  }
  const fallback = styled(document.createElement("div"), {
    ...size,
    background: colors.surface2,
    color: colors.foregroundMuted,
    fontSize: "11px",
    lineHeight: "20px",
    textAlign: "center",
  });
  fallback.textContent = (author?.login ?? "?").slice(0, 1).toUpperCase();
  return fallback;
}

function badge(label: string, color: string): HTMLElement {
  const node = styled(document.createElement("span"), {
    border: `1px solid ${color}`,
    color,
    borderRadius: "999px",
    padding: "0 7px",
    fontSize: "11px",
    lineHeight: "16px",
  });
  node.textContent = label;
  return node;
}

/** The textarea and buttons shared by new-comment drafts and edits of existing comments. */
function editorNode(
  colors: PierreColors,
  initial: string,
  submitLabel: string,
  onSubmit: (text: string) => void,
  onCancel: () => void,
): { body: HTMLElement; actions: HTMLElement; input: HTMLTextAreaElement } {
  const body = styled(document.createElement("div"), { padding: "8px 10px" });
  const input = styled(document.createElement("textarea"), {
    width: "100%",
    boxSizing: "border-box",
    minHeight: "72px",
    resize: "vertical",
    background: colors.surface0,
    color: colors.foreground,
    border: `1px solid ${colors.border}`,
    borderRadius: "6px",
    padding: "6px",
    font: "inherit",
  });
  input.placeholder = "Leave a comment";
  input.value = initial;
  const submit = () => {
    const text = input.value.trim();
    if (text !== "") onSubmit(text);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
    if (event.key === "Escape") onCancel();
  });
  body.append(input);
  const actions = styled(document.createElement("div"), {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "0 10px 10px",
  });
  const confirm = styled(textButton(submitLabel, colors.surface0, submit), {
    background: colors.success,
    borderRadius: "6px",
    padding: "4px 12px",
    fontWeight: "600",
  });
  actions.append(textButton("Cancel", colors.foregroundMuted, onCancel), confirm);
  return { body, actions, input };
}

/** A GitHub-style review comment card, or the editor for a comment being written, under a diff line. */
function annotationNode(meta: AnnotationMeta | undefined, current: () => DiffViewProps): HTMLElement {
  const { colors, viewer } = current();
  const card = styled(document.createElement("div"), {
    margin: "8px 12px 8px 56px",
    border: `1px solid ${colors.border}`,
    borderRadius: "8px",
    background: colors.surface0,
    color: colors.foreground,
    font: "13px/1.5 system-ui, -apple-system, sans-serif",
    overflow: "hidden",
  });
  const header = styled(document.createElement("div"), {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    background: colors.surface1,
    borderBottom: `1px solid ${colors.border}`,
  });
  const strong = (text: string) => {
    const node = styled(document.createElement("strong"), { fontWeight: "600" });
    node.textContent = text;
    return node;
  };

  if (meta?.kind === "comment") {
    const { comment } = meta;
    const time = styled(document.createElement("span"), { color: colors.foregroundMuted, flex: "1" });
    time.textContent = relativeTime(comment.createdAt);
    header.append(avatarNode(comment.author, colors), strong(comment.author.login), time);
    if (comment.pending) header.append(badge("Pending", colors.warning));
    const view = () => {
      const body = styled(document.createElement("div"), { padding: "8px 10px", whiteSpace: "pre-wrap" });
      body.textContent = comment.text;
      const actions = styled(document.createElement("div"), { textAlign: "right", padding: "0 6px 6px" });
      actions.append(
        textButton("Edit", colors.foregroundMuted, edit),
        textButton("Delete", colors.foregroundMuted, () => current().onRemoveComment(comment.id)),
      );
      card.replaceChildren(header, body, actions);
    };
    const edit = () => {
      const editor = editorNode(
        colors,
        comment.text,
        "Save",
        (text) => current().onEditComment(comment.id, text),
        view,
      );
      card.replaceChildren(header, editor.body, editor.actions);
      editor.input.focus();
    };
    view();
    return card;
  }

  header.append(avatarNode(viewer, colors), strong(viewer?.login ?? "You"), badge("Draft", colors.foregroundMuted));
  const editor = editorNode(
    colors,
    "",
    "Add review comment",
    (text) => {
      const draft = current().draft;
      if (draft) current().onAddComment(draft.side, draft.line, text);
    },
    () => current().onCancelDraft(),
  );
  card.append(header, editor.body, editor.actions);
  queueMicrotask(() => editor.input.focus());
  return card;
}

/** Scrolls the rendered diff to a line and flashes it. Rendering is async, so it retries briefly. */
function revealLine(
  host: HTMLElement,
  target: { side: DiffSide; line: number },
  colors: PierreColors,
  done: () => void,
): void {
  const selector =
    target.side === "additions"
      ? `[data-line="${target.line}"]:not([data-line-type="change-deletion"])`
      : `[data-line="${target.line}"][data-line-type="change-deletion"], [data-alt-line="${target.line}"]`;
  let attempts = 0;
  const attempt = () => {
    const line = host.querySelector("diffs-container")?.shadowRoot?.querySelector(selector);
    if (line) {
      line.scrollIntoView({ block: "center" });
      line.animate(
        [{ outline: `2px solid ${colors.accent}`, outlineOffset: "-2px" }, { outline: "2px solid transparent", outlineOffset: "-2px" }],
        { duration: 1600, easing: "ease-out" },
      );
      done();
    } else if (++attempts < 30) {
      setTimeout(attempt, 60);
    } else {
      done();
    }
  };
  attempt();
}

function createDiffView(parent: unknown, initial: DiffViewProps): PierreView<DiffViewProps> {
  const host = document.createElement("div");
  host.style.width = "100%";
  (parent as HTMLElement).appendChild(host);

  let diff: FileDiff<AnnotationMeta> | null = null;
  let renderedKey = "";
  let destroyed = false;
  let latest = initial;

  const update = (props: DiffViewProps) => {
    latest = props;
    const theme = themeFor(props);
    void theme.ready.then(() => {
      if (!destroyed) draw(props, theme.name);
    });
  };

  const draw = (props: DiffViewProps, theme: string) => {
    setVars(host, diffVars(props.colors, props.code));
    const options = {
      theme: { dark: theme, light: theme },
      themeType: props.appearance,
      preferredHighlighter: "highlights" as const,
      diffStyle: props.split ? ("split" as const) : ("unified" as const),
      overflow: "wrap" as const,
      disableFileHeader: true,
      hunkSeparators: "line-info" as const,
      lineDiffType: "word-alt" as const,
      enableGutterUtility: true,
      onGutterUtilityClick: (range: { end: number; side?: DiffSide; endSide?: DiffSide }) => {
        latest.onDraft(range.endSide ?? range.side ?? "additions", range.end);
        // A lingering selection makes the next gutter click extend it, which opens the editor on the old line.
        queueMicrotask(() => diff?.setSelectedLines(null));
      },
      renderAnnotation: (annotation: { metadata?: AnnotationMeta }) =>
        annotationNode(annotation.metadata, () => latest),
    };
    const lineAnnotations: DiffLineAnnotation<AnnotationMeta>[] = [
      ...props.comments.map((comment) => ({
        side: comment.side,
        lineNumber: comment.line,
        metadata: { kind: "comment" as const, comment },
      })),
      ...(props.draft
        ? [{ side: props.draft.side, lineNumber: props.draft.line, metadata: { kind: "draft" as const } }]
        : []),
    ];
    const key = JSON.stringify([props.patch, props.split, props.comments, props.draft, props.colors, props.viewer, props.focus]);
    if (key === renderedKey) return;
    renderedKey = key;
    const fileDiff = parsePatchFiles(props.patch, `prism-${patchCounter++}`)[0]?.files[0];
    if (!fileDiff) {
      diff?.cleanUp();
      diff = null;
      host.textContent = "";
      return;
    }
    if (diff) diff.setOptions(options);
    else diff = new FileDiff<AnnotationMeta>(options);
    diff.render({ fileDiff, containerWrapper: host, lineAnnotations, forceRender: true });
    diff.setSelectedLines(null);
    if (props.focus) revealLine(host, props.focus, props.colors, () => latest.onFocused());
  };

  update(initial);
  return {
    update,
    destroy() {
      destroyed = true;
      diff?.cleanUp();
      host.remove();
    },
  };
}

function createFileView(parent: unknown, initial: FileViewProps): PierreView<FileViewProps> {
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  host.style.overflow = "auto";
  (parent as HTMLElement).appendChild(host);

  let file: File | null = null;
  let editor: Editor<"file"> | null = null;
  let stopEditing: (() => void) | null = null;
  let renderedKey = "";
  let destroyed = false;
  let latest = initial;

  const endEditing = () => {
    stopEditing?.();
    stopEditing = null;
    editor = null;
  };

  const draw = (props: FileViewProps, theme: string) => {
    setVars(host, diffVars(props.colors, props.code));
    const options = {
      theme: { dark: theme, light: theme },
      themeType: props.appearance,
      preferredHighlighter: "highlights" as const,
      overflow: "scroll" as const,
      disableFileHeader: true,
      onEditChange: (event: { file: { contents: string } }) => latest.onEdit(event.file.contents),
    };
    // An open editor owns the text; only a new file, theme or the end of editing redraws.
    const key = JSON.stringify([props.name, props.content, theme, props.editing]);
    if (props.editing && editor) return;
    if (!props.editing && key === renderedKey) return;
    endEditing();
    renderedKey = key;
    if (file) file.setOptions(options);
    else file = new File(options);
    file.render({
      file: { name: props.name, contents: props.content, cacheKey: `prism-file-${patchCounter++}` },
      containerWrapper: host,
      forceRender: true,
    });
    if (props.editing) {
      editor = new Editor("file");
      stopEditing = editor.edit(file);
      editor.focus();
    }
  };

  const update = (props: FileViewProps) => {
    latest = props;
    const theme = themeFor(props);
    void theme.ready.then(() => {
      if (!destroyed) draw(props, theme.name);
    });
  };

  update(initial);
  return {
    update,
    destroy() {
      destroyed = true;
      endEditing();
      file?.cleanUp();
      host.remove();
    },
  };
}

const MEDIA_LIMITS_MB: Record<MediaViewProps["kind"], number> = { image: 40, audio: 80, video: 150, pdf: 100 };
const SLICE_BYTES = 512 * 1024;
const PARALLEL_SLICES = 4;

function decodeBase64(chunk: string): Uint8Array {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function createMediaView(parent: unknown, initial: MediaViewProps): PierreView<MediaViewProps> {
  const host = styled(document.createElement("div"), {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "auto",
    boxSizing: "border-box",
  });
  (parent as HTMLElement).appendChild(host);

  let loadedKey = "";
  let objectUrl: string | null = null;
  let generation = 0;

  const release = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };

  const message = (props: MediaViewProps, text: string) => {
    host.textContent = text;
    host.style.color = props.colors.foregroundMuted;
  };

  const show = (props: MediaViewProps, url: string, onError?: () => void) => {
    host.textContent = "";
    const fit = { maxWidth: "100%", maxHeight: "100%" };
    if (props.kind === "image") {
      let zoomed = false;
      const image = styled(document.createElement("img"), { ...fit, objectFit: "contain", cursor: "zoom-in", margin: "auto" });
      image.src = url;
      image.alt = props.name;
      image.addEventListener("click", () => {
        zoomed = !zoomed;
        Object.assign(image.style, zoomed ? { maxWidth: "none", maxHeight: "none", cursor: "zoom-out" } : { ...fit, cursor: "zoom-in" });
      });
      host.style.alignItems = "flex-start";
      host.appendChild(image);
    } else if (props.kind === "video") {
      const video = styled(document.createElement("video"), { ...fit, outline: "none", borderRadius: "8px", background: "#000" });
      video.src = url;
      video.controls = true;
      video.preload = "metadata";
      if (onError) video.addEventListener("error", onError);
      host.appendChild(video);
    } else if (props.kind === "audio") {
      const card = styled(document.createElement("div"), {
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        width: "min(520px, 90%)",
        padding: "20px",
        borderRadius: "12px",
        background: props.colors.surface1,
        border: `1px solid ${props.colors.border}`,
        color: props.colors.foreground,
        fontFamily: "inherit",
      });
      const title = styled(document.createElement("div"), { fontWeight: "600", wordBreak: "break-all" });
      title.textContent = props.name.split("/").pop() ?? props.name;
      const audio = styled(document.createElement("audio"), { width: "100%" });
      audio.src = url;
      audio.controls = true;
      audio.preload = "metadata";
      if (onError) audio.addEventListener("error", onError);
      card.append(title, audio);
      host.appendChild(card);
    } else {
      const frame = styled(document.createElement("iframe"), { width: "100%", height: "100%", border: "none", background: "#fff" });
      frame.src = url;
      frame.title = props.name;
      host.appendChild(frame);
    }
  };

  const load = async (props: MediaViewProps) => {
    const mine = ++generation;
    release();
    host.style.alignItems = "center";
    host.style.colorScheme = props.appearance;
    // Video and audio stream from the daemon with Range. Each URL is tried in turn; when none loads,
    // the file is fetched over the RPC channel in slices.
    if (props.kind === "video" || props.kind === "audio") {
      const urls = await props.getUrls().catch(() => []);
      if (mine !== generation) return;
      const tryUrl = (index: number) => {
        const url = urls[index];
        if (url === undefined) return void loadSliced(props, mine);
        show(props, url, () => {
          if (mine === generation) tryUrl(index + 1);
        });
      };
      tryUrl(0);
      return;
    }
    await loadSliced(props, mine);
  };

  const loadSliced = async (props: MediaViewProps, mine: number) => {
    release();
    host.style.alignItems = "center";
    const limit = MEDIA_LIMITS_MB[props.kind];
    if (props.size > limit * 1024 * 1024) {
      message(props, `Too large to preview (${(props.size / 1024 / 1024).toFixed(1)} MB, limit ${limit} MB).`);
      return;
    }
    const slices = Math.ceil(props.size / SLICE_BYTES);
    const parts = Array.from<Uint8Array>({ length: slices });
    let next = 0;
    let done = 0;
    message(props, "Loading… 0%");
    try {
      await Promise.all(
        Array.from({ length: Math.min(PARALLEL_SLICES, slices) }, async () => {
          while (next < slices && mine === generation) {
            const index = next++;
            parts[index] = decodeBase64(await props.fetchChunk(index * SLICE_BYTES, SLICE_BYTES));
            done++;
            if (mine === generation) message(props, `Loading… ${Math.round((done / slices) * 100)}%`);
          }
        }),
      );
    } catch (error) {
      if (mine === generation) message(props, `Could not load ${props.name}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (mine !== generation) return;
    objectUrl = URL.createObjectURL(new Blob(parts as BlobPart[], { type: props.mimeType }));
    show(props, objectUrl);
  };

  const update = (props: MediaViewProps) => {
    host.style.background = props.colors.surface0;
    const key = `${props.name}|${props.kind}|${props.size}|${props.version}`;
    if (key === loadedKey) return;
    loadedKey = key;
    void load(props);
  };

  update(initial);
  return {
    update,
    destroy() {
      generation++;
      release();
      host.remove();
    },
  };
}

function markdownCss(props: MarkdownViewProps): string {
  const { colors, code, uiFontSize } = props;
  return `
.prism-md { font-size: ${uiFontSize + 1}px; line-height: 1.6; color: ${colors.foreground}; max-width: 860px; margin: 0 auto; padding: 20px 28px 48px; overflow-wrap: anywhere; }
.prism-md h1, .prism-md h2 { padding-bottom: 0.3em; border-bottom: 1px solid ${colors.border}; }
.prism-md h1, .prism-md h2, .prism-md h3, .prism-md h4 { margin: 1.4em 0 0.6em; line-height: 1.25; }
.prism-md h1 { font-size: 1.9em; } .prism-md h2 { font-size: 1.5em; } .prism-md h3 { font-size: 1.25em; }
.prism-md p, .prism-md ul, .prism-md ol, .prism-md pre, .prism-md blockquote, .prism-md table { margin: 0 0 1em; }
.prism-md a { color: ${colors.accent}; }
.prism-md code { font-family: ${code.family}; font-size: 0.9em; padding: 0.15em 0.4em; border-radius: 5px; background: ${colors.surface1}; }
.prism-md pre { padding: 14px 16px; border-radius: 8px; background: ${colors.surface1}; overflow: auto; }
.prism-md pre code { padding: 0; background: none; font-size: ${code.size}px; line-height: ${code.lineHeight}px; }
.prism-md blockquote { padding: 0 1em; border-left: 4px solid ${colors.border}; color: ${colors.foregroundMuted}; }
.prism-md table { border-collapse: collapse; display: block; overflow: auto; }
.prism-md th, .prism-md td { padding: 6px 12px; border: 1px solid ${colors.border}; }
.prism-md th { background: ${colors.surface1}; }
.prism-md hr { border: none; border-top: 1px solid ${colors.border}; margin: 1.5em 0; }
.prism-md img { max-width: 100%; }
.prism-md input[type=checkbox] { margin-right: 0.5em; }
`;
}

function createMarkdownView(parent: unknown, initial: MarkdownViewProps): PierreView<MarkdownViewProps> {
  const host = styled(document.createElement("div"), { width: "100%", height: "100%", overflow: "auto" });
  const style = document.createElement("style");
  const body = document.createElement("div");
  body.className = "prism-md";
  host.append(style, body);
  (parent as HTMLElement).appendChild(host);

  let renderedText: string | null = null;
  const update = (props: MarkdownViewProps) => {
    style.textContent = markdownCss(props);
    host.style.background = props.colors.surface0;
    host.style.colorScheme = props.appearance;
    if (props.text === renderedText) return;
    renderedText = props.text;
    const html = marked.parse(props.text, { gfm: true, async: false });
    body.innerHTML = DOMPurify.sanitize(html);
    body.querySelectorAll("a[href]").forEach((link) => {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    });
  };
  update(initial);
  return { update, destroy: () => host.remove() };
}

function treeVars(props: TreeViewProps): Record<string, string> {
  const { colors } = props;
  return {
    height: "100%",
    display: "block",
    "--trees-bg-override": colors.surface0,
    "--trees-fg-override": colors.foreground,
    "--trees-fg-muted-override": colors.foregroundMuted,
    "--trees-border-color-override": colors.border,
    "--trees-accent-override": colors.accent,
    "--trees-bg-muted-override": alpha(colors.foreground, 0.07),
    "--trees-selected-bg-override": alpha(colors.accent, 0.22),
    "--trees-selected-fg-override": colors.foreground,
    "--trees-font-size-override": `${props.uiFontSize}px`,
    "--trees-status-added-override": colors.success,
    "--trees-status-untracked-override": colors.success,
    "--trees-status-modified-override": colors.warning,
    "--trees-status-renamed-override": colors.warning,
    "--trees-status-deleted-override": colors.danger,
    "--trees-status-ignored-override": colors.foregroundMuted,
    "--trees-git-added-color-override": colors.success,
    "--trees-git-untracked-color-override": colors.success,
    "--trees-git-modified-color-override": colors.warning,
    "--trees-git-renamed-color-override": colors.warning,
    "--trees-git-deleted-color-override": colors.danger,
    "--trees-git-ignored-color-override": colors.foregroundMuted,
  };
}

// Trees detects name overflow with `1lh`; with the app's UI font and its fallbacks the line box
// is a hair taller than `1lh`, so every name looked overflowing and got a marker painted over it.
// Fix the line height and let the browser ellipsize real overflow instead of the marker overlay.
// Folder glyphs from @pierre/icons (IconFolder, IconFolderOpen), used as CSS masks on directory rows.
const FOLDER_PATH =
  "M3.25 1C2.00736 1 1 2.00736 1 3.25V12.75C1 13.9926 2.00736 15 3.25 15H14.75C15.9926 15 17 13.9926 17 12.75V4.75C17 3.50736 15.9926 2.5 14.75 2.5H9.91548C9.77954 2.5 9.64617 2.46306 9.5296 2.39312L7.74214 1.32064C7.39246 1.11083 6.99232 1 6.58452 1H3.25ZM2.5 3.25C2.5 2.83579 2.83579 2.5 3.25 2.5H6.58452C6.72046 2.5 6.85383 2.53694 6.9704 2.60688L8.75786 3.67936C9.10754 3.88917 9.50768 4 9.91548 4H14.75C15.1642 4 15.5 4.33579 15.5 4.75V5H2.5V3.25Z";
const FOLDER_OPEN_PATH =
  "M1 3.25C1 2.00736 2.00736 1 3.25 1H6.58452C6.99232 1 7.39246 1.11083 7.74214 1.32064L9.5296 2.39312C9.64617 2.46306 9.77954 2.5 9.91548 2.5H14.75C15.9926 2.5 17 3.50736 17 4.75V6.04146C17.5918 6.19793 18.0031 6.77621 17.9179 7.4152L17.167 13.0474C17.0179 14.1652 16.0644 15 14.9367 15H3.06325C1.93555 15 0.982031 14.1652 0.832989 13.0474L0.0820342 7.4152C-0.00316776 6.77619 0.408209 6.1979 1 6.04145V3.25ZM15.5 6V4.75C15.5 4.33579 15.1642 4 14.75 4H9.91548C9.50768 4 9.10754 3.88917 8.75786 3.67936L6.9704 2.60688C6.85383 2.53694 6.72046 2.5 6.58452 2.5H3.25C2.83579 2.5 2.5 2.83579 2.5 3.25V6H15.5Z";

function folderMask(path: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="16" viewBox="0 0 18 16"><path d="${path}" fill="black"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const TREE_CSS = `
:host { line-height: 1.4; }
[data-truncate-marker] { display: none !important; }
[data-truncate-content="visible"] { overflow: hidden; text-overflow: ellipsis; }
[data-item-type="folder"] [data-item-section="content"] { display: flex; align-items: center; min-width: 0; }
[data-item-type="folder"] [data-item-section="content"]::before {
  content: "";
  flex: none;
  width: 16px;
  height: 14px;
  margin-right: 6px;
  background-color: var(--trees-accent);
  opacity: 0.85;
  -webkit-mask: ${folderMask(FOLDER_PATH)} center / contain no-repeat;
  mask: ${folderMask(FOLDER_PATH)} center / contain no-repeat;
}
[data-item-type="folder"][aria-expanded="true"] [data-item-section="content"]::before {
  -webkit-mask-image: ${folderMask(FOLDER_OPEN_PATH)};
  mask-image: ${folderMask(FOLDER_OPEN_PATH)};
}
`;

function directoriesOf(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    let slash = path.indexOf("/");
    while (slash !== -1) {
      directories.add(path.slice(0, slash + 1));
      slash = path.indexOf("/", slash + 1);
    }
  }
  return [...directories];
}

function createTreeView(parent: unknown, initial: TreeViewProps): PierreView<TreeViewProps> {
  const host = document.createElement("div");
  host.style.height = "100%";
  (parent as HTMLElement).appendChild(host);

  let props = initial;
  let tree: FileTree | null = null;
  let pathsKey = "";
  let statusKey = "";
  let searchValue = "";
  let expandAll = initial.expandAll;
  let currentPaths = initial.paths;

  const gitStatus = () =>
    Object.entries(props.statuses).map(([path, status]) => ({ path, status }));

  const mount = () => {
    tree?.cleanUp();
    host.textContent = "";
    currentPaths = props.paths;
    tree = new FileTree({
      paths: props.paths,
      flattenEmptyDirectories: true,
      initialExpansion: props.expandAll ? "open" : "closed",
      density: "compact",
      search: false,
      unsafeCSS: TREE_CSS,
      icons: { set: "complete", colored: true },
      gitStatus: gitStatus(),
      renderRowDecoration: ({ item }) => {
        const stat = props.stats[item.path];
        const comments = props.commentCounts[item.path] ?? 0;
        if (!stat && comments === 0) return null;
        const parts = [
          ...(comments > 0 ? [{ text: `💬${comments}\u00a0\u00a0`, color: props.colors.accent }] : []),
          ...(stat
            ? [
                { text: `+${stat.additions}\u00a0`, color: props.colors.success },
                { text: `−${stat.deletions}`, color: props.colors.danger },
              ]
            : []),
        ];
        return { text: parts.map((part) => part.text).join(""), parts };
      },
      composition: {
        contextMenu: {
          enabled: true,
          triggerMode: "right-click",
          render: (item, context) => {
            const { colors } = props;
            const menu = styled(document.createElement("div"), {
              position: "absolute",
              top: "0",
              left: "0",
              zIndex: "10",
              minWidth: "180px",
              padding: "4px",
              background: colors.surface2,
              color: colors.foreground,
              border: `1px solid ${colors.border}`,
              borderRadius: "8px",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
              font: "inherit",
              fontSize: `${props.uiFontSize}px`,
            });
            menu.setAttribute("role", "menu");
            for (const entry of props.menu(item.path, item.kind === "directory")) {
              const option = styled(document.createElement("button"), {
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 10px",
                background: "none",
                border: "none",
                borderRadius: "5px",
                color: "inherit",
                font: "inherit",
                cursor: "pointer",
              });
              option.setAttribute("role", "menuitem");
              option.textContent = entry.label;
              option.addEventListener("mouseenter", () => (option.style.background = alpha(colors.foreground, 0.1)));
              option.addEventListener("mouseleave", () => (option.style.background = "none"));
              option.addEventListener("click", () => {
                context.close();
                props.onMenuAction(entry.id, item.path);
              });
              menu.appendChild(option);
            }
            return menu;
          },
        },
      },
      onSelectionChange: (selected) => {
        const path = selected[selected.length - 1];
        if (path && !path.endsWith("/")) props.onOpenFile(path);
      },
    });
    tree.render({ containerWrapper: host });
    if (searchValue !== "") tree.setSearch(searchValue);
  };

  const update = (next: TreeViewProps) => {
    props = next;
    setVars(host, treeVars(next));
    const nextPathsKey = `${next.expandAll}|${next.paths.join("\n")}`;
    const nextStatusKey = JSON.stringify([next.statuses, next.stats, next.commentCounts]);
    if (tree === null || next.expandAll !== expandAll) {
      pathsKey = nextPathsKey;
      statusKey = nextStatusKey;
      expandAll = next.expandAll;
      mount();
    } else if (nextPathsKey !== pathsKey) {
      // A changed file list keeps the folders the user opened.
      pathsKey = nextPathsKey;
      statusKey = nextStatusKey;
      const opened = directoriesOf(currentPaths).filter((directory) => {
        const item = tree?.getItem(directory);
        return item !== null && item !== undefined && "isExpanded" in item && item.isExpanded();
      });
      currentPaths = next.paths;
      tree.resetPaths(next.paths, { initialExpandedPaths: opened });
      tree.setGitStatus(gitStatus());
    } else if (nextStatusKey !== statusKey) {
      statusKey = nextStatusKey;
      tree.setGitStatus(gitStatus());
    }
    if (next.search !== searchValue) {
      searchValue = next.search;
      tree?.setSearch(searchValue === "" ? null : searchValue);
    }
  };

  update(initial);
  return {
    update,
    destroy() {
      tree?.cleanUp();
      host.remove();
    },
  };
}

let spriteInstalled = false;
const iconResolver = createFileTreeIconResolver({ set: "complete", colored: true });

function createFileIcon(parent: unknown, initial: FileIconProps): PierreView<FileIconProps> {
  if (!spriteInstalled) {
    spriteInstalled = true;
    const sprite = document.createElement("div");
    sprite.style.display = "none";
    sprite.innerHTML = getBuiltInSpriteSheet("complete");
    document.body.appendChild(sprite);
  }
  const host = document.createElement("span");
  host.style.display = "inline-flex";
  (parent as HTMLElement).appendChild(host);
  const update = (props: FileIconProps) => {
    const icon = iconResolver.resolveIcon("file-tree-icon-file", props.name);
    const color = icon.token ? TOKEN_COLORS[icon.token] : undefined;
    const palette = color ? ICON_COLORS[color] : undefined;
    host.style.color = palette ? palette[props.appearance === "dark" ? 0 : 1] : props.muted;
    host.innerHTML = `<svg width="${props.size}" height="${props.size}" viewBox="${icon.viewBox ?? "0 0 16 16"}"><use href="#${icon.name}"></use></svg>`;
  };
  update(initial);
  return { update, destroy: () => host.remove() };
}

const api: PierreApi = { supported: canUseWASM(), createDiffView, createFileView, createMediaView, createMarkdownView, createTreeView, createFileIcon };
export default api;
