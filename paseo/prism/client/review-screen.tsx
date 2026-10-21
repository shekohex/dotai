import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";

import type { Author, ReviewState, StoredComment, Verdict } from "../shared/review.js";
import { reviewSummary, useReviewActions, VERDICT_LABEL } from "./review-data.js";
import { withAlpha, type Typography } from "./styling.js";

const VERDICTS: { verdict: Verdict; icon: string; title: string; hint: string }[] = [
  { verdict: "comment", icon: "MessageSquare", title: "Comment", hint: "Submit general feedback without explicit approval." },
  { verdict: "approve", icon: "Check", title: "Approve", hint: "Submit feedback and approve these changes." },
  { verdict: "request_changes", icon: "X", title: "Request changes", hint: "Submit feedback that must be addressed." },
];

export function verdictColor(theme: PluginTheme, kind: Verdict | "pending" | "none"): string {
  switch (kind) {
    case "approve":
      return theme.colors.statusSuccess;
    case "request_changes":
      return theme.colors.statusDanger;
    case "pending":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function formatReview(
  verdict: Verdict,
  body: string,
  comments: readonly StoredComment[],
  scope: string,
): string {
  const lines = comments.map(
    (comment) =>
      `- ${comment.path}:${comment.line} (${comment.side === "additions" ? "new" : "old"} side)\n  ${comment.text.replace(/\n/g, "\n  ")}`,
  );
  const header = {
    comment: "Review comments on the changes",
    approve: "Review: approved",
    request_changes: "Review: changes requested. Please address every comment",
  }[verdict];
  return [`${header} (${scope}).`, body.trim(), lines.join("\n")].filter((part) => part !== "").join("\n\n");
}

export function Avatar({ theme, author, size }: { theme: PluginTheme; author: Author; size: number }) {
  if (author.avatarUrl) {
    return <Image source={{ uri: author.avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: size * 0.5 }}>
        {author.login.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Review status at a glance: who reviewed, and whether it is pending, approved or has changes requested. */
export function ReviewBar({
  theme,
  typo,
  state,
  viewer,
  onPress,
}: {
  theme: PluginTheme;
  typo: Typography;
  state: ReviewState;
  viewer: Author | null | undefined;
  onPress: () => void;
}) {
  const summary = reviewSummary(state);
  if (summary.kind === "none") return null;
  const latest = state.submitted[state.submitted.length - 1];
  const author = summary.kind === "pending" ? viewer : latest?.author;
  const color = verdictColor(theme, summary.kind);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open review"
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: withAlpha(color, 0.12),
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      {author ? <Avatar theme={theme} author={author} size={18} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, color, fontSize: typo.ui, fontWeight: "600" }}>
        {summary.text}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: typo.small }}>
        {summary.kind === "pending" ? "Finish review" : "Review"}
      </Text>
      <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

/** Every comment of the review, grouped by file; choosing one jumps to its lines in the diff. */
function CommentList({
  theme,
  typo,
  state,
  onGoToComment,
}: {
  theme: PluginTheme;
  typo: Typography;
  state: ReviewState;
  onGoToComment: (comment: StoredComment) => void;
}) {
  const pendingIds = new Set(state.pending.map((comment) => comment.id));
  const all = [...state.submitted.flatMap((review) => review.comments), ...state.pending];
  if (all.length === 0) return null;
  const byPath = new Map<string, StoredComment[]>();
  for (const comment of all) byPath.set(comment.path, [...(byPath.get(comment.path) ?? []), comment]);
  return (
    <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 14 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: typo.ui, fontWeight: "600" }}>
        {`Comments (${all.length})`}
      </Text>
      {[...byPath].map(([path, comments]) => (
        <View key={path} style={{ gap: 4 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: typo.small }}>{path}</Text>
          {comments.map((comment) => (
            <Pressable
              key={comment.id}
              accessibilityRole="button"
              accessibilityLabel={`Go to ${path} line ${comment.line}`}
              onPress={() => onGoToComment(comment)}
              style={{
                flexDirection: "row",
                gap: 8,
                alignItems: "center",
                padding: 8,
                borderRadius: 8,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <Avatar theme={theme} author={comment.author} size={18} />
              <Text numberOfLines={2} style={{ flex: 1, color: theme.colors.foreground, fontSize: typo.ui }}>
                {comment.text}
              </Text>
              {pendingIds.has(comment.id) ? (
                <Text style={{ color: theme.colors.statusWarning, fontSize: typo.small }}>Pending</Text>
              ) : null}
              <Text style={{ color: theme.colors.accent, fontSize: typo.small }}>{`L${comment.line}`}</Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

/** GitHub's "Finish your review" form, and the history of submitted reviews. */
export function ReviewScreen({
  theme,
  compact,
  typo,
  workspaceId,
  state,
  scope,
  onClose,
  onGoToComment,
}: {
  theme: PluginTheme;
  compact: boolean;
  typo: Typography;
  workspaceId: string;
  state: ReviewState;
  scope: string;
  onClose: () => void;
  onGoToComment: (comment: StoredComment) => void;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const actions = useReviewActions(workspaceId);
  const [verdict, setVerdict] = useState<Verdict>("comment");
  const [body, setBody] = useState("");
  const [agentId, setAgentId] = useState<string | null | undefined>(undefined);
  const agents = useQuery({
    queryKey: ["prism", "agents", workspaceId],
    queryFn: async () => {
      const { entries } = await paseo.agents.list();
      return entries
        .map(({ agent }) => agent)
        .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt);
    },
  });
  const chosenAgent = agentId === undefined ? (agents.data?.[0]?.id ?? null) : agentId;
  const pending = state.pending;
  const canSubmit = !actions.busy && (pending.length > 0 || body.trim() !== "" || verdict === "approve");

  const submit = async () => {
    try {
      await actions.submit({ verdict, body, scope, sentTo: chosenAgent });
      if (chosenAgent) await paseo.agents.ref(chosenAgent).send(formatReview(verdict, body, pending, scope));
      toast.show(chosenAgent ? "Review submitted and sent" : "Review submitted");
      onClose();
    } catch (error) {
      toast.error(`Could not submit review: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const muted = { color: theme.colors.foregroundMuted, fontSize: typo.small } as const;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: typo.ui + 2, fontWeight: "600" }}>
          Finish your review
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close review" onPress={onClose} hitSlop={8}>
          <Icon name="X" size={18} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      <Text style={muted}>
        {`${pending.length} pending ${pending.length === 1 ? "comment" : "comments"} · ${scope}`}
      </Text>
      <TextInput
        value={body}
        onChangeText={setBody}
        multiline
        placeholder="Leave a comment"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          minHeight: 90,
          padding: 10,
          textAlignVertical: "top",
          color: theme.colors.foreground,
          fontSize: typo.ui,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
        }}
      />
      <View style={{ gap: 6 }}>
        {VERDICTS.map((option) => {
          const selected = option.verdict === verdict;
          return (
            <Pressable
              key={option.verdict}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => setVerdict(option.verdict)}
              style={{
                flexDirection: "row",
                gap: 10,
                alignItems: "center",
                padding: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: selected ? verdictColor(theme, option.verdict === "comment" ? "none" : option.verdict) : theme.colors.border,
                backgroundColor: selected ? theme.colors.surface1 : "transparent",
              }}
            >
              <Icon
                name={option.icon}
                size={16}
                color={verdictColor(theme, option.verdict === "comment" ? "none" : option.verdict)}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: typo.ui, fontWeight: "600" }}>{option.title}</Text>
                <Text style={muted}>{option.hint}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      <View style={{ gap: 6 }}>
        <Text style={muted}>Send to agent</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {[{ id: null, title: "Don't send" }, ...(agents.data ?? []).map((agent) => ({ id: agent.id, title: agent.title ?? agent.id }))].map(
            (option) => {
              const selected = option.id === chosenAgent;
              return (
                <Pressable
                  key={option.id ?? "none"}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => setAgentId(option.id)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: compact ? 8 : 4,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: selected ? theme.colors.accent : theme.colors.border,
                    backgroundColor: selected ? withAlpha(theme.colors.accent, 0.18) : "transparent",
                  }}
                >
                  <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: typo.small }}>
                    {option.title}
                  </Text>
                </Pressable>
              );
            },
          )}
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end", alignItems: "center" }}>
        {pending.length > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => void actions.discard()} style={{ padding: 8 }}>
            <Text style={{ color: theme.colors.statusDanger, fontSize: typo.ui }}>Discard pending</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!canSubmit}
          onPress={() => void submit()}
          style={{
            paddingHorizontal: 14,
            paddingVertical: compact ? 12 : 7,
            borderRadius: 8,
            backgroundColor: theme.colors.statusSuccess,
            opacity: canSubmit ? 1 : 0.4,
          }}
        >
          <Text style={{ color: theme.colors.surface0, fontSize: typo.ui, fontWeight: "700" }}>Submit review</Text>
        </Pressable>
      </View>

      <CommentList theme={theme} typo={typo} state={state} onGoToComment={onGoToComment} />

      {state.submitted.length > 0 ? (
        <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 14 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: typo.ui, fontWeight: "600" }}>Reviews</Text>
          {[...state.submitted].reverse().map((review) => {
            const color = verdictColor(theme, review.verdict);
            return (
              <View
                key={review.id}
                style={{ gap: 6, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Avatar theme={theme} author={review.author} size={20} />
                  <Text style={{ color: theme.colors.foreground, fontSize: typo.ui, fontWeight: "600" }}>{review.author.login}</Text>
                  <Text style={{ flex: 1, color, fontSize: typo.small, fontWeight: "600" }}>{VERDICT_LABEL[review.verdict]}</Text>
                  <Text style={muted}>{ago(review.createdAt)}</Text>
                </View>
                {review.body !== "" ? (
                  <Text selectable style={{ color: theme.colors.foreground, fontSize: typo.ui }}>{review.body}</Text>
                ) : null}
                <Text style={muted}>
                  {`${review.comments.length} ${review.comments.length === 1 ? "comment" : "comments"} · ${review.scope}`}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </ScrollView>
  );
}
