import { Platform } from "react-native";

import { detectDirection, type TextDirection } from "../shared/direction.js";

// DOM globals used by this module only. The project has no "DOM" lib on purpose.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

interface DomNode {
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly parentElement: DomElement | null;
}

interface DomElement extends DomNode {
  readonly childNodes: ArrayLike<DomNode>;
  closest(selector: string): DomElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  remove(): void;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
}

interface DomStyleElement extends DomElement {
  id: string;
  textContent: string | null;
}

interface DomMutationRecord {
  readonly target: DomNode;
  readonly addedNodes: ArrayLike<DomNode>;
}

interface DomMutationObserver {
  disconnect(): void;
  observe(
    target: DomNode,
    options: { childList: boolean; subtree: boolean; characterData: boolean },
  ): void;
}

declare const document: {
  readonly body: DomElement;
  readonly head: DomElement & { appendChild(child: DomNode): void };
  createElement(tag: "style"): DomStyleElement;
  getElementById(id: string): DomElement | null;
};
declare const MutationObserver: new (
  callback: (records: DomMutationRecord[]) => void,
) => DomMutationObserver;
declare function requestAnimationFrame(callback: () => void): number;
declare function cancelAnimationFrame(handle: number): void;

const STYLE_ELEMENT_ID = "paseo-bidi-fix";
const BIDI_ATTRIBUTE = "data-bidi";

const MESSAGE_ROOTS =
  '[data-testid="assistant-message"], [data-testid="user-message"]';
const USER_MESSAGE_ROOT = '[data-testid="user-message"]';
const USER_TEXT_BLOCKS = "[data-message-text]";
const MARKDOWN_BLOCKS = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6"]
  .map((tag) => `[data-paseo-markdown-tag="${tag}"]`)
  .join(", ");
const CODE_BLOCKS = '[data-paseo-markdown-tag="pre"]';
const INLINE_CODE = '[data-paseo-markdown-tag="code"]';
const NON_PROSE_TAGS = new Set(["code", "pre", "ul", "ol"]);
const IGNORED_SURFACES =
  '.xterm, textarea, [contenteditable="true"], [data-composer-input]';
const AUTO_DIRECTION_TEXT = '[dir="auto"]';

const STYLE_SHEET = `
:is([data-testid="assistant-message"], [data-testid="user-message"]) :is([dir="auto"], [data-bidi]) {
  unicode-bidi: plaintext;
  text-align: start;
}
:is([data-testid="assistant-message"], [data-testid="user-message"]) [data-bidi="rtl"] {
  unicode-bidi: isolate;
}
:is([data-testid="assistant-message"], [data-testid="user-message"]) [data-bidi="rtl"][data-paseo-markdown-tag] {
  justify-content: flex-start;
  text-align: start;
}
:is([data-testid="assistant-message"], [data-testid="user-message"]) [data-bidi="rtl"][data-paseo-markdown-tag="li"] > [data-paseo-markdown-list-marker] {
  margin-right: 0;
  margin-left: 4px;
}
:is([data-testid="assistant-message"], [data-testid="user-message"]) :is([data-paseo-markdown-tag="pre"], [data-paseo-markdown-tag="code"]),
:is([data-testid="assistant-message"], [data-testid="user-message"]) [data-paseo-markdown-tag="pre"] * {
  direction: ltr;
  unicode-bidi: isolate;
  text-align: left;
}
`;

function directionOf(element: DomElement): string | null {
  return element.getAttribute("dir");
}

function toArray<T>(list: ArrayLike<T>): T[] {
  return Array.from(list);
}

function collectProse(node: DomNode, parts: string[]): void {
  if (node.nodeType === TEXT_NODE) {
    parts.push(node.textContent ?? "");
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  const element = node as DomElement;
  if (element.hasAttribute("data-paseo-markdown-ignore")) return;
  if (NON_PROSE_TAGS.has(element.getAttribute("data-paseo-markdown-tag") ?? ""))
    return;
  for (const child of toArray(element.childNodes)) collectProse(child, parts);
}

function proseOf(block: DomElement): string {
  const parts: string[] = [];
  for (const child of toArray(block.childNodes)) collectProse(child, parts);
  return parts.join("");
}

function createBidiTagger() {
  const originalDirections = new WeakMap<DomElement, string | null>();

  function tag(element: DomElement, direction: TextDirection): void {
    if (!element.hasAttribute(BIDI_ATTRIBUTE)) {
      originalDirections.set(element, directionOf(element));
    }
    if (directionOf(element) !== direction)
      element.setAttribute("dir", direction);
    if (element.getAttribute(BIDI_ATTRIBUTE) !== direction) {
      element.setAttribute(BIDI_ATTRIBUTE, direction);
    }
  }

  function untagAll(): void {
    for (const element of toArray(
      document.body.querySelectorAll(`[${BIDI_ATTRIBUTE}]`),
    )) {
      const original = originalDirections.get(element);
      if (original) element.setAttribute("dir", original);
      else element.removeAttribute("dir");
      element.removeAttribute(BIDI_ATTRIBUTE);
    }
  }

  return { tag, untagAll };
}

function installBidiFixOnWeb(): () => void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLE_SHEET;
  document.head.appendChild(style);

  const { tag, untagAll } = createBidiTagger();

  /** Direction of one block is applied to its own element and the text roots RN-web gave `dir="auto"`. */
  function applyBlockDirection(block: DomElement): void {
    if (block.closest(CODE_BLOCKS) || block.closest(INLINE_CODE)) return;
    const direction = detectDirection(proseOf(block));
    tag(block, direction);
    for (const text of toArray(
      block.querySelectorAll(`${AUTO_DIRECTION_TEXT}, [${BIDI_ATTRIBUTE}]`),
    )) {
      if (text.closest(CODE_BLOCKS) || text.closest(INLINE_CODE)) continue;
      if (text.hasAttribute("data-paseo-markdown-list-marker"))
        tag(text, "ltr");
      else if (text.getAttribute("data-paseo-markdown-tag") === null)
        tag(text, direction);
    }
  }

  function applyCodeDirection(root: DomElement): void {
    for (const code of toArray(
      root.querySelectorAll(`${CODE_BLOCKS}, ${INLINE_CODE}`),
    )) {
      tag(code, "ltr");
      for (const text of toArray(code.querySelectorAll(AUTO_DIRECTION_TEXT)))
        tag(text, "ltr");
    }
  }

  function processRoot(root: DomElement): void {
    const isUser = root.closest(USER_MESSAGE_ROOT) !== null;
    const blocks = root.querySelectorAll(
      isUser ? USER_TEXT_BLOCKS : MARKDOWN_BLOCKS,
    );
    for (const block of toArray(blocks)) applyBlockDirection(block);
    if (!isUser) applyCodeDirection(root);
  }

  const pendingRoots = new Set<DomElement>();
  let frameHandle: number | null = null;

  function flush(): void {
    frameHandle = null;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    for (const root of roots) processRoot(root);
  }

  function schedule(root: DomElement): void {
    pendingRoots.add(root);
    if (frameHandle === null) frameHandle = requestAnimationFrame(flush);
  }

  function scheduleAround(node: DomNode, includeDescendants: boolean): void {
    const element =
      node.nodeType === ELEMENT_NODE
        ? (node as DomElement)
        : node.parentElement;
    if (!element || element.closest(IGNORED_SURFACES)) return;
    const root = element.closest(MESSAGE_ROOTS);
    if (root) {
      schedule(root);
      return;
    }
    if (!includeDescendants || node.nodeType !== ELEMENT_NODE) return;
    for (const nested of toArray(element.querySelectorAll(MESSAGE_ROOTS)))
      schedule(nested);
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      scheduleAround(record.target, false);
      for (const added of toArray(record.addedNodes))
        scheduleAround(added, true);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  for (const root of toArray(document.body.querySelectorAll(MESSAGE_ROOTS)))
    schedule(root);

  return () => {
    observer.disconnect();
    if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    frameHandle = null;
    pendingRoots.clear();
    untagAll();
    style.remove();
  };
}

/** Web and desktop only. Native cannot patch the Markdown renderer from a plugin, so it is a no-op. */
export function installBidiFix(): () => void {
  if (Platform.OS !== "web") return () => {};
  return installBidiFixOnWeb();
}
