import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { openAPIRouteHandler } from "hono-openapi";
import type { AllowedPublicKey } from "./auth.js";
import { AuthService } from "./auth.js";
import type { RemoteRuntimeFactory } from "./runtime-factory.js";
import { BundledPiRuntimeFactory } from "./runtime-factory.js";
import { createV1Routes, type RemoteHonoEnv } from "./routes.js";
import { SessionRegistry } from "./session-registry.js";
import { InMemoryDurableStreamStore } from "./streams.js";

export interface CreateRemoteAppOptions {
  origin?: string;
  allowedKeys: AllowedPublicKey[];
  runtimeFactory?: RemoteRuntimeFactory;
  enableLogger?: boolean;
}

export interface RemoteAppContext {
  app: Hono<RemoteHonoEnv>;
  dispose: () => Promise<void>;
}

export function createRemoteApp(options: CreateRemoteAppOptions): RemoteAppContext {
  const app = new Hono<RemoteHonoEnv>();
  const streams = new InMemoryDurableStreamStore();
  const runtimeFactory = options.runtimeFactory ?? new BundledPiRuntimeFactory();
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

  app.use("*", requestId());
  const loggerEnabled = options.enableLogger ?? process.env.PI_REMOTE_ENABLE_LOGGER !== "0";
  if (loggerEnabled) {
    app.use("*", logger());
  }
  app.use("*", secureHeaders());
  app.use("*", cors());
  app.use("*", compress());

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
