import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const authorSchema = z
  .object({ login: z.string(), avatarUrl: z.string().nullable() })
  .strict();
export type Author = z.infer<typeof authorSchema>;

export const reviewCommentSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    side: z.enum(["additions", "deletions"]),
    line: z.number().int().nonnegative(),
    text: z.string(),
    author: authorSchema,
    createdAt: z.number(),
  })
  .strict();
export type StoredComment = z.infer<typeof reviewCommentSchema>;

export const verdictSchema = z.enum(["comment", "approve", "request_changes"]);
export type Verdict = z.infer<typeof verdictSchema>;

export const submittedReviewSchema = z
  .object({
    id: z.string(),
    verdict: verdictSchema,
    body: z.string(),
    scope: z.string(),
    author: authorSchema,
    createdAt: z.number(),
    comments: z.array(reviewCommentSchema),
    sentTo: z.string().nullable(),
  })
  .strict();
export type SubmittedReview = z.infer<typeof submittedReviewSchema>;

/** A workspace's review: comments still being written, and the reviews already submitted. Stored on the daemon. */
export const reviewStateSchema = z
  .object({
    pending: z.array(reviewCommentSchema),
    submitted: z.array(submittedReviewSchema),
  })
  .strict();
export type ReviewState = z.infer<typeof reviewStateSchema>;

const newComment = z
  .object({
    path: z.string(),
    side: z.enum(["additions", "deletions"]),
    line: z.number().int().nonnegative(),
    text: z.string().min(1),
  })
  .strict();

export const reviewActionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get") }).strict(),
  z.object({ op: z.literal("add"), comment: newComment }).strict(),
  z.object({ op: z.literal("remove"), id: z.string() }).strict(),
  z.object({ op: z.literal("edit"), id: z.string(), text: z.string().min(1) }).strict(),
  z.object({ op: z.literal("discard") }).strict(),
  z
    .object({
      op: z.literal("submit"),
      verdict: verdictSchema,
      body: z.string(),
      scope: z.string(),
      sentTo: z.string().nullable(),
    })
    .strict(),
]);

export const reviewRpc = defineRpc({
  name: "prism.review",
  input: z.object({ workspaceId: z.string(), action: reviewActionSchema }).strict(),
  output: reviewStateSchema,
});

/** The signed-in GitHub user on the daemon's machine, from the GitHub CLI. Null when `gh` is unavailable. */
export const viewerRpc = defineRpc({
  name: "prism.viewer",
  input: z.object({}).strict(),
  output: z.object({ viewer: authorSchema.nullable() }).strict(),
});
