import type { AuthService, AuthSession } from "../auth.js";
import type { RemoteKvStore } from "../kv/store.js";
import type { SessionRegistry } from "../session-registry.js";
import type { InMemoryDurableStreamStore } from "../streams.js";

export interface RemoteHonoEnv {
  Variables: {
    auth: AuthSession;
  };
}

export interface RemoteRoutesDependencies {
  auth: AuthService;
  sessions: SessionRegistry;
  kv: RemoteKvStore;
  streams: InMemoryDurableStreamStore;
}
