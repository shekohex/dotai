import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  reviewStateSchema,
  type Author,
  type ReviewState,
  type StoredComment,
} from "../shared/review.js";
import type { reviewActionSchema } from "../shared/review.js";
import { readViewer } from "./github.js";

const FILE = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "prism-plugin", "reviews.json");
const EMPTY: ReviewState = { pending: [], submitted: [] };
const fileSchema = z.record(z.string(), reviewStateSchema);
const ANONYMOUS: Author = { login: "you", avatarUrl: null };

let loaded: Promise<Record<string, ReviewState>> | null = null;
let writing: Promise<void> = Promise.resolve();

function load(): Promise<Record<string, ReviewState>> {
  loaded ??= readFile(FILE, "utf8")
    .then((text) => fileSchema.parse(JSON.parse(text)))
    .catch(() => ({}));
  return loaded;
}

/** Writes are queued and atomic, so concurrent clients never see a torn file. */
function save(all: Record<string, ReviewState>): Promise<void> {
  writing = writing.then(async () => {
    await mkdir(dirname(FILE), { recursive: true });
    const temporary = `${FILE}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(all, null, 2));
    await rename(temporary, FILE);
  });
  return writing;
}

/** Applies a change to the pending comments and to the comments of every submitted review. */
function mapComments(
  state: ReviewState,
  change: (comments: StoredComment[]) => StoredComment[],
): ReviewState {
  return {
    pending: change(state.pending),
    submitted: state.submitted.map((review) => ({ ...review, comments: change(review.comments) })),
  };
}

export async function applyReviewAction(
  workspaceId: string,
  action: z.infer<typeof reviewActionSchema>,
): Promise<ReviewState> {
  const all = await load();
  const current = all[workspaceId] ?? EMPTY;
  if (action.op === "get") return current;

  let next: ReviewState = current;
  switch (action.op) {
    case "add": {
      const author = (await readViewer()) ?? ANONYMOUS;
      const comment: StoredComment = { ...action.comment, id: randomUUID(), author, createdAt: Date.now() };
      next = { ...current, pending: [...current.pending, comment] };
      break;
    }
    case "remove":
      next = mapComments(current, (comments) => comments.filter((comment) => comment.id !== action.id));
      break;
    case "edit":
      next = mapComments(current, (comments) =>
        comments.map((comment) => (comment.id === action.id ? { ...comment, text: action.text } : comment)),
      );
      break;
    case "discard":
      next = { ...current, pending: [] };
      break;
    case "submit": {
      const author = (await readViewer()) ?? ANONYMOUS;
      next = {
        pending: [],
        submitted: [
          ...current.submitted,
          {
            id: randomUUID(),
            verdict: action.verdict,
            body: action.body,
            scope: action.scope,
            author,
            createdAt: Date.now(),
            comments: current.pending,
            sentTo: action.sentTo,
          },
        ],
      };
      break;
    }
  }
  all[workspaceId] = next;
  await save(all);
  return next;
}
