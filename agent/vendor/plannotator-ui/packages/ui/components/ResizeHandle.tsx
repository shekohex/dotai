import React from 'react';
import type { ResizeHandleProps as BaseProps } from '../hooks/useResizablePanel';

interface Props extends BaseProps {
  className?: string;
  /**
   * Which panel this handle resizes, not which side of the boundary it's on.
   *
   * The touch-area is an absolutely-positioned child of a `w-0` parent, so
   * its actual width is `parent - left - right`. Because the parent is zero
   * wide, any combination where `left` and `right` cancel produces a 0-px
   * element and the handle becomes undraggable. See issue #354.
   *
   *   'left'  — resizes a left sidebar. Touch area extends slightly into the
   *             sidebar (leftward) and slightly past the boundary (rightward).
   *             12px total: `-left-1` (-4px) + `-right-2` (-8px) → width 12.
   *   'right' — resizes a right panel. Touch area must NOT extend leftward,
   *             because the adjacent content area's overlay scrollbar lives
   *             in that region (right edge of the content, just left of the
   *             boundary). `left-0 -right-3` → width 12, entirely to the
   *             right of the boundary. DO NOT push `left` positive —
   *             `left-3 -right-3` evaluates to width 0 and kills the drag.
   */
  side?: 'left' | 'right';
}

export const ResizeHandle: React.FC<Props> = ({
  isDragging,
  onMouseDown,
  onTouchStart,
  onDoubleClick,
  className,
  side,
}) => (
  <div
    className={`relative w-0 cursor-col-resize flex-shrink-0 group z-10${className ? ` ${className}` : ''}`}
  >
    {/* Visible track — 4px wide, centered on the zero-width layout box */}
    <div className={`absolute inset-y-0 -left-0.5 -right-0.5 transition-colors ${
      isDragging ? 'bg-primary/50' : 'group-hover:bg-border'
    }`} />
    {/* Wider touch area — must never have zero width (see `side` docs). */}
    <div
      className={`absolute inset-y-0 ${
        side === 'left' ? '-right-2 -left-1' :
        side === 'right' ? '-right-3 left-0' :
        '-inset-x-2'
      }`}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      onDoubleClick={onDoubleClick}
    />
  </div>
);
