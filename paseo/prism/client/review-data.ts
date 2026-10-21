import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import type { ReviewComment } from "../shared/pierre-api.js";
import {
  reviewRpc,
  viewerRpc,
  type ReviewState,
  type Verdict,
} from "../shared/review.js";

const REVIEW_POLL_MS = 5_000;
const NO_REVIEW: ReviewState = { pending: [], submitted: [] };

/** The GitHub user on the daemon's machine; undefined while loading, null when `gh` is not signed in. */
export function useViewer() {
  const viewer = useRpc(viewerRpc);
  return useQuery({
    queryKey: ["prism", "viewer"],
    queryFn: async () => (await viewer({})).viewer,
    staleTime: 10 * 60_000,
  }).data;
}

/** A workspace's review as stored on the daemon, so every client sees the same comments. */
export function useReview(workspaceId: string) {
  const review = useRpc(reviewRpc);
  const query = useQuery({
    queryKey: ["prism", "review", workspaceId],
    queryFn: () => review({ workspaceId, action: { op: "get" } }),
    refetchInterval: REVIEW_POLL_MS,
    staleTime: 2_000,
  });
  const state = query.data ?? NO_REVIEW;
  const comments = useMemo<ReviewComment[]>(
    () => [
      ...state.submitted.flatMap((submitted) =>
        submitted.comments.map((comment) => ({ ...comment, pending: false })),
      ),
      ...state.pending.map((comment) => ({ ...comment, pending: true })),
    ],
    [state],
  );
  return { state, comments };
}

export function useReviewActions(workspaceId: string) {
  const review = useRpc(reviewRpc);
  const client = useQueryClient();
  const key = ["prism", "review", workspaceId];
  const run = useMutation({
    mutationFn: (action: Parameters<typeof review>[0]["action"]) => review({ workspaceId, action }),
    onSuccess: (state) => client.setQueryData(key, state),
  });
  return {
    add: (comment: { path: string; side: ReviewComment["side"]; line: number; text: string }) =>
      run.mutateAsync({ op: "add", comment }),
    remove: (id: string) => run.mutateAsync({ op: "remove", id }),
    edit: (id: string, text: string) => run.mutateAsync({ op: "edit", id, text }),
    discard: () => run.mutateAsync({ op: "discard" }),
    submit: (input: { verdict: Verdict; body: string; scope: string; sentTo: string | null }) =>
      run.mutateAsync({ op: "submit", ...input }),
    busy: run.isPending,
  };
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  comment: "Commented",
  approve: "Approved",
  request_changes: "Requested changes",
};

/** What the review looks like at a glance: the newest verdict, or a pending review. */
export function reviewSummary(state: ReviewState): { kind: "none" | "pending" | Verdict; text: string } {
  if (state.pending.length > 0) {
    const count = state.pending.length;
    return { kind: "pending", text: `Pending review · ${count} ${count === 1 ? "comment" : "comments"}` };
  }
  const latest = state.submitted[state.submitted.length - 1];
  if (!latest) return { kind: "none", text: "" };
  return { kind: latest.verdict, text: `${VERDICT_LABEL[latest.verdict]} by ${latest.author.login}` };
}

/** Review comments per file path, for badges next to files. */
export function useCommentCounts(workspaceId: string): Readonly<Record<string, number>> {
  const { comments } = useReview(workspaceId);
  return useMemo(() => {
    const counts: Record<string, number> = {};
    for (const comment of comments) counts[comment.path] = (counts[comment.path] ?? 0) + 1;
    return counts;
  }, [comments]);
}
