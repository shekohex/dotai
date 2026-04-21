import type { ExtensionUiRequestEventPayload } from "../schemas.js";
import type { SessionRecord } from "./types.js";

export type RemoteUiContextInput = {
  record: SessionRecord;
  now: () => number;
  publishUiEvent: (record: SessionRecord, payload: ExtensionUiRequestEventPayload) => void;
};
