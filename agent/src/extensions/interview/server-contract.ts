import type { Server } from "node:http";

import type { MediaBlock, Question, QuestionsFile, OptionValue } from "./schema.js";
import type {
  AskModelOption,
  OptionInsightResult,
  ResponseItem,
  SavedOptionInsight,
} from "./types.js";

export type { ResponseItem, SavedOptionInsight } from "./types.js";

export interface SessionEntry {
  id: string;
  url: string;
  cwd: string;
  gitBranch: string | null;
  title: string;
  startedAt: number;
  lastSeen: number;
}

export interface SessionsFile {
  sessions: SessionEntry[];
}

export type ThemeMode = "auto" | "light" | "dark";

export interface InterviewThemeConfig {
  mode?: ThemeMode;
  name?: string;
  lightPath?: string;
  darkPath?: string;
  toggleHotkey?: string;
}

export interface InterviewServerOptions {
  questions: QuestionsFile;
  sessionToken: string;
  sessionId: string;
  cwd: string;
  timeout: number;
  port?: number;
  host?: string;
  publicBaseUrl?: string;
  verbose?: boolean;
  theme?: InterviewThemeConfig;
  snapshotDir?: string;
  autoSaveOnSubmit?: boolean;
  savedAnswers?: ResponseItem[];
  savedOptionInsights?: SavedOptionInsight[];
  optionKeysByQuestion?: Record<string, string[]>;
  canGenerate?: boolean;
  askModels?: AskModelOption[];
  defaultAskModel?: string | null;
}

export interface InterviewServerCallbacks {
  onSubmit: (responses: ResponseItem[]) => void;
  onCancel: (reason?: "timeout" | "user" | "stale", partialResponses?: ResponseItem[]) => void;
  onProgress?: (responses: ResponseItem[]) => void;
  onGenerate?: (
    questionId: string,
    existingOptions: string[],
    signal: AbortSignal,
    mode: "add" | "review",
  ) => Promise<{ options: OptionValue[]; question?: string }>;
  onOptionInsight?: (
    questionId: string,
    option: OptionValue,
    prompt: string,
    modelOverride: string | null,
    depth: string,
    signal: AbortSignal,
  ) => Promise<OptionInsightResult>;
}

export interface InterviewServerHandle {
  server: Server;
  url: string;
  close: () => void;
}

export interface SavedFromMeta {
  cwd: string;
  branch: string | null;
  sessionId: string;
}

export interface SavedInterviewMeta {
  savedAt: string;
  wasSubmitted: boolean;
  savedFrom: SavedFromMeta;
}

export function getMediaList(question: Question): MediaBlock[] {
  if (question.media === undefined) {
    return [];
  }
  return Array.isArray(question.media) ? question.media : [question.media];
}
