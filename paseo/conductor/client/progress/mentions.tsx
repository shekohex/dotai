/**
 * #AI-03 mentions as tappable ticket chips, in Markdown and in plain lines alike. The nearest
 * provider decides what a tap does: open the ticket's dialog, or push it on the dialog stack.
 */
import { createContext, type ReactNode, useContext } from "react";
import { Text, type TextStyle } from "react-native";

import { chipTone, isDarkSurface } from "../../shared/colors.js";
import { splitMentions, ticketNumber as number } from "../../shared/links.js";
import type { Ticket } from "../../shared/progress.js";
import type { Colors } from "./ui.js";

interface MentionApi {
  /** The ticket a stored id (T03) names, by its number. */
  find(stored: string): Pick<Ticket, "id" | "title" | "status"> | undefined;
  open?(id: string): void;
}

const MentionContext = createContext<MentionApi | null>(null);

export function MentionProvider({
  tickets,
  onOpen,
  children,
}: {
  tickets: readonly Pick<Ticket, "id" | "title" | "status">[];
  onOpen?(id: string): void;
  children: ReactNode;
}) {
  const byNumber = new Map(
    tickets.map((ticket) => [number(ticket.id), ticket]),
  );
  return (
    <MentionContext.Provider
      value={{
        find: (stored) => byNumber.get(number(stored)),
        ...(onOpen ? { open: onOpen } : {}),
      }}
    >
      {children}
    </MentionContext.Provider>
  );
}

/** One mention, inline in a Text: the ticket's id in its color, tappable when it can open. */
export function MentionChip({
  colors,
  stored,
  raw,
}: {
  colors: Colors;
  stored: string;
  raw: string;
}) {
  const api = useContext(MentionContext);
  const ticket = api?.find(stored);
  const label = ticket ? `#${ticket.id}` : raw;
  const tone = chipTone(ticket?.id ?? raw, isDarkSurface(colors.surface0));
  const open = ticket && api?.open ? () => api.open?.(ticket.id) : undefined;
  return (
    <Text
      accessibilityRole={open ? "link" : undefined}
      accessibilityLabel={ticket ? `${ticket.id}: ${ticket.title}` : raw}
      onPress={open}
      style={{
        color: tone.fg,
        backgroundColor: tone.bg,
        fontWeight: "600",
        borderRadius: 4,
      }}
    >
      {` ${label} `}
    </Text>
  );
}

/** Plain text with its #mentions drawn as chips. */
export function MentionText({
  colors,
  text,
  style,
  numberOfLines,
}: {
  colors: Colors;
  text: string;
  style?: TextStyle | (TextStyle | null | undefined)[];
  numberOfLines?: number;
}) {
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      <MentionSpans colors={colors} text={text} />
    </Text>
  );
}

/** The pieces of a text, for use inside an existing Text. */
export function MentionSpans({
  colors,
  text,
}: {
  colors: Colors;
  text: string;
}) {
  return (
    <>
      {splitMentions(text).map((part, index) =>
        "mention" in part ? (
          <MentionChip
            key={index}
            colors={colors}
            stored={part.mention}
            raw={part.raw}
          />
        ) : (
          part.text
        ),
      )}
    </>
  );
}
