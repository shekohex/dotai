import React from 'react';
import type { EditorAnnotation } from '../types';

interface EditorAnnotationCardProps {
  annotation: EditorAnnotation;
  onDelete: () => void;
  onSelect?: () => void;
  selected?: boolean;
}

export const EditorAnnotationCard: React.FC<EditorAnnotationCardProps> = ({
  annotation,
  onDelete,
  onSelect,
  selected = false,
}) => {
  const lineRange = annotation.lineStart === annotation.lineEnd
    ? `L${annotation.lineStart}`
    : `L${annotation.lineStart}-${annotation.lineEnd}`;
  const severityClass =
    annotation.severity === 'important'
      ? 'bg-destructive'
      : annotation.severity === 'nit'
        ? 'bg-amber-500'
        : annotation.severity === 'pre_existing'
          ? 'bg-muted-foreground'
          : null;

  return (
    <div
      className={`group relative p-2.5 rounded border cursor-pointer transition-colors duration-150 ${
        selected
          ? 'bg-primary/5 border-primary/30'
          : 'border-transparent hover:bg-muted/50 hover:border-border/50'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono text-muted-foreground truncate" title={annotation.filePath}>
            {annotation.filePath}:{lineRange}
          </span>
          {severityClass && <span className={`w-2 h-2 rounded-full flex-shrink-0 ${severityClass}`} />}
          {annotation.author && (
            <span className="text-[10px] truncate max-w-[100px] text-muted-foreground/70">
              {annotation.author}
            </span>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          title="Delete annotation"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {annotation.comment && (
        <div className="text-xs text-foreground/80 whitespace-pre-wrap">
          {annotation.comment}
        </div>
      )}
      {annotation.reasoning && (
        <div className="text-[11px] text-muted-foreground/60 leading-relaxed mt-1.5 whitespace-pre-wrap">
          {annotation.reasoning}
        </div>
      )}
    </div>
  );
};
