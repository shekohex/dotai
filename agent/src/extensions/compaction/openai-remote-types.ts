import type { Usage } from "@earendil-works/pi-ai";

export type AssistantPhase = "commentary" | "final_answer";

export type ResponseContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string };

export type ResponseItem = {
  type: string;
  [key: string]: unknown;
};

export type ResponsesReasoningConfig = {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  summary?: "auto" | "concise" | "detailed" | null;
};

export type ResponsesTextConfig = Record<string, unknown>;

export type RemoteCompactionDetails = {
  version: 1 | 2;
  provider: "openai-responses-compact" | "openai-responses-compaction";
  implementation?: "responses_compact_v1" | "responses_compaction_v2";
  modelKey: string;
  replacementHistory: ResponseItem[];
  usage?: Usage;
};

export type RemoteCompactionSessionState = {
  compactionEntryId: string;
  modelKey: string;
  replacementHistory: ResponseItem[];
  explicitHistory: ResponseItem[];
};

export type RemoteCompactionResult = {
  output: ResponseItem[];
  usage?: Usage;
};
