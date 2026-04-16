import { Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import type { AllowedPublicKey } from "./auth.js";
import { AuthService } from "./auth.js";
import type { RemoteRuntimeFactory } from "./runtime-factory.js";
import { InMemoryPiRuntimeFactory } from "./runtime-factory.js";
import { createV1Routes, type RemoteHonoEnv } from "./routes.js";
import { SessionRegistry } from "./session-registry.js";
import { InMemoryDurableStreamStore } from "./streams.js";

export interface CreateRemoteAppOptions {
  origin?: string;
  allowedKeys: AllowedPublicKey[];
  runtimeFactory?: RemoteRuntimeFactory;
}

export interface RemoteAppContext {
  app: Hono<RemoteHonoEnv>;
  dispose: () => Promise<void>;
}

export function createRemoteApp(options: CreateRemoteAppOptions): RemoteAppContext {
  const app = new Hono<RemoteHonoEnv>();
  const streams = new InMemoryDurableStreamStore();
  const runtimeFactory = options.runtimeFactory ?? new InMemoryPiRuntimeFactory();
  const auth = new AuthService({
    origin: options.origin ?? "http://localhost:3000",
    allowedKeys: options.allowedKeys,
  });
  const sessions = new SessionRegistry({
    streams,
    runtimeFactory,
  });

  const v1 = createV1Routes({
    auth,
    sessions,
    streams,
  });

  app.route("/v1", v1);
  app.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "pi-remote API",
          version: "0.1.0",
          description: "Remote headless Pi daemon API",
        },
        servers: [{ url: options.origin ?? "http://localhost:3000" }],
      },
      exclude: ["/openapi.json"],
    }),
  );

  return {
    app,
    dispose: async () => {
      await sessions.dispose();
    },
  };
}

export type RemoteApiApp = ReturnType<typeof createRemoteApp>["app"];
