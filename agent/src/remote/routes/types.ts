import type { AuthService, AuthSession } from "../auth.js";
import type { SessionLiveEventBus } from "../live-events.js";
import type { RemoteKvStore } from "../kv/store.js";
import type { SessionRegistry } from "../session-registry.js";

export interface RemoteHonoEnv {
  Variables: {
    auth: AuthSession;
  };
}

export interface RemoteRoutesDependencies {
  auth: AuthService;
  sessions: SessionRegistry;
  kv: RemoteKvStore;
  liveEvents: SessionLiveEventBus;
}
