export interface ChoiceResponseValue {
  option: string;
  note?: string;
}

export type ResponseValue = string | string[] | ChoiceResponseValue | ChoiceResponseValue[];

export interface ResponseItem {
  id: string;
  value: ResponseValue;
  attachments?: string[];
}

export interface SavedOptionInsight {
  id: string;
  questionId: string;
  optionKey: string;
  optionText: string;
  prompt: string;
  summary: string;
  bullets?: string[];
  suggestedText?: string;
  modelUsed?: string | null;
  createdAt?: string;
}

export interface AskModelOption {
  value: string;
  provider: string;
  label: string;
}

export interface OptionInsightResult {
  summary: string;
  bullets?: string[];
  suggestedText?: string;
  modelUsed?: string | null;
}

export interface AgentResponseItem {
  id: string;
  question: string;
  type: "single" | "multi" | "text" | "image" | "info";
  value: ResponseItem["value"];
  attachments?: string[];
}
