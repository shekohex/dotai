import type { Args } from "@earendil-works/pi-coding-agent";

export type ModeStartupSelection = {
  hasExplicitModel: boolean;
};

export function createModeStartupSelection(args: Pick<Args, "model">): ModeStartupSelection {
  return { hasExplicitModel: args.model !== undefined };
}
