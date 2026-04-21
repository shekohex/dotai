import { appEventsStreamId } from "./streams.js";
import { SessionRegistryStateCommands } from "./session/registry-state-commands.js";
import type { SessionRegistryOptions } from "./session/deps.js";

export class SessionRegistry extends SessionRegistryStateCommands {
  constructor(options: SessionRegistryOptions) {
    super(options);
    this.streams.ensureStream(appEventsStreamId());
  }
}
