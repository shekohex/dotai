import { useState, useEffect, useCallback, useRef } from 'react';
import type { EditorAnnotation } from '../types';

const POLL_INTERVAL = 500;
const STREAM_URL = '/api/editor-annotations/stream';
const SNAPSHOT_URL = '/api/editor-annotations';

type EditorAnnotationEvent =
  | { type: 'snapshot'; annotations: EditorAnnotation[] }
  | { type: 'add'; annotations: EditorAnnotation[] }
  | { type: 'remove'; ids: string[] };

interface UseEditorAnnotationsReturn {
  editorAnnotations: EditorAnnotation[];
  deleteEditorAnnotation: (id: string) => void;
}

/**
 * Polls the server for editor annotations.
 */
export function useEditorAnnotations(
  options?: { enabled?: boolean },
): UseEditorAnnotationsReturn {
  const enabled = options?.enabled ?? true;
  const [annotations, setAnnotations] = useState<EditorAnnotation[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fallbackRef = useRef(false);
  const receivedSnapshotRef = useRef(false);

  const fetchAnnotations = useCallback(async () => {
    try {
      const res = await fetch(SNAPSHOT_URL);
      if (!res.ok) return;
      const data = await res.json();
      const incoming: EditorAnnotation[] = data.annotations ?? [];
      setAnnotations((prev) => {
        if (prev.length === incoming.length && prev.every((a, i) => a.id === incoming[i].id)) return prev;
        return incoming;
      });
    } catch {
      // Silently fail — next poll will retry
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fallbackRef.current = false;
    receivedSnapshotRef.current = false;
    const eventSource = new EventSource(STREAM_URL);

    eventSource.onmessage = (event) => {
      if (cancelled) return;

      try {
        const parsed: EditorAnnotationEvent = JSON.parse(event.data);
        switch (parsed.type) {
          case 'snapshot':
            receivedSnapshotRef.current = true;
            setAnnotations(parsed.annotations);
            break;
          case 'add':
            setAnnotations((prev) => [...prev, ...parsed.annotations]);
            break;
          case 'remove':
            setAnnotations((prev) => prev.filter((annotation) => !parsed.ids.includes(annotation.id)));
            break;
        }
      } catch {
        // Ignore malformed events
      }
    };

    eventSource.onerror = () => {
      if (!receivedSnapshotRef.current && !fallbackRef.current) {
        fallbackRef.current = true;
        eventSource.close();
        fetchAnnotations();
        intervalRef.current = setInterval(fetchAnnotations, POLL_INTERVAL);
      }
    };

    return () => {
      cancelled = true;
      eventSource.close();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, fetchAnnotations]);

  const deleteEditorAnnotation = useCallback(async (id: string) => {
    try {
      await fetch(`/api/editor-annotation?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // Silently fail — next poll will reconcile
    }
  }, []);

  return { editorAnnotations: annotations, deleteEditorAnnotation };
}
