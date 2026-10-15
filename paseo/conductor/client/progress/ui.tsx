/**
 * Building blocks of the progress UI: motion, status marks, rows, tabs, and paging.
 * Ported from the Progress plugin by Steve Castaneda (MIT,
 * https://github.com/stevecastaneda/paseo-plugins/tree/main/progress), resized to this
 * plugin's type scale.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import {
  createContext,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  type PressableProps,
  type StyleProp,
  Text,
  View,
  type ViewStyle,
} from "react-native";

import { formatAgo, formatClock, unbroken } from "../../shared/format.js";
import type { TicketStatus } from "../../shared/progress.js";
import { PROGRESS_FONT } from "../styles.js";

export type Colors = PluginTheme["colors"];

export const FONT = PROGRESS_FONT;
/** Line heights that pair with the type scale. */
export const LINE = {
  small: 18,
  secondary: 20,
  body: 22,
  section: 23,
  title: 26,
};

/** The explorer opens at 320px; at or below this width sections trim what they show. */
export const NARROW_MAX = 400;
const Narrow = createContext(false);
export const NarrowProvider = Narrow.Provider;
export function useNarrow(): boolean {
  return useContext(Narrow);
}

// The native driver can't run on web; read at render time, not import time.
const isWeb = () => Platform.OS === "web";
export const nativeDriver = () => !isWeb();
const easeOut = () => Easing.out(Easing.ease);

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => live && setReduced(value),
    );
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** Re-renders on an interval so "11m ago" keeps counting between polls. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The last non-null value, so a dialog keeps its content while it animates closed. */
export function useLastPresent<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

// Relative luminance of a #rgb/#rrggbb or rgb() color, or null when unreadable.
function luminance(color: string): number | null {
  let rgb: number[] | null = null;
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const digits =
      hex[1].length === 3
        ? [...hex[1]].map((digit) => digit + digit)
        : (hex[1].match(/../g) ?? []);
    rgb = digits.map((digit) => parseInt(digit, 16));
  } else {
    const fn = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (fn) rgb = fn.slice(1, 4).map(Number);
  }
  if (!rgb || rgb.length < 3) return null;
  const [r = 0, g = 0, b = 0] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Depth for cards and bordered buttons: a soft ring and lift in light themes, a ring in dark. */
export function raised(colors: Colors): ViewStyle {
  const value = luminance(colors.surface0);
  if (value === null) return { borderWidth: 1, borderColor: colors.border };
  return {
    boxShadow:
      value > 0.4
        ? "0px 0px 0px 1px rgba(0, 0, 0, 0.06), 0px 1px 2px -1px rgba(0, 0, 0, 0.06), 0px 2px 4px 0px rgba(0, 0, 0, 0.04)"
        : "0px 0px 0px 1px rgba(255, 255, 255, 0.08)",
  };
}

/** A 1px ring just inside an image. */
export function imageOutline(colors: Colors): {
  borderWidth: number;
  borderColor: string;
} {
  const value = luminance(colors.surface0);
  return {
    borderWidth: 1,
    borderColor:
      value !== null && value <= 0.4
        ? "rgba(255, 255, 255, 0.1)"
        : "rgba(0, 0, 0, 0.1)",
  };
}

/** The system spinner, sized to sit beside a line of text. */
export function Spinner({
  color,
  size = 14,
}: {
  color: string;
  size?: number;
}) {
  return (
    <View
      accessibilityLabel="Working"
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {Platform.OS === "ios" ? (
        <ActivityIndicator
          size="small"
          color={color}
          style={{ transform: [{ scale: size / 20 }] }}
        />
      ) : (
        <ActivityIndicator size={size} color={color} />
      )}
    </View>
  );
}

/** In place of the spinner once the run is stale: asks for attention instead of looking busy. */
export function StalledPulse({
  color,
  size = 14,
}: {
  color: string;
  size?: number;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: nativeDriver(),
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: nativeDriver(),
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      accessibilityLabel="Possibly stalled"
      style={{ width: size, height: size, opacity }}
    >
      <Icon name="TriangleAlert" size={size} color={color} />
    </Animated.View>
  );
}

/** A ticket not started or waiting on another: a still, faded dot. */
export function WaitingDot({
  color,
  size = 14,
}: {
  color: string;
  size?: number;
}) {
  const dot = Math.round(size / 2);
  return (
    <View
      accessibilityLabel="Waiting"
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: color,
          opacity: 0.5,
        }}
      />
    </View>
  );
}

/** A button that scales to 0.96 while pressed. */
export function PressScale({
  style,
  outerStyle,
  children,
  ref,
  ...props
}: Omit<PressableProps, "style" | "children"> & {
  ref?: Ref<View>;
  outerStyle?: StyleProp<ViewStyle>;
  style?:
    | StyleProp<ViewStyle>
    | ((state: { pressed: boolean; hovered: boolean }) => StyleProp<ViewStyle>);
  children: ReactNode;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (toValue: number) =>
    Animated.timing(scale, {
      toValue,
      duration: 150,
      easing: easeOut(),
      useNativeDriver: nativeDriver(),
    }).start();
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...props}
      ref={ref}
      style={outerStyle}
      onHoverIn={(event) => {
        setHovered(true);
        props.onHoverIn?.(event);
      }}
      onHoverOut={(event) => {
        setHovered(false);
        props.onHoverOut?.(event);
      }}
      onPressIn={(event) => {
        setPressed(true);
        to(0.96);
        props.onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        to(1);
        props.onPressOut?.(event);
      }}
    >
      <Animated.View
        style={[
          typeof style === "function" ? style({ pressed, hovered }) : style,
          { transform: [{ scale }] },
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

/** Cross-fades an icon when `swapKey` changes. Nothing animates on first render. */
export function IconSwap({
  swapKey,
  size,
  children,
}: {
  swapKey: string;
  size: number;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(swapKey);
  const [leaving, setLeaving] = useState<ReactNode>(null);
  const last = useRef(children);
  const enter = useRef(new Animated.Value(1)).current;
  if (swapKey !== shown) {
    setShown(swapKey);
    setLeaving(reduced ? null : last.current);
  }
  useLayoutEffect(() => {
    last.current = children;
  });
  useLayoutEffect(() => {
    if (!leaving) return;
    enter.setValue(0);
    const animation = Animated.timing(enter, {
      toValue: 1,
      duration: 300,
      easing: Easing.bezier(0.2, 0, 0, 1),
      useNativeDriver: nativeDriver(),
    });
    animation.start(({ finished }) => finished && setLeaving(null));
    return () => animation.stop();
  }, [shown]);
  const layer = (
    value: Animated.AnimatedInterpolation<number> | Animated.Value,
  ) => ({
    opacity: value,
    transform: [
      {
        scale: value.interpolate({
          inputRange: [0, 1],
          outputRange: [0.25, 1],
        }),
      },
    ],
  });
  const exit = enter.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  return (
    <Animated.View style={{ width: size, height: size }}>
      {leaving ? (
        <Animated.View
          style={[{ position: "absolute", top: 0, left: 0 }, layer(exit)]}
        >
          {leaving}
        </Animated.View>
      ) : null}
      <Animated.View style={layer(enter)}>{children}</Animated.View>
    </Animated.View>
  );
}

// Sections that mount within this long of the dashboard stagger in; later ones enter at once.
const FIRST_LOAD_MS = 1000;
const StaggerStart = createContext<number | null>(null);

export function StaggerRoot({ children }: { children: ReactNode }) {
  const [start] = useState(() => Date.now());
  return (
    <StaggerStart.Provider value={start}>{children}</StaggerStart.Provider>
  );
}

/** Fades a section in (rising 12px) and out; `order` staggers the first load by 60ms. */
export function Presence({
  show,
  order = 0,
  children,
}: {
  show: boolean;
  order?: number;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const start = useContext(StaggerStart);
  const [mounted, setMounted] = useState(show);
  const last = useRef(children);
  if (show) last.current = children;
  const enter = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(0)).current;
  if (show && !mounted) setMounted(true);

  useEffect(() => {
    if (!mounted) return;
    if (show) {
      exit.setValue(0);
      if (reduced) {
        enter.setValue(1);
        return;
      }
      const firstLoad = start !== null && Date.now() - start < FIRST_LOAD_MS;
      const animation = Animated.timing(enter, {
        toValue: 1,
        duration: 300,
        delay: firstLoad ? order * 60 : 0,
        easing: easeOut(),
        useNativeDriver: nativeDriver(),
      });
      animation.start();
      return () => animation.stop();
    }
    if (reduced) {
      setMounted(false);
      return;
    }
    const animation = Animated.timing(exit, {
      toValue: 1,
      duration: 150,
      easing: easeOut(),
      useNativeDriver: nativeDriver(),
    });
    animation.start(({ finished }) => {
      if (finished) {
        enter.setValue(0);
        setMounted(false);
      }
    });
    return () => animation.stop();
  }, [show, mounted]);

  if (!mounted) return null;
  const opacity = Animated.multiply(
    enter,
    exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
  );
  const translateY = Animated.add(
    enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }),
    exit.interpolate({ inputRange: [0, 1], outputRange: [0, -12] }),
  );
  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      {show ? children : last.current}
    </Animated.View>
  );
}

/** One instant tint for every pressable row; `onSurface1` rows start a step higher. */
function rowTint(
  colors: Colors,
  state: { hovered: boolean; pressed: boolean },
  onSurface1: boolean,
): string {
  if (onSurface1)
    return state.pressed
      ? colors.border
      : state.hovered
        ? colors.surface2
        : colors.surface1;
  return state.pressed
    ? colors.surface2
    : state.hovered
      ? colors.surface1
      : "transparent";
}

/** A full-width row that opens something. */
export function PressableRow({
  colors,
  onSurface1 = false,
  transparentAtRest = true,
  style,
  children,
  ...props
}: Omit<PressableProps, "style" | "children"> & {
  colors: Colors;
  onSurface1?: boolean;
  transparentAtRest?: boolean;
  style?: ViewStyle;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...props}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        style,
        {
          backgroundColor:
            !hovered && !pressed && transparentAtRest
              ? "transparent"
              : rowTint(colors, { hovered, pressed }, onSurface1),
        },
      ]}
    >
      {children}
    </Pressable>
  );
}

/** A card's heading: an icon beside the semibold title. */
export function SectionTitle({
  colors,
  icon,
  title,
  color,
  style,
  children,
}: {
  colors: Colors;
  icon: string;
  title: string;
  color?: string;
  style?: ViewStyle;
  children?: ReactNode;
}) {
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 10,
        },
        style,
      ]}
    >
      <Icon name={icon} size={16} color={color ?? colors.foregroundMuted} />
      <Text
        accessibilityRole="header"
        style={{
          color: color ?? colors.foreground,
          fontSize: FONT.section,
          lineHeight: LINE.section,
          fontWeight: "600",
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

/** A raised card with an optional heading. */
export function Card({
  colors,
  icon,
  title,
  children,
  borderColor,
  titleColor,
  trailing,
}: {
  colors: Colors;
  icon?: string;
  title?: string;
  children: ReactNode;
  borderColor?: string;
  titleColor?: string;
  /** Beside the title, pushed to the right: a count or a control. */
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{
        margin: 12,
        marginBottom: 0,
        borderRadius: 8,
        overflow: "hidden",
        ...(borderColor ? { borderWidth: 1, borderColor } : raised(colors)),
      }}
    >
      {icon && title ? (
        <SectionTitle
          colors={colors}
          icon={icon}
          title={title}
          color={titleColor}
        >
          {trailing ? (
            <View
              style={{
                flex: 1,
                flexDirection: "row",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: 8,
              }}
            >
              {trailing}
            </View>
          ) : null}
        </SectionTitle>
      ) : null}
      {children}
    </View>
  );
}

/** "Oct 16, 8:14 PM (10h 2m ago)" inline; a narrow panel shows only the "ago". */
export function When({
  colors,
  iso,
  now,
}: {
  colors: Colors;
  iso: string;
  now: number;
}) {
  const ago = unbroken(formatAgo(iso, now));
  if (useNarrow()) return <Text>{ago}</Text>;
  return (
    <Text>
      {formatClock(iso)}{" "}
      <Text style={{ color: colors.foregroundMuted, opacity: 0.75 }}>
        ({ago})
      </Text>
    </Text>
  );
}

/** An icon hung beside wrapping text, kept on its first line. */
export function StatusLine({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <View style={{ paddingTop: 3 }}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  not_started: "Not started",
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  skipped: "Skipped",
};

/** `waiting`: held for another ticket; shown as calm as "Not started". */
export function StatusBadge({
  colors,
  status,
  waiting = false,
}: {
  colors: Colors;
  status: TicketStatus;
  waiting?: boolean;
}) {
  const tone = waiting
    ? { fg: colors.foregroundMuted, bg: "transparent", border: colors.border }
    : {
        done: {
          fg: colors.statusSuccess,
          bg: "transparent",
          border: colors.statusSuccess,
        },
        working: {
          fg: colors.accentForeground,
          bg: colors.accent,
          border: colors.accent,
        },
        blocked: {
          fg: colors.statusDanger,
          bg: "transparent",
          border: colors.statusDanger,
        },
        skipped: {
          fg: colors.foregroundMuted,
          bg: "transparent",
          border: colors.border,
        },
        not_started: {
          fg: colors.foregroundMuted,
          bg: "transparent",
          border: colors.border,
        },
      }[status];
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: tone.border,
        backgroundColor: tone.bg,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 2,
      }}
    >
      <Text
        style={{ color: tone.fg, fontSize: FONT.small, lineHeight: LINE.small }}
      >
        {waiting ? "Waiting" : STATUS_LABEL[status]}
      </Text>
    </View>
  );
}

/** The one status mark on a ticket row or timeline step. */
export function StatusIcon({
  colors,
  status,
  live,
  waiting,
  size = 16,
}: {
  colors: Colors;
  status: TicketStatus;
  live: boolean;
  waiting: boolean;
  size?: number;
}) {
  if (waiting) return <WaitingDot color={colors.foregroundMuted} size={size} />;
  switch (status) {
    case "done":
      return <Icon name="Check" size={size} color={colors.statusSuccess} />;
    case "working":
      return live ? (
        <Spinner color={colors.accent} size={size} />
      ) : (
        <StalledPulse color={colors.statusWarning} size={size} />
      );
    case "blocked":
      return <Icon name="Ban" size={size} color={colors.statusDanger} />;
    case "skipped":
      return (
        <Icon name="CircleSlash" size={size} color={colors.foregroundMuted} />
      );
    default:
      return <WaitingDot color={colors.foregroundMuted} size={size} />;
  }
}

export interface TabEntry<Id extends string> {
  id: Id;
  label: string;
  icon?: string | null;
  count?: number;
}

/** A row of tabs over a bottom rule, with icons and count badges. */
export function TabStrip<Id extends string>({
  colors,
  tabs,
  selected,
  onSelect,
  style,
}: {
  colors: Colors;
  tabs: TabEntry<Id>[];
  selected: Id;
  onSelect(id: Id): void;
  style?: ViewStyle;
}) {
  const narrow = useNarrow();
  // One line always: icons go first when the labels don't fit, then the strip scrolls.
  const [width, setWidth] = useState(0);
  const [fullWidth, setFullWidth] = useState(0);
  const showIcons = !narrow && (fullWidth === 0 || fullWidth <= width);
  return (
    <View
      accessibilityRole="tablist"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[
        { borderBottomWidth: 1, borderBottomColor: colors.border },
        style,
      ]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        onContentSizeChange={(contentWidth: number) => {
          if (showIcons) setFullWidth(contentWidth);
        }}
        contentContainerStyle={{
          flexDirection: "row",
          columnGap: narrow || !showIcons ? 12 : 16,
        }}
      >
        {tabs.map((entry) => (
          <Tab
            key={entry.id}
            colors={colors}
            entry={showIcons ? entry : { ...entry, icon: null }}
            selected={entry.id === selected}
            onPress={() => onSelect(entry.id)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function Tab<Id extends string>({
  colors,
  entry,
  selected,
  onPress,
}: {
  colors: Colors;
  entry: TabEntry<Id>;
  selected: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingTop: 10,
        paddingBottom: 8,
        marginBottom: -1,
        borderBottomWidth: 2,
        borderBottomColor: selected
          ? colors.accent
          : pressed || hovered
            ? colors.border
            : "transparent",
      })}
    >
      {entry.icon ? (
        <Icon
          name={entry.icon}
          size={16}
          color={selected ? colors.accent : colors.foregroundMuted}
        />
      ) : null}
      <Text
        style={{
          color:
            selected || hovered ? colors.foreground : colors.foregroundMuted,
          fontSize: FONT.body,
          lineHeight: LINE.body,
          fontWeight: "600",
        }}
      >
        {entry.label}
      </Text>
      {entry.count !== undefined ? (
        <View
          style={{
            minWidth: 20,
            paddingHorizontal: 5,
            borderRadius: 5,
            alignItems: "center",
            backgroundColor: colors.surface2,
          }}
        >
          <Text
            style={{
              color: selected ? colors.foreground : colors.foregroundMuted,
              fontSize: FONT.small,
              lineHeight: LINE.small,
              fontWeight: "600",
              fontVariant: ["tabular-nums"],
            }}
          >
            {entry.count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export const PAGE = 10;

/** Newest-first lists show 10 at a time; each press loads 10 older. */
export function usePaged<T>(items: T[]) {
  const [limit, setLimit] = useState(PAGE);
  return {
    shown: items.slice(0, limit),
    older: Math.max(0, items.length - limit),
    showOlder: () => setLimit(limit + PAGE),
    showFewer: () => setLimit(PAGE),
  };
}

export function ShowMoreRow({
  colors,
  total,
  paged,
  page = PAGE,
  noun = "older",
}: {
  colors: Colors;
  total: number;
  paged: Pick<ReturnType<typeof usePaged>, "older" | "showOlder" | "showFewer">;
  page?: number;
  /** "Show 8 older" in feeds, "Show 8 more" in lists without an order in time. */
  noun?: string;
}) {
  const more =
    paged.older > 0
      ? {
          label: `Show ${Math.min(paged.older, page)} ${noun}`,
          icon: "ChevronDown",
          onPress: paged.showOlder,
        }
      : total > page
        ? { label: "Show fewer", icon: "ChevronUp", onPress: paged.showFewer }
        : null;
  if (!more) return null;
  return (
    <PressableRow
      colors={colors}
      accessibilityRole="button"
      onPress={more.onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <IconSwap swapKey={more.icon} size={16}>
        <Icon name={more.icon} size={16} color={colors.foregroundMuted} />
      </IconSwap>
      <Text
        style={{
          color: colors.foregroundMuted,
          fontSize: FONT.secondary,
          lineHeight: LINE.secondary,
          fontWeight: "600",
        }}
      >
        {more.label}
      </Text>
    </PressableRow>
  );
}

/** Text styles of the scale, colored from the theme. */
export function text(colors: Colors) {
  return {
    title: {
      color: colors.foreground,
      fontSize: FONT.title,
      lineHeight: LINE.title,
      fontWeight: "600" as const,
    },
    body: {
      color: colors.foreground,
      fontSize: FONT.body,
      lineHeight: LINE.body,
    },
    muted: {
      color: colors.foregroundMuted,
      fontSize: FONT.secondary,
      lineHeight: LINE.secondary,
    },
    small: {
      color: colors.foregroundMuted,
      fontSize: FONT.small,
      lineHeight: LINE.small,
    },
  };
}
