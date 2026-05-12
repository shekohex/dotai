/**
 * Editor Annotations — ephemeral in-memory store for VS Code editor selections.
 *
 * The VS Code extension POSTs annotations from the editor; the webview app
 * consumes them over SSE with snapshot fallback polling. The array lives in
 * this closure and dies when the server stops. No disk persistence.
 */

import type { EditorAnnotation } from "@plannotator/shared/types";

export type { EditorAnnotation };

type EditorAnnotationEvent =
  | { type: "snapshot"; annotations: EditorAnnotation[] }
  | { type: "add"; annotations: EditorAnnotation[] }
  | { type: "remove"; ids: string[] };

function serializeEditorAnnotationEvent(event: EditorAnnotationEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export interface EditorAnnotationHandler {
  handle: (req: Request, url: URL) => Promise<Response | null>;
}

export function createEditorAnnotationHandler(): EditorAnnotationHandler {
  const annotations: EditorAnnotation[] = [];
  const encoder = new TextEncoder();
  const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  function broadcast(event: EditorAnnotationEvent): void {
    const data = encoder.encode(serializeEditorAnnotationEvent(event));
    for (const controller of subscribers) {
      try {
        controller.enqueue(data);
      } catch {
        subscribers.delete(controller);
      }
    }
  }

  return {
    async handle(req: Request, url: URL): Promise<Response | null> {
      if (url.pathname === "/api/editor-annotations/stream" && req.method === "GET") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              subscribers.add(controller);
              controller.enqueue(
                encoder.encode(
                  serializeEditorAnnotationEvent({ type: "snapshot", annotations }),
                ),
              );
            },
            cancel(controller) {
              subscribers.delete(controller);
            },
          }),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          },
        );
      }

      // GET /api/editor-annotations — return all
      if (url.pathname === "/api/editor-annotations" && req.method === "GET") {
        return Response.json({ annotations });
      }

      // POST /api/editor-annotation — add one
      if (url.pathname === "/api/editor-annotation" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            filePath?: string;
            selectedText?: string;
            lineStart?: number;
            lineEnd?: number;
            comment?: string;
          };

          if (!body.filePath || !body.selectedText || !body.lineStart || !body.lineEnd) {
            return Response.json({ error: "Missing required fields" }, { status: 400 });
          }

          const annotation: EditorAnnotation = {
            id: crypto.randomUUID(),
            filePath: body.filePath,
            selectedText: body.selectedText,
            lineStart: body.lineStart,
            lineEnd: body.lineEnd,
            comment: body.comment,
            createdAt: Date.now(),
          };

          annotations.push(annotation);
          broadcast({ type: "add", annotations: [annotation] });
          return Response.json({ id: annotation.id });
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
      }

      // DELETE /api/editor-annotation?id=xxx — remove one
      if (url.pathname === "/api/editor-annotation" && req.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) {
          return Response.json({ error: "Missing id parameter" }, { status: 400 });
        }
        const idx = annotations.findIndex((a) => a.id === id);
        if (idx !== -1) {
          annotations.splice(idx, 1);
          broadcast({ type: "remove", ids: [id] });
        }
        return Response.json({ ok: true });
      }

      // Not handled
      return null;
    },
  };
}
