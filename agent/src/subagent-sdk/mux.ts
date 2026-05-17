import type { TmuxTarget } from "../mode-utils.js";

export type PaneSubmitMode = "steer" | "followUp";

export type CreatePaneOptions = {
  cwd: string;
  title: string;
  command: string;
  target: TmuxTarget;
};

export type PaneCapture = {
  text: string;
};

export type CreatedPane = {
  paneId: string;
  backend?: string;
};

export interface MuxAdapter {
  readonly backend: string;
  isAvailable(): Promise<boolean>;
  createPane(options: CreatePaneOptions): Promise<CreatedPane>;
  sendText(
    paneId: string,
    text: string,
    submitMode?: PaneSubmitMode,
    backend?: string,
  ): Promise<void>;
  paneExists(paneId: string, backend?: string): Promise<boolean>;
  killPane(paneId: string, backend?: string): Promise<void>;
  capturePane(paneId: string, lines?: number, backend?: string): Promise<PaneCapture>;
  dispose?(): void;
}
