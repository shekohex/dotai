import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { ReviewComment } from "../shared/pierre-api.js";
import type { Author } from "../shared/review.js";
import { Avatar } from "./review-screen.js";
import type { Typography } from "./styling.js";
import { withAlpha } from "./styling.js";

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function Editor({
  theme,
  typo,
  compact,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  theme: PluginTheme;
  typo: Typography;
  compact: boolean;
  initial: string;
  submitLabel: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const empty = text.trim() === "";
  return (
    <View style={{ gap: 8, padding: 10 }}>
      <TextInput
        autoFocus
        multiline
        value={text}
        onChangeText={setText}
        placeholder="Leave a comment"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          minHeight: 72,
          padding: 8,
          textAlignVertical: "top",
          color: theme.colors.foreground,
          fontSize: typo.ui,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 6,
          backgroundColor: theme.colors.surface0,
        }}
      />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Pressable accessibilityRole="button" onPress={onCancel} style={{ padding: compact ? 10 : 6 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: typo.ui }}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={empty}
          onPress={() => onSubmit(text.trim())}
          style={{
            paddingHorizontal: 12,
            paddingVertical: compact ? 10 : 6,
            borderRadius: 6,
            backgroundColor: theme.colors.statusSuccess,
            opacity: empty ? 0.4 : 1,
          }}
        >
          <Text style={{ color: theme.colors.surface0, fontSize: typo.ui, fontWeight: "700" }}>{submitLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Card({ theme, header, children }: { theme: PluginTheme; header: React.ReactNode; children: React.ReactNode }) {
  return (
    <View
      style={{
        marginVertical: 6,
        marginHorizontal: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 6,
          backgroundColor: theme.colors.surface1,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        {header}
      </View>
      {children}
    </View>
  );
}

/** A review comment under a diff line, with Edit and Delete. */
export const NativeComment = memo(function NativeComment({
  theme,
  typo,
  compact,
  comment,
  onEdit,
  onRemove,
}: {
  theme: PluginTheme;
  typo: Typography;
  compact: boolean;
  comment: ReviewComment;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const header = (
    <>
      <Avatar theme={theme} author={comment.author} size={20} />
      <Text style={{ color: theme.colors.foreground, fontSize: typo.ui, fontWeight: "600" }}>{comment.author.login}</Text>
      <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: typo.small }}>{ago(comment.createdAt)}</Text>
      {comment.pending ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: typo.small }}>Pending</Text>
      ) : null}
    </>
  );
  if (editing) {
    return (
      <Card theme={theme} header={header}>
        <Editor
          theme={theme}
          typo={typo}
          compact={compact}
          initial={comment.text}
          submitLabel="Save"
          onSubmit={(text) => {
            onEdit(comment.id, text);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </Card>
    );
  }
  return (
    <Card theme={theme} header={header}>
      <Text selectable style={{ padding: 10, color: theme.colors.foreground, fontSize: typo.ui }}>
        {comment.text}
      </Text>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 6, paddingBottom: 6 }}>
        <Pressable accessibilityRole="button" onPress={() => setEditing(true)} style={{ padding: compact ? 10 : 6 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: typo.small }}>Edit</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => onRemove(comment.id)} style={{ padding: compact ? 10 : 6 }}>
          <Text style={{ color: withAlpha(theme.colors.statusDanger, 0.9), fontSize: typo.small }}>Delete</Text>
        </Pressable>
      </View>
    </Card>
  );
});

/** The editor for a new comment, opened by tapping a diff line. */
export const NativeDraft = memo(function NativeDraft({
  theme,
  typo,
  compact,
  viewer,
  onAdd,
  onCancel,
}: {
  theme: PluginTheme;
  typo: Typography;
  compact: boolean;
  viewer: Author | null;
  onAdd: (text: string) => void;
  onCancel: () => void;
}) {
  const author: Author = viewer ?? { login: "You", avatarUrl: null };
  return (
    <Card
      theme={theme}
      header={
        <>
          <Avatar theme={theme} author={author} size={20} />
          <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: typo.ui, fontWeight: "600" }}>{author.login}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: typo.small }}>Draft</Text>
        </>
      }
    >
      <Editor
        theme={theme}
        typo={typo}
        compact={compact}
        initial=""
        submitLabel="Add review comment"
        onSubmit={onAdd}
        onCancel={onCancel}
      />
    </Card>
  );
});
