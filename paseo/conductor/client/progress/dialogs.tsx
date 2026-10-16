/**
 * One dialog for a ticket or a question and everything opened from it, plus file previews
 * with Previous and Next. Ported from the Progress plugin by Steve Castaneda (MIT,
 * https://github.com/stevecastaneda/paseo-plugins/tree/main/progress). Questions are
 * answered here directly instead of copied to the clipboard.
 */
import {
  openExternalUrl,
  type PluginWorkspacePanelProps,
  useRpc,
} from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  Modal,
  ScrollView,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, Text, View } from "react-native";

import {
  type Attachment,
  attachmentIcon,
  canPreview,
  fileAttachment,
  isLink,
  previewKind,
  shortName,
} from "../../shared/attachments.js";
import {
  type Dashboard,
  type DashboardTicket,
  ticketLine,
  ticketTimeline,
  workedMinutes,
} from "../../shared/dashboard.js";
import { formatTicketTime } from "../../shared/format.js";
import {
  type ActivityItem,
  answeredByLabel,
  answerQuestionRpc,
  choiceKeys,
  previewTargetRpc,
  type Question,
  shareTargetRpc,
  ticketFraction,
} from "../../shared/progress.js";
import { isMarkdown } from "../../shared/markdown.js";
import { errorMessage } from "../errors.js";
import {
  ActivityDetail,
  ActivityRow,
  Chip,
  PercentBar,
  TimelineRail,
} from "./feed.js";
import { Markdown } from "./markdown.js";
import {
  type Colors,
  FONT,
  imageOutline,
  LINE,
  NarrowProvider,
  PressableRow,
  PressScale,
  raised,
  StatusBadge,
  type TabEntry,
  TabStrip,
  text,
  useLastPresent,
  When,
} from "./ui.js";
import { useAgentSnapshot } from "../data.js";
import { LinkedSection } from "./links.js";
import { MentionProvider, MentionSpans } from "./mentions.js";

export type Navigation = PluginWorkspacePanelProps["navigation"];

export type Step =
  | { kind: "ticket"; id: string }
  | { kind: "question"; id: string }
  /** `id` is activityKey(item). */
  | { kind: "activity"; id: string }
  | { kind: "preview"; attachment: Attachment; group: Attachment[] };

/** Opens attachments the same way everywhere: links in Paseo's browser, files in a preview or on the host. */
export function useAttachmentOpener({
  conductorId,
  workspaceId,
  navigation,
  onPreview,
}: {
  conductorId: string;
  workspaceId?: string;
  navigation?: Navigation;
  onPreview?(attachment: Attachment): void;
}) {
  const toast = useToast();
  const shareRpc = useRpc(shareTargetRpc);
  async function openUrl(url: string) {
    if (navigation?.openBrowser && workspaceId)
      navigation.openBrowser({ url, workspaceId });
    else await openExternalUrl(url);
  }
  /**
   * Opens it outside the app: a link as is, a file on a temporary media page (video, audio, PDF,
   * ...), a folder on the machine running Paseo.
   */
  async function openOutside(attachment: Attachment) {
    try {
      const result = await shareRpc({ conductorId, target: attachment.target });
      if (result.kind === "url") await openUrl(result.url);
      else toast.show(`Opened ${attachment.title}`, { variant: "success" });
    } catch (error) {
      await copyText(attachment.target).catch(() => undefined);
      toast.show(`${errorMessage(error)}. Copied the path`, {
        variant: "warning",
      });
    }
  }
  async function open(attachment: Attachment) {
    if (isLink(attachment.target)) {
      try {
        await openUrl(attachment.target);
      } catch {
        toast.error("Could not open this link.");
      }
      return;
    }
    if (onPreview && canPreview(attachment)) {
      onPreview(attachment);
      return;
    }
    await openOutside(attachment);
  }
  async function copyPath(attachment: Attachment) {
    try {
      await copyText(attachment.target);
      toast.show("Copied path", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the path and use Copy.");
    }
  }
  return { open, openOutside, copyPath };
}

/** Attachments as pressable rows; the press also hands over the list for Previous and Next. */
export function AttachmentList({
  colors,
  attachments,
  onOpen,
  onSurface1 = true,
}: {
  colors: Colors;
  attachments: Attachment[];
  onOpen(attachment: Attachment, group: Attachment[]): void;
  onSurface1?: boolean;
}) {
  if (!attachments.length) return null;
  return (
    <View style={{ gap: 2 }}>
      {attachments.map((attachment) => (
        <PressableRow
          key={attachment.target}
          colors={colors}
          onSurface1={onSurface1}
          accessibilityRole={isLink(attachment.target) ? "link" : "button"}
          accessibilityLabel={`Open ${attachment.title}`}
          onPress={() => onOpen(attachment, attachments)}
          style={{
            flexDirection: "row",
            gap: 8,
            alignItems: "center",
            paddingVertical: 5,
            paddingHorizontal: 6,
            marginHorizontal: -6,
            borderRadius: 6,
          }}
        >
          <View style={{ width: 16, alignItems: "center" }}>
            <Icon
              name={attachmentIcon(attachment)}
              size={14}
              color={colors.foregroundMuted}
            />
          </View>
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 1,
              color: colors.foreground,
              fontSize: FONT.secondary,
              lineHeight: LINE.secondary,
            }}
          >
            {attachment.title}
          </Text>
          {shortName(attachment) !== attachment.title ? (
            <Text
              numberOfLines={1}
              style={[text(colors).small, { flex: 1, minWidth: 0 }]}
            >
              {shortName(attachment)}
            </Text>
          ) : (
            <View style={{ flex: 1 }} />
          )}
        </PressableRow>
      ))}
    </View>
  );
}

export function deliverableAttachments(
  deliverables: Dashboard["deliverables"],
): Attachment[] {
  return deliverables.map((item) => ({
    target: item.target,
    title: item.label,
  }));
}

/**
 * One dialog for a ticket or question and everything opened from it. Paseo gives each dialog its
 * own backdrop, so the content changes in place and Back returns to the step before.
 */
export function StackedDialog({
  colors,
  conductorId,
  root,
  onClose,
  dashboard,
  now,
  live = true,
  workspaceId,
  navigation,
}: {
  colors: Colors;
  conductorId: string;
  root: Step | null;
  onClose(): void;
  dashboard: Dashboard;
  now: number;
  live?: boolean;
  workspaceId?: string;
  navigation?: Navigation;
}) {
  const [trail, setTrail] = useState<Step[]>([]);
  const rootKey =
    root && root.kind !== "preview" ? `${root.kind}:${root.id}` : null;
  const [trailFor, setTrailFor] = useState(rootKey);
  if (trailFor !== rootKey) {
    setTrailFor(rootKey);
    if (rootKey) setTrail([]);
  }
  const push = (step: Step) => setTrail((current) => [...current, step]);
  const replaceTop = (step: Step) =>
    setTrail((current) => [...current.slice(0, -1), step]);
  const [group, setGroup] = useState<Attachment[]>([]);
  const opener = useAttachmentOpener({
    conductorId,
    workspaceId,
    navigation,
    onPreview: (attachment) =>
      push({
        kind: "preview",
        attachment,
        group: group.filter(canPreview),
      }),
  });
  const openAttachment = (attachment: Attachment, from: Attachment[]) => {
    setGroup(from);
    if (isLink(attachment.target)) onClose();
    if (canPreview(attachment)) {
      push({ kind: "preview", attachment, group: from.filter(canPreview) });
      return;
    }
    void opener.open(attachment);
  };
  const openAgent = navigation
    ? (agentId: string) => {
        onClose();
        navigation.openAgent({ agentId });
      }
    : undefined;
  const questions = [
    ...dashboard.questions.open,
    ...dashboard.questions.answered,
  ];
  const steps: Step[] = root ? [root, ...trail] : [];
  const shown = useLastPresent(
    steps.length ? { top: steps.at(-1), previous: steps.at(-2) } : null,
  );
  const back = shown?.previous
    ? {
        label: `Back to ${stepName(shown.previous)}`,
        onPress: () => setTrail((current) => current.slice(0, -1)),
      }
    : null;
  const top = shown?.top;
  const ticket =
    top?.kind === "ticket"
      ? dashboard.tickets.find((candidate) => candidate.id === top.id)
      : undefined;
  const question =
    top?.kind === "question"
      ? questions.find((candidate) => candidate.id === top.id)
      : undefined;
  const preview = top?.kind === "preview" ? top : undefined;
  const activityItem =
    top?.kind === "activity"
      ? dashboard.state.activity.find((item) => activityKey(item) === top.id)
      : undefined;
  // The ticket or question it opened on went away (withdrawn, or a new run): close.
  const rootMissing =
    root !== null &&
    (root.kind === "ticket"
      ? !dashboard.tickets.some((candidate) => candidate.id === root.id)
      : root.kind === "question"
        ? !questions.some((candidate) => candidate.id === root.id)
        : false);
  useEffect(() => {
    if (rootMissing) onClose();
  }, [rootMissing]);
  const title = ticket
    ? `${ticket.id} · ${ticket.title}`
    : question
      ? `${question.id} · ${question.title}`
      : preview
        ? preview.attachment.title
        : activityItem
          ? activityItem.title
          : "";
  const icon = ticket
    ? "ListChecks"
    : question
      ? "MessageCircleQuestion"
      : preview
        ? attachmentIcon(preview.attachment)
        : activityItem
          ? "Activity"
          : "ListChecks";

  return (
    <Modal
      title={title}
      icon={<Icon name={icon} size={18} color={colors.foregroundMuted} />}
      open={Boolean(root)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* One Modal.Content for every step: replacing it would re-present the sheet on phones. */}
      <Modal.Content>
        <MentionProvider
          tickets={dashboard.tickets}
          onOpen={(id) => push({ kind: "ticket", id })}
        >
          <NarrowProvider value={false}>
            {preview ? (
              <PreviewContent
                colors={colors}
                conductorId={conductorId}
                attachment={preview.attachment}
                onOpenOnHost={() => {
                  onClose();
                  void opener.openOutside(preview.attachment);
                }}
                backLabel={back?.label}
                onBack={back?.onPress}
                gallery={{
                  items: preview.group,
                  onSelect: (attachment) =>
                    replaceTop({ ...preview, attachment }),
                }}
              />
            ) : null}
            {ticket ? (
              <TicketStoryView
                colors={colors}
                conductorId={conductorId}
                dashboard={dashboard}
                ticket={ticket}
                now={now}
                live={live}
                onOpenAgent={openAgent}
                onOpenAttachment={openAttachment}
                onOpenQuestion={(id) => push({ kind: "question", id })}
                onOpenActivity={(item) =>
                  push({ kind: "activity", id: activityKey(item) })
                }
                onOpenTicket={(id) => push({ kind: "ticket", id })}
              />
            ) : null}
            {ticket && back ? (
              <BackButton
                colors={colors}
                label={back.label}
                onPress={back.onPress}
              />
            ) : null}
            {activityItem ? (
              <View style={{ gap: 16 }}>
                <ActivityDetail
                  colors={colors}
                  item={activityItem}
                  activity={dashboard.state.activity}
                  now={now}
                  conductorId={conductorId}
                  ticketTitle={
                    dashboard.tickets.find(
                      (candidate) => candidate.id === activityItem.ticket,
                    )?.title
                  }
                  onOpenTicket={(id) => push({ kind: "ticket", id })}
                />
                {back ? (
                  <BackButton
                    colors={colors}
                    label={back.label}
                    onPress={back.onPress}
                  />
                ) : null}
              </View>
            ) : null}
            {question ? (
              <QuestionView
                colors={colors}
                conductorId={conductorId}
                question={question}
                now={now}
                onAnswered={onClose}
                onOpenAttachment={openAttachment}
              >
                {back ? (
                  <BackButton
                    colors={colors}
                    label={back.label}
                    onPress={back.onPress}
                  />
                ) : null}
              </QuestionView>
            ) : null}
          </NarrowProvider>
        </MentionProvider>
      </Modal.Content>
    </Modal>
  );
}

function stepName(step: Step): string {
  if (step.kind === "preview") return step.attachment.title;
  return step.kind === "activity" ? "the update" : step.id;
}

/** Feed entries have no id; their time and title tell them apart. */
export function activityKey(item: ActivityItem): string {
  return `${item.ts}|${item.title}`;
}

type StoryTab =
  "write-up" | "timeline" | "activity" | "questions" | "deliverables";
// The tab chosen per ticket, kept for the app session.
const storyTabs = new Map<string, StoryTab>();

/** A ticket's story: status against estimate, who's on it, and tabs for everything tagged to it. */
function TicketStoryView({
  colors,
  conductorId,
  dashboard,
  ticket,
  now,
  live,
  onOpenAttachment,
  onOpenQuestion,
  onOpenActivity,
  onOpenAgent,
  onOpenTicket,
}: {
  colors: Colors;
  conductorId: string;
  dashboard: Dashboard;
  ticket: DashboardTicket;
  now: number;
  live: boolean;
  onOpenAttachment(attachment: Attachment, group: Attachment[]): void;
  onOpenQuestion(id: string): void;
  onOpenActivity(item: ActivityItem): void;
  onOpenAgent?(agentId: string): void;
  onOpenTicket(id: string): void;
}) {
  const steps = ticketTimeline(ticket, now, dashboard.state.activity);
  const fraction = ticketFraction(ticket, now, dashboard.tickets);
  const agents = ticket.agents.length
    ? ticket.agents
    : ticket.by
      ? [ticket.by]
      : [];
  const worked = workedMinutes(steps);
  const estimate = ticket.estimate ?? 0;
  const time = formatTicketTime(
    worked,
    ticket.estimate,
    ticket.status === "done" || ticket.status === "skipped",
  );
  const activity = dashboard.activity.filter(
    (entry) => entry.ticket === ticket.id,
  );
  const questions = [
    ...dashboard.questions.open,
    ...dashboard.questions.answered,
  ]
    .filter((question) => question.ticket === ticket.id)
    .sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt));
  const deliverables = deliverableAttachments(
    dashboard.deliverables.filter((item) => item.ticket === ticket.id),
  );
  const line = ticketLine(ticket, dashboard);
  const detail = ticket.waitingFor
    ? `for ${ticket.waitingFor.map((other) => other.id).join(", ")}`
    : ticket.status === "working"
      ? ticket.stage
      : undefined;
  const source = ticket.source ? fileAttachment(ticket.source) : null;
  const tabs: (TabEntry<StoryTab> & { content: ReactNode })[] = [
    ...(source
      ? [
          {
            id: "write-up" as const,
            label: "Write-up",
            icon: "FileText",
            content: (
              <AttachmentList
                colors={colors}
                attachments={[source]}
                onOpen={onOpenAttachment}
              />
            ),
          },
        ]
      : []),
    {
      id: "timeline",
      label: "Timeline",
      icon: "History",
      count: steps.length,
      content: (
        <TimelineRail
          colors={colors}
          steps={steps}
          now={now}
          live={live}
          conductorId={conductorId}
          waitingLabel={
            ticket.waitingFor
              ? `Waiting for ${ticket.waitingFor.map((other) => other.id).join(", ")}`
              : undefined
          }
          onOpenActivity={onOpenActivity}
        />
      ),
    },
    ...(activity.length
      ? [
          {
            id: "activity" as const,
            label: "Activity",
            icon: "Activity",
            count: activity.length,
            content: (
              <View>
                {activity.map((entry, index) => (
                  <ActivityRow
                    key={`${entry.ts}-${index}`}
                    colors={colors}
                    item={entry}
                    now={now}
                    conductorId={conductorId}
                    showTicket={false}
                    first={index === 0}
                    onPress={() => onOpenActivity(entry)}
                  />
                ))}
              </View>
            ),
          },
        ]
      : []),
    ...(questions.length
      ? [
          {
            id: "questions" as const,
            label: "Questions",
            icon: "MessageCircleQuestion",
            count: questions.length,
            content: (
              <View>
                {questions.map((question) => {
                  const keys = choiceKeys(question.answer?.choice);
                  const chosen = question.options.filter((option) =>
                    keys.includes(option.key),
                  );
                  return (
                    <PressableRow
                      key={question.id}
                      colors={colors}
                      onSurface1
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${question.id}`}
                      onPress={() => onOpenQuestion(question.id)}
                      style={{
                        flexDirection: "row",
                        gap: 10,
                        paddingVertical: 6,
                        paddingHorizontal: 6,
                        marginHorizontal: -6,
                        borderRadius: 6,
                      }}
                    >
                      <Text
                        style={[
                          text(colors).muted,
                          { fontWeight: "600", minWidth: 32 },
                        ]}
                      >
                        {question.id}
                      </Text>
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text style={text(colors).body}>{question.title}</Text>
                        {question.answer ? (
                          <Text style={text(colors).muted}>
                            {answererLabel(question.answer.by, conductorId)}{" "}
                            answered{" "}
                            <Text
                              style={{
                                color: colors.statusSuccess,
                                fontWeight: "600",
                              }}
                            >
                              {keys.length ? keys.join(", ") : "in words"}
                            </Text>
                            {chosen.length ? (
                              <Text style={{ color: colors.foreground }}>
                                :{" "}
                                {chosen
                                  .map((option) => option.label)
                                  .join(", ")}
                              </Text>
                            ) : null}
                          </Text>
                        ) : (
                          <Text
                            style={{
                              ...text(colors).muted,
                              color: colors.accent,
                            }}
                          >
                            Waiting for your answer
                          </Text>
                        )}
                      </View>
                      <View style={{ paddingTop: 3 }}>
                        <Icon
                          name="ChevronRight"
                          size={16}
                          color={colors.foregroundMuted}
                        />
                      </View>
                    </PressableRow>
                  );
                })}
              </View>
            ),
          },
        ]
      : []),
    ...(deliverables.length
      ? [
          {
            id: "deliverables" as const,
            label: "Deliverables",
            icon: "Package",
            count: deliverables.length,
            content: (
              <AttachmentList
                colors={colors}
                attachments={deliverables}
                onOpen={onOpenAttachment}
              />
            ),
          },
        ]
      : []),
  ];
  const [chosen, setChosen] = useState<StoryTab | undefined>(() =>
    storyTabs.get(ticket.id),
  );
  const current = tabs.find((entry) => entry.id === chosen) ?? tabs[0];
  const choose = (id: StoryTab) => {
    storyTabs.set(ticket.id, id);
    setChosen(id);
  };
  return (
    <View style={{ gap: 20 }}>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <StatusBadge
            colors={colors}
            status={ticket.status}
            waiting={Boolean(ticket.waitingFor)}
          />
          <Text
            numberOfLines={1}
            style={[text(colors).body, { flex: 1, minWidth: 0 }]}
          >
            {detail}
          </Text>
        </View>
        {ticket.status === "working" || ticket.status === "blocked" ? (
          <PercentBar
            colors={colors}
            fraction={fraction}
            reported={ticket.percent !== undefined}
          />
        ) : null}
        {worked >= 1 || estimate ? (
          <Text
            style={[
              text(colors).muted,
              {
                fontVariant: ["tabular-nums"],
                color: time.over ? colors.statusDanger : colors.foregroundMuted,
              },
            ]}
          >
            {time.text}
          </Text>
        ) : null}
        {/* One line about what is happening: the live ticker if it is this ticket's, else the note. */}
        {line ? (
          <Text accessibilityLiveRegion="polite" style={text(colors).body}>
            <MentionSpans colors={colors} text={line} />
          </Text>
        ) : null}
        {ticket.labels?.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {ticket.labels.map((label) => (
              <Chip key={label} colors={colors} icon="Tag" label={label} />
            ))}
          </View>
        ) : null}
        {agents.map((agentId) => (
          <AgentRow
            key={agentId}
            colors={colors}
            agentId={agentId}
            onOpen={onOpenAgent}
          />
        ))}
        <LinkedSection
          colors={colors}
          state={dashboard.state}
          ticket={ticket}
          now={now}
          onOpenTicket={onOpenTicket}
          onOpenQuestion={onOpenQuestion}
        />
      </View>
      <View style={{ gap: 12 }}>
        {tabs.length > 1 && current ? (
          <TabStrip
            colors={colors}
            tabs={tabs}
            selected={current.id}
            onSelect={choose}
          />
        ) : null}
        {current?.content}
      </View>
    </View>
  );
}

/** The agent on a ticket, by its chat title; pressing it opens that chat. */
function AgentRow({
  colors,
  agentId,
  onOpen,
}: {
  colors: Colors;
  agentId: string;
  onOpen?(agentId: string): void;
}) {
  const snapshot = useAgentSnapshot(agentId);
  if (!snapshot) return null;
  const agent = {
    title: snapshot.title,
    alert: snapshot.pendingPermissions.length
      ? { text: "Needs your permission", danger: false }
      : snapshot.status === "error"
        ? { text: "Stopped with an error", danger: true }
        : null,
  };
  const title = agent.title?.trim() || "Untitled agent";
  const open = onOpen ? () => onOpen(agentId) : undefined;
  return (
    <PressableRow
      colors={colors}
      onSurface1
      disabled={!open}
      accessibilityRole="button"
      accessibilityLabel={`Open the chat with ${title}`}
      onPress={open}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 4,
        paddingHorizontal: 6,
        marginHorizontal: -6,
        borderRadius: 6,
      }}
    >
      <Icon name="Bot" size={14} color={colors.foregroundMuted} />
      <Text numberOfLines={1} style={[text(colors).muted, { flexShrink: 1 }]}>
        {title}
      </Text>
      {agent.alert ? (
        <Text
          numberOfLines={1}
          style={[
            text(colors).muted,
            {
              flexShrink: 0,
              color: agent.alert.danger
                ? colors.statusDanger
                : colors.statusWarning,
            },
          ]}
        >
          {agent.alert.text}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} />
      {open ? (
        <Text style={[text(colors).muted, { fontWeight: "500" }]}>
          Open chat
        </Text>
      ) : null}
    </PressableRow>
  );
}

/** The agent's pick, under a question with no options to mark. */
export function QuestionState({
  colors,
  question,
}: {
  colors: Colors;
  question: Question;
}) {
  if (question.options.length || !question.recommend || question.answer)
    return null;
  return (
    <Text style={text(colors).muted}>
      Recommended:{" "}
      <Text style={{ color: colors.foreground }}>{question.recommend}</Text>
    </Text>
  );
}

/** A question's text, its answer if any, and the options; `children` go at the end. */
function QuestionView({
  colors,
  conductorId,
  question,
  now,
  onAnswered,
  onOpenAttachment,
  children,
}: {
  colors: Colors;
  conductorId: string;
  question: Question;
  now: number;
  onAnswered(): void;
  onOpenAttachment(attachment: Attachment, group: Attachment[]): void;
  children?: ReactNode;
}) {
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text style={text(colors).body}>
          <MentionSpans colors={colors} text={question.text} />
        </Text>
        <QuestionState colors={colors} question={question} />
      </View>
      {question.answer ? (
        <AnswerSummary
          colors={colors}
          conductorId={conductorId}
          question={question}
          now={now}
        />
      ) : null}
      <QuestionDetail
        colors={colors}
        conductorId={conductorId}
        question={question}
        now={now}
        onSurface1
        onAnswered={onAnswered}
        onOpenAttachment={onOpenAttachment}
      />
      {children}
    </View>
  );
}

function AnswerSummary({
  colors,
  conductorId,
  question,
  now,
}: {
  colors: Colors;
  conductorId: string;
  question: Question;
  now: number;
}) {
  const answer = question.answer;
  if (!answer) return null;
  const keys = choiceKeys(answer.choice);
  const chosen = question.options.filter((option) => keys.includes(option.key));
  return (
    <View style={{ gap: 2 }}>
      <Text style={text(colors).body}>
        <Text style={{ color: colors.statusSuccess, fontWeight: "600" }}>
          {keys.length ? keys.join(", ") : "Answer"}
        </Text>
        {chosen.length
          ? ` ${chosen.map((option) => option.label).join(", ")}.`
          : keys.length
            ? ""
            : ":"}
        {answer.words ? (
          <Text
            style={{
              color: keys.length ? colors.foregroundMuted : colors.foreground,
            }}
          >
            {" "}
            “{answer.words}”
          </Text>
        ) : null}
      </Text>
      <Text style={text(colors).small}>
        {answererLabel(answer.by, conductorId)} answered{" "}
        <When colors={colors} iso={answer.ts} now={now} />
      </Text>
    </View>
  );
}

/** "You" for the app's answers, else the agent that recorded it. */
export function answererLabel(
  by: string | undefined,
  conductorId: string,
): string {
  return !by || by === "user" ? "You" : answeredByLabel(by, conductorId);
}

/**
 * The options as cards. Before an answer each carries an Answer button that records it and tells
 * the conductor. Below them the user can answer in their own words instead, or add a note that goes
 * with the option they press.
 */
export function QuestionDetail({
  colors,
  conductorId,
  question,
  now,
  onSurface1 = false,
  onAnswered,
  onOpenAttachment,
}: {
  colors: Colors;
  conductorId: string;
  question: Question;
  now: number;
  onSurface1?: boolean;
  onAnswered?(): void;
  onOpenAttachment(attachment: Attachment, group: Attachment[]): void;
}) {
  const answer = useRpc(answerQuestionRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [words, setWords] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const said = words.trim();
  const multi = Boolean(question.multi);
  // Ticked keys in option order, so "C,A" never reaches the conductor.
  const pickedChoice = question.options
    .map((option) => option.key)
    .filter((key) => picked.includes(key))
    .join(",");
  const canSend = Boolean(said || (multi && pickedChoice));
  const send = useMutation({
    mutationFn: (choice: string | undefined) =>
      answer({
        conductorId,
        id: question.id,
        ...(choice ? { choice } : {}),
        ...(said ? { words: said } : {}),
      }),
    onSuccess: (_result, choice) => {
      setWords("");
      setPicked([]);
      toast.show(
        `Answered ${question.id}${choice ? ` ${choice.replaceAll(",", ", ")}` : ""}. The conductor was told.`,
        { variant: "success" },
      );
      void queryClient.invalidateQueries({
        queryKey: ["conductor", "progress"],
      });
      onAnswered?.();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const button = onSurface1
    ? { rest: colors.surface2, pressed: colors.surface1 }
    : { rest: colors.surface1, pressed: colors.surface2 };
  const settled = Boolean(question.answer);
  const files = (question.files ?? []).map(fileAttachment);
  const recommendedKeys = choiceKeys(question.recommend);
  const answeredKeys = choiceKeys(question.answer?.choice);
  return (
    <View style={{ gap: 10, paddingTop: 2 }}>
      {question.options.map((option) => {
        const recommended = recommendedKeys.includes(option.key);
        const chosen = answeredKeys.includes(option.key);
        const ticked = picked.includes(option.key);
        const toggle = multi && !settled;
        const borderColor = settled
          ? chosen
            ? colors.statusSuccess
            : colors.border
          : ticked || (recommended && !multi)
            ? colors.accent
            : colors.border;
        const card = {
          flexDirection: "row" as const,
          alignItems: "flex-start" as const,
          gap: 10,
          padding: 10,
          borderRadius: 12,
          borderWidth: 1,
          borderColor,
        };
        // A multi question ticks options with the whole card and sends them together below.
        const Card = toggle ? PressScale : View;
        return (
          <Card
            key={option.key}
            {...(toggle
              ? {
                  accessibilityRole: "checkbox" as const,
                  accessibilityState: { checked: ticked },
                  accessibilityLabel: `${option.key}: ${option.label}`,
                  onPress: () =>
                    setPicked((keys) =>
                      keys.includes(option.key)
                        ? keys.filter((key) => key !== option.key)
                        : [...keys, option.key],
                    ),
                }
              : {})}
            style={card}
          >
            {toggle ? (
              <View style={{ height: LINE.body, justifyContent: "center" }}>
                <Icon
                  name={ticked ? "SquareCheck" : "Square"}
                  size={18}
                  color={ticked ? colors.accent : colors.foregroundMuted}
                />
              </View>
            ) : null}
            <Text
              style={[text(colors).body, { fontWeight: "600", minWidth: 16 }]}
            >
              {option.key}
            </Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={text(colors).body}>
                {option.label}
                {chosen ? (
                  <Text style={{ color: colors.statusSuccess }}>
                    {"  "}
                    {!question.answer?.by || question.answer.by === "user"
                      ? "Your answer"
                      : "Answer"}
                  </Text>
                ) : null}
                {recommended ? (
                  <Text
                    style={{
                      color: settled ? colors.foregroundMuted : colors.accent,
                    }}
                  >
                    {"  "}Recommended
                  </Text>
                ) : null}
              </Text>
              {option.detail ? (
                <Text style={text(colors).muted}>{option.detail}</Text>
              ) : null}
            </View>
            {!settled && !multi ? (
              <PressScale
                accessibilityRole="button"
                accessibilityLabel={`Answer ${question.id} with ${option.key}`}
                disabled={send.isPending}
                onPress={() => send.mutate(option.key)}
                hitSlop={4}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingLeft: 8,
                  paddingRight: 10,
                  paddingVertical: 5,
                  borderRadius: 6,
                  ...raised(colors),
                  backgroundColor: pressed ? button.pressed : button.rest,
                  opacity: send.isPending ? 0.6 : 1,
                })}
              >
                <Icon name="Send" size={14} color={colors.foreground} />
                <Text style={text(colors).body}>Answer {option.key}</Text>
              </PressScale>
            ) : null}
          </Card>
        );
      })}
      {!settled ? (
        <View
          style={{
            gap: 8,
            padding: 10,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: said ? colors.accent : colors.border,
          }}
        >
          <Text style={[text(colors).body, { fontWeight: "600" }]}>
            {multi
              ? "Add a note, or answer in your own words"
              : question.options.length
                ? "Or answer in your own words"
                : "Your answer"}
          </Text>
          <TextInput
            accessibilityLabel={`Your answer to ${question.id}`}
            value={words}
            onChangeText={setWords}
            multiline
            placeholder={
              question.options.length
                ? "Write your answer, or a note to send with an option"
                : "Write your answer"
            }
            placeholderTextColor={colors.foregroundMuted}
            style={{
              minHeight: 72,
              color: colors.foreground,
              backgroundColor: onSurface1 ? colors.surface0 : colors.surface1,
              fontSize: FONT.body,
              lineHeight: LINE.body,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 10,
              textAlignVertical: "top",
            }}
          />
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text style={[text(colors).small, { flex: 1, minWidth: 160 }]}>
              {multi
                ? "Tick any options above, then send them with this text."
                : question.options.length
                  ? "Pressing an option above sends this text with it."
                  : "The conductor gets it right away."}
            </Text>
            <PressScale
              accessibilityRole="button"
              accessibilityLabel={`Send your answer to ${question.id}`}
              disabled={!canSend || send.isPending}
              onPress={() =>
                send.mutate(multi ? pickedChoice || undefined : undefined)
              }
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingLeft: 10,
                paddingRight: 12,
                paddingVertical: 7,
                borderRadius: 6,
                backgroundColor: canSend
                  ? colors.accent
                  : pressed
                    ? button.pressed
                    : button.rest,
                opacity: !canSend || send.isPending ? 0.6 : 1,
              })}
            >
              <Icon
                name="Send"
                size={16}
                color={
                  canSend ? colors.accentForeground : colors.foregroundMuted
                }
              />
              <Text
                style={[
                  text(colors).body,
                  {
                    fontWeight: "600",
                    color: canSend
                      ? colors.accentForeground
                      : colors.foregroundMuted,
                  },
                ]}
              >
                {send.isPending
                  ? "Sending…"
                  : multi && pickedChoice
                    ? `Send ${pickedChoice.replaceAll(",", ", ")}`
                    : "Send my answer"}
              </Text>
            </PressScale>
          </View>
        </View>
      ) : null}
      <AttachmentList
        colors={colors}
        attachments={files}
        onOpen={onOpenAttachment}
        onSurface1={onSurface1}
      />
      <Text style={text(colors).small}>
        Asked <When colors={colors} iso={question.askedAt} now={now} />
        {question.ticket ? ` on ${question.ticket}` : ""}
      </Text>
    </View>
  );
}

export interface Gallery {
  items: Attachment[];
  onSelect(attachment: Attachment): void;
}

function imageRatio(uri: string): Promise<number | null> {
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve(width && height ? width / height : null),
      () => resolve(null),
    );
  });
}

/** A preview dialog of its own, for lists outside a StackedDialog. */
export function PreviewDialog({
  colors,
  conductorId,
  attachment,
  onClose,
  onOpenOnHost,
  gallery,
}: {
  colors: Colors;
  conductorId: string;
  attachment: Attachment | null;
  onClose(): void;
  onOpenOnHost(attachment: Attachment): void;
  gallery?: Gallery;
}) {
  const open = Boolean(attachment);
  const shown = useLastPresent(attachment);
  return (
    <Modal
      title={shown?.title ?? "Preview"}
      icon={
        <Icon
          name={shown ? attachmentIcon(shown) : "FileText"}
          size={18}
          color={colors.foregroundMuted}
        />
      }
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content>
        {shown ? (
          <PreviewContent
            colors={colors}
            conductorId={conductorId}
            attachment={shown}
            onOpenOnHost={() => {
              onClose();
              onOpenOnHost(shown);
            }}
            gallery={gallery}
          />
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

/** An image or text file at its real shape, with Back, Previous / Next, and Open. */
function PreviewContent({
  colors,
  conductorId,
  attachment,
  onOpenOnHost,
  backLabel,
  onBack,
  gallery,
}: {
  colors: Colors;
  conductorId: string;
  attachment: Attachment;
  onOpenOnHost(): void;
  backLabel?: string;
  onBack?(): void;
  gallery?: Gallery;
}) {
  const toast = useToast();
  const fetchPreview = useRpc(previewTargetRpc);
  const queryClient = useQueryClient();
  const previewQuery = (target: Attachment) => ({
    queryKey: ["conductor", "preview", conductorId, target.target],
    queryFn: async () => {
      const data = await fetchPreview({ conductorId, target: target.target });
      if (data.kind !== "image") return { ...data, ratio: null };
      const uri = `data:${data.mime};base64,${data.data}`;
      return { ...data, uri, ratio: await imageRatio(uri) };
    },
    staleTime: 30_000,
    // Images arrive as data URIs up to ~13 MB; let them go soon after the dialog moves on.
    gcTime: 30_000,
  });
  // Stepping keeps the last file on screen (dimmed) until the next one loads.
  const preview = useQuery({
    ...previewQuery(attachment),
    placeholderData: (previous) => previous,
  });
  const stepping = preview.isPlaceholderData;
  const items = gallery?.items ?? [];
  const index = items.findIndex((item) => item.target === attachment.target);
  useEffect(() => {
    if (index < 0 || items.length < 2) return;
    const next = items[(index + 1) % items.length];
    if (next) void queryClient.prefetchQuery(previewQuery(next));
  }, [attachment.target, items.length]);
  const step = (offset: number) => {
    const next =
      items[(Math.max(0, index) + offset + items.length) % items.length];
    if (next) gallery?.onSelect(next);
  };
  const data = preview.data;
  const aspectRatio = data?.ratio ?? 16 / 10;
  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 10 }}>
        {preview.isPending ? (
          <View style={{ alignItems: "center", padding: 24 }}>
            <ActivityIndicator
              color={colors.foregroundMuted}
              accessibilityLabel="Loading preview"
            />
          </View>
        ) : null}
        {preview.error ? (
          <Text
            accessibilityRole="alert"
            selectable
            style={[text(colors).muted, { color: colors.statusDanger }]}
          >
            Could not preview it: {errorMessage(preview.error)}
          </Text>
        ) : null}
        {data?.kind === "image" && "uri" in data ? (
          <Image
            accessibilityLabel={attachment.title}
            source={{ uri: data.uri }}
            resizeMode="contain"
            style={{
              width: "100%",
              aspectRatio,
              maxHeight: 640,
              borderRadius: 8,
              ...imageOutline(colors),
              backgroundColor: colors.surface1,
              opacity: stepping ? 0.6 : 1,
            }}
          />
        ) : null}
        {data?.kind === "text" ? (
          <ScrollView
            style={{
              maxHeight: 480,
              borderRadius: 8,
              backgroundColor: colors.surface0,
              opacity: stepping ? 0.6 : 1,
            }}
            contentContainerStyle={{ padding: 12 }}
          >
            {isMarkdown(attachment.target) ? (
              <Markdown colors={colors} source={data.text} />
            ) : (
              <Text
                selectable
                style={{
                  color: colors.foreground,
                  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                  fontSize: FONT.secondary,
                  lineHeight: LINE.secondary,
                }}
              >
                {data.text}
              </Text>
            )}
            {data.truncated ? (
              <Text style={[text(colors).small, { paddingTop: 8 }]}>
                Showing the first 256 KB. Press Open to see the rest.
              </Text>
            ) : null}
          </ScrollView>
        ) : null}
        {data?.kind === "open" ? (
          <Text style={text(colors).muted}>{data.reason}</Text>
        ) : null}
        <Text
          selectable
          numberOfLines={1}
          ellipsizeMode="middle"
          style={text(colors).small}
        >
          {attachment.target}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, alignItems: "flex-start" }}>
          {onBack ? (
            <BackButton
              colors={colors}
              label={backLabel ?? "Back"}
              onPress={onBack}
            />
          ) : null}
        </View>
        {items.length > 1 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <DialogButton
              colors={colors}
              icon="ChevronLeft"
              accessibilityLabel="Previous file"
              onPress={() => step(-1)}
            />
            <Text
              style={[
                text(colors).muted,
                {
                  minWidth: 52,
                  textAlign: "center",
                  fontVariant: ["tabular-nums"],
                },
              ]}
            >
              {Math.max(0, index) + 1} of {items.length}
            </Text>
            <DialogButton
              colors={colors}
              icon="ChevronRight"
              accessibilityLabel="Next file"
              onPress={() => step(1)}
            />
          </View>
        ) : null}
        <View style={{ flex: 1, alignItems: "flex-end" }}>
          {/* Text stays in Paseo: plugins can't open a file tab, and the browser shows raw source. */}
          {previewKind(attachment.target) === "text" ? (
            <DialogButton
              colors={colors}
              icon="Copy"
              label="Copy path"
              onPress={() => {
                copyText(attachment.target).then(
                  () => toast.show("Copied path", { variant: "success" }),
                  () => toast.error("Could not copy. Select the path above."),
                );
              }}
            />
          ) : (
            <DialogButton
              colors={colors}
              icon="ExternalLink"
              label="Open"
              accessibilityLabel="Open in the browser"
              onPress={onOpenOnHost}
            />
          )}
        </View>
      </View>
    </View>
  );
}

/** A dialog footer button; icon-only is a square. */
export function DialogButton({
  colors,
  icon,
  label,
  accessibilityLabel,
  onPress,
}: {
  colors: Colors;
  icon: string;
  label?: string;
  accessibilityLabel?: string;
  onPress(): void;
}) {
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingVertical: 7,
        paddingLeft: 9,
        paddingRight: label ? 12 : 9,
        borderRadius: 6,
        ...raised(colors),
        backgroundColor: pressed ? colors.surface1 : colors.surface2,
      })}
    >
      <Icon name={icon} size={16} color={colors.foreground} />
      {label ? <Text style={text(colors).body}>{label}</Text> : null}
    </PressScale>
  );
}

export function BackButton({
  colors,
  label,
  onPress,
}: {
  colors: Colors;
  label: string;
  onPress(): void;
}) {
  return (
    <DialogButton
      colors={colors}
      icon="ChevronLeft"
      label={label}
      onPress={onPress}
    />
  );
}
