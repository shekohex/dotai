import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";

export const ICON_ANIMATIONS = ["spin", "pulse", "bounce"] as const;
export type IconAnimation = (typeof ICON_ANIMATIONS)[number];

/** A Lucide icon that optionally loops: spin (rotates), pulse (fades), bounce (hops). */
export function AnimatedIcon({ name, size, color, animation }: { name: string; size: number; color: string; animation?: string }) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (animation !== "spin" && animation !== "pulse" && animation !== "bounce") return;
    const step = (toValue: number, duration: number) =>
      Animated.timing(progress, { toValue, duration, easing: animation === "spin" ? Easing.linear : Easing.inOut(Easing.quad), useNativeDriver: true });
    const loop = Animated.loop(
      animation === "spin"
        ? Animated.sequence([step(1, 900), Animated.timing(progress, { toValue: 0, duration: 0, useNativeDriver: true })])
        : Animated.sequence([step(1, animation === "pulse" ? 800 : 420), step(0, animation === "pulse" ? 800 : 420)]),
    );
    loop.start();
    return () => {
      loop.stop();
      progress.setValue(0);
    };
  }, [animation, progress]);

  const icon = <Icon name={name} size={size} color={color} />;
  if (animation === "spin") {
    return <Animated.View style={{ transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }}>{icon}</Animated.View>;
  }
  if (animation === "pulse") {
    return <Animated.View style={{ opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] }) }}>{icon}</Animated.View>;
  }
  if (animation === "bounce") {
    return <Animated.View style={{ transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.3] }) }] }}>{icon}</Animated.View>;
  }
  return icon;
}
