/**
 * Editor annotation handler (in-memory store for VS Code integration). EditorAnnotation type,
 * createEditorAnnotationHandler
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { json, parseBody } from "./helpers.js";

type EditorAnnotationEvent =
  | { type: "snapshot"; annotations: EditorAnnotation[] }
  | { type: "add"; annotations: EditorAnnotation[] }
  | { type: "remove"; ids: string[] };

function serializeSseEvent(event: EditorAnnotationEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export interface EditorAnnotation {
  id: string;
  filePath: string;
  selectedText: string;
  lineStart: number;
  lineEnd: number;
  side?: "old" | "new";
  comment?: string;
  author?: string;
  source?: string;
  severity?: string;
  reasoning?: string;
  kind?: string;
  title?: string;
  createdAt: number;
}

export type EditorAnnotationInput = Omit<EditorAnnotation, "id" | "createdAt">;

const EditorAnnotationCreateBodySchema = Type.Object(
  {
    filePath: Type.String(),
    selectedText: Type.String(),
    lineStart: Type.Number(),
    lineEnd: Type.Number(),
    side: Type.Optional(Type.Union([Type.Literal("old"), Type.Literal("new")])),
    comment: Type.Optional(Type.String()),
    author: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    severity: Type.Optional(Type.String()),
    reasoning: Type.Optional(Type.String()),
    kind: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const EditorAnnotationBatchSchema = Type.Object(
  {
    annotations: Type.Array(EditorAnnotationCreateBodySchema),
  },
  { additionalProperties: false },
);

function buildEditorAnnotation(input: EditorAnnotationInput): EditorAnnotation {
  return {
    id: randomUUID(),
    filePath: input.filePath,
    selectedText: input.selectedText,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    side: input.side,
    comment: input.comment,
    author: input.author,
    source: input.source,
    severity: input.severity,
    reasoning: input.reasoning,
    kind: input.kind,
    title: input.title,
    createdAt: Date.now(),
  };
}

export function createEditorAnnotationHandler() {
  const annotations: EditorAnnotation[] = [];
  const subscribers = new Set<ServerResponse>();

  function broadcast(event: EditorAnnotationEvent): void {
    const payload = serializeSseEvent(event);
    for (const subscriber of subscribers) {
      try {
        subscriber.write(payload);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  }

  return {
    addAnnotations(input: { annotations: Array<Omit<EditorAnnotation, "id" | "createdAt">> }) {
      if (!Value.Check(EditorAnnotationBatchSchema, input)) {
        return { error: "Invalid editor annotations" };
      }
      const parsed = Value.Parse(EditorAnnotationBatchSchema, input);
      const created = parsed.annotations.map((annotation) => buildEditorAnnotation(annotation));
      annotations.push(...created);
      broadcast({ type: "add", annotations: created });
      return { annotations: created };
    },
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (url.pathname === "/api/editor-annotations/stream" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(serializeSseEvent({ type: "snapshot", annotations }));
        subscribers.add(res);
        req.on("close", () => {
          subscribers.delete(res);
        });
        return true;
      }

      if (url.pathname === "/api/editor-annotations" && req.method === "GET") {
        json(res, { annotations });
        return true;
      }

      if (url.pathname === "/api/editor-annotation" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          if (!Value.Check(EditorAnnotationCreateBodySchema, body)) {
            json(res, { error: "Missing required fields" }, 400);
            return true;
          }
          const parsedBody = Value.Parse(EditorAnnotationCreateBodySchema, body);

          const annotation = buildEditorAnnotation(parsedBody);

          annotations.push(annotation);
          broadcast({ type: "add", annotations: [annotation] });
          json(res, { id: annotation.id });
        } catch {
          json(res, { error: "Invalid JSON" }, 400);
        }
        return true;
      }

      if (url.pathname === "/api/editor-annotation" && req.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (id === null || id.length === 0) {
          json(res, { error: "Missing id parameter" }, 400);
          return true;
        }
        const idx = annotations.findIndex((annotation) => annotation.id === id);
        if (idx !== -1) {
          annotations.splice(idx, 1);
          broadcast({ type: "remove", ids: [id] });
        }
        json(res, { ok: true });
        return true;
      }

      return false;
    },
  };
}
