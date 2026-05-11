/**
 * Block Targeting — resolves which element to annotate in pinpoint mode.
 *
 * Walks from the element under the cursor upward through the block tree
 * to find the most specific targetable element (inline, cell, or block).
 */

/** Elements that should never be targeted */
const SKIP_SELECTORS = [
  '.annotation-toolbar',
  '.annotation-highlight',
  'mark[data-bind-id]',
  'button',
  '[data-pinpoint-ignore]',
].join(',');

/** Inline elements that are individually targetable within a block */
const INLINE_TARGETS = new Set(['STRONG', 'EM', 'A']);

/** Table cell elements */
const CELL_TARGETS = new Set(['TD', 'TH']);

export interface PinpointTarget {
  /** The DOM element to highlight and select */
  element: HTMLElement;
  /** The data-block-id of the parent block */
  blockId: string;
  /** Human-readable label for the hover tooltip */
  label: string;
  /** Whether this is a code block (needs special annotation path) */
  isCodeBlock: boolean;
}

/** Edge-zone threshold for table hover (px). Covers the outermost cell padding
 *  area (cells have px-3/py-2 = 12px/8px padding) so you need to aim at actual
 *  text content to target a specific cell. */
const TABLE_EDGE_ZONE = 22;

/**
 * Given a mousemove/click target element, find the best annotation target
 * within the viewer container. Optionally accepts mouse coordinates for
 * edge-zone detection (tables).
 */
export function resolvePinpointTarget(
  target: HTMLElement,
  container: HTMLElement,
  mousePos?: { clientX: number; clientY: number },
): PinpointTarget | null {
  // Skip toolbar, buttons, existing annotations
  if (target.closest(SKIP_SELECTORS)) return null;
  if (!container.contains(target)) return null;

  // Group detection: cursor is in the gap/gutter of a list group wrapper
  const groupEl = target.closest('[data-pinpoint-group]') as HTMLElement | null;
  if (groupEl && container.contains(groupEl) && !target.closest('[data-block-id]')) {
    const groupType = groupEl.getAttribute('data-pinpoint-group');
    const label = groupType === 'list' ? 'list' : groupType === 'blockquote' ? 'blockquote group' : 'group';
    return { element: groupEl, blockId: '', label, isCodeBlock: false };
  }

  // Find the parent block
  const blockEl = target.closest('[data-block-id]') as HTMLElement | null;
  if (!blockEl || !container.contains(blockEl)) return null;

  const blockId = blockEl.getAttribute('data-block-id')!;

  // Skip hr (no text content)
  if (blockEl.tagName === 'HR') return null;

  // Code block detection: pre > code.hljs
  const codeEl = blockEl.querySelector('pre > code.hljs');
  if (codeEl && (target === codeEl || codeEl.contains(target) || target.closest('pre'))) {
    return {
      element: blockEl,
      blockId,
      label: getCodeBlockLabel(blockEl),
      isCodeBlock: true,
    };
  }

  // Table edge-zone detection: edges target whole table or row
  const tableEl = blockEl.querySelector('table');
  if (tableEl && mousePos) {
    const tableRect = tableEl.getBoundingClientRect();
    const nearLeft = mousePos.clientX - tableRect.left < TABLE_EDGE_ZONE;
    const nearRight = tableRect.right - mousePos.clientX < TABLE_EDGE_ZONE;
    const nearTop = mousePos.clientY - tableRect.top < TABLE_EDGE_ZONE;
    const nearBottom = tableRect.bottom - mousePos.clientY < TABLE_EDGE_ZONE;

    // Top/bottom edge → whole table
    if (nearTop || nearBottom) {
      return { element: blockEl, blockId, label: 'table', isCodeBlock: false };
    }

    // Left/right edge → the row at this Y position
    if (nearLeft || nearRight) {
      const row = findRowAtY(tableEl, mousePos.clientY);
      if (row) {
        return { element: row, blockId, label: getRowLabel(row), isCodeBlock: false };
      }
      return { element: blockEl, blockId, label: 'table', isCodeBlock: false };
    }
  }

  // Inline code (not inside a code block) — target the <code> element
  if (target.tagName === 'CODE' && !target.classList.contains('hljs')) {
    const text = target.textContent?.trim() || '';
    if (text) {
      return {
        element: target,
        blockId,
        label: `code: \`${truncate(text, 30)}\``,
        isCodeBlock: false,
      };
    }
  }

  // Inline elements: strong, em, a
  if (INLINE_TARGETS.has(target.tagName)) {
    const text = target.textContent?.trim() || '';
    if (text) {
      return {
        element: target,
        blockId,
        label: getInlineLabel(target, text),
        isCodeBlock: false,
      };
    }
  }

  // Table cells (only reached when cursor is deep inside, not near edge)
  if (CELL_TARGETS.has(target.tagName)) {
    return {
      element: target,
      blockId,
      label: 'table cell',
      isCodeBlock: false,
    };
  }
  // Check if inside a table cell
  const cell = target.closest('td, th') as HTMLElement | null;
  if (cell && blockEl.contains(cell)) {
    return {
      element: cell,
      blockId,
      label: 'table cell',
      isCodeBlock: false,
    };
  }

  // List item — target the content span (second child), not the bullet
  if (blockEl.querySelector('.select-none')) {
    // This is a list item with a bullet. Find the content span.
    const contentSpan = blockEl.children[1] as HTMLElement | undefined;
    if (contentSpan && (contentSpan === target || contentSpan.contains(target))) {
      return {
        element: contentSpan,
        blockId,
        label: getListItemLabel(contentSpan),
        isCodeBlock: false,
      };
    }
    // Clicked on the bullet area — still target the content span
    if (contentSpan) {
      return {
        element: contentSpan,
        blockId,
        label: getListItemLabel(contentSpan),
        isCodeBlock: false,
      };
    }
  }

  // Fall back to the full block
  return {
    element: blockEl,
    blockId,
    label: getBlockLabel(blockEl),
    isCodeBlock: false,
  };
}

function getInlineLabel(el: HTMLElement, text: string): string {
  switch (el.tagName) {
    case 'STRONG': return `bold: "${truncate(text, 30)}"`;
    case 'EM': return `italic: "${truncate(text, 30)}"`;
    case 'A': return `link: "${truncate(text, 25)}"`;
    default: return truncate(text, 30);
  }
}

function getBlockLabel(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const text = el.textContent?.trim() || '';

  if (el.querySelector('table')) return 'table';
  if (el.dataset.blockType === 'heading' || /^h[1-6]$/.test(tag)) {
    return `heading: "${truncate(text, 35)}"`;
  }
  if (tag === 'blockquote') return `blockquote: "${truncate(text, 30)}"`;
  if (tag === 'p') return text ? `paragraph: "${truncate(text, 35)}"` : 'paragraph';
  return truncate(text, 35) || tag;
}

function getListItemLabel(contentSpan: HTMLElement): string {
  const text = contentSpan.textContent?.trim() || '';
  return text ? `list item: "${truncate(text, 30)}"` : 'list item';
}

function getCodeBlockLabel(blockEl: HTMLElement): string {
  const codeEl = blockEl.querySelector('code');
  const lang = codeEl?.className?.match(/language-(\S+)/)?.[1];
  return lang ? `code block (${lang})` : 'code block';
}

/** Find the table row whose bounding box contains the given Y coordinate */
function findRowAtY(tableEl: HTMLTableElement, clientY: number): HTMLTableRowElement | null {
  const rows = tableEl.querySelectorAll('tr');
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      return row;
    }
  }
  return null;
}

/** Human-readable label for a table row */
function getRowLabel(row: HTMLTableRowElement): string {
  // Header row
  if (row.querySelector('th')) return 'table header row';
  // Body row — use first cell text as hint
  const firstCell = row.querySelector('td');
  const text = firstCell?.textContent?.trim() || '';
  return text ? `row: "${truncate(text, 25)}"` : 'table row';
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}
