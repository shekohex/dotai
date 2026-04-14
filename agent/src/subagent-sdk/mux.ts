import type { TmuxTarget } from "../mode-utils.js";

export type PaneSubmitMode = "steer" | "followUp" | "nextTurn";

export type CreatePaneOptions = {
  cwd: string;
  title: string;
  command: string;
  target: TmuxTarget;
};

export type PaneCapture = {
  text: string;
};

export interface MuxAdapter {
  readonly backend: string;
  isAvailable(): Promise<boolean>;
  createPane(options: CreatePaneOptions): Promise<{ paneId: string }>;
  sendText(paneId: string, text: string, submitMode?: PaneSubmitMode): Promise<void>;
  paneExists(paneId: string): Promise<boolean>;
  killPane(paneId: string): Promise<void>;
  capturePane(paneId: string, lines?: number): Promise<PaneCapture>;
}
