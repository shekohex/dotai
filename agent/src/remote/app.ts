import { Hono } from "hono";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { AllowedPublicKey } from "./auth.js";
import { AuthService } from "./auth.js";
import {
  compress,
  configureLogger,
  cors,
  logger,
  openAPIRouteHandler,
  requestId,
  type RemoteLoggerOptions,
  secureHeaders,
} from "./http-adapters.js";
import { JsonFileRemoteKvStore } from "./kv/json-file-store.js";
import type { RemoteKvStore } from "./kv/store.js";
import type { RemoteRuntimeFactory } from "./runtime-factory.js";
import { BundledPiRuntimeFactory } from "./runtime-factory.js";
import { createV1Routes, type RemoteHonoEnv } from "./routes.js";
import { SessionCatalog } from "./session-catalog.js";
import { SessionCatalogWatcher } from "./session-catalog-watcher.js";
import { SessionRegistry } from "./session-registry.js";
import { InMemoryDurableStreamStore } from "./streams.js";

export interface CreateRemoteAppOptions {
  origin?: string;
  allowedKeys: AllowedPublicKey[];
  runtimeFactory?: RemoteRuntimeFactory;
  kvStore?: RemoteKvStore;
  kvFilePath?: string;
  sessionCatalogRoot?: string;
  enableLogger?: boolean;
  loggerOptions?: Partial<RemoteLoggerOptions>;
}

export interface RemoteAppContext {
  app: Hono<RemoteHonoEnv>;
  dispose: () => Promise<void>;
}

function createOpenApiHandler(app: Hono<RemoteHonoEnv>, origin: string) {
  return openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "pi-remote API",
        version: "0.1.0",
        description: "Remote headless Pi daemon API",
      },
      servers: [{ url: origin }],
    },
    exclude: ["/openapi.json"],
  });
}

function createDispose(
  sessions: SessionRegistry,
  watcher: SessionCatalogWatcher | undefined,
): () => Promise<void> {
  return async () => {
    await watcher?.dispose();
    await sessions.dispose();
  };
}

function parseMaxBodyChars(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "8000", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 8_000;
  }
  return parsed;
}

export function createRemoteApp(options: CreateRemoteAppOptions): RemoteAppContext {
  const origin = options.origin ?? "http://localhost:3000";
  const app = new Hono<RemoteHonoEnv>();
  const streams = new InMemoryDurableStreamStore();
  const kv =
    options.kvStore ??
    new JsonFileRemoteKvStore({ filePath: options.kvFilePath ?? defaultRemoteKvFilePath() });
  const runtimeFactory = options.runtimeFactory ?? new BundledPiRuntimeFactory();
  const catalog = new SessionCatalog({
    rootDir: options.sessionCatalogRoot ?? defaultSessionCatalogRoot(runtimeFactory),
  });
  const auth = new AuthService({
    origin,
    allowedKeys: options.allowedKeys,
  });
  const sessions = new SessionRegistry({
    streams,
    runtimeFactory,
    catalog,
  });
  const watcher = new SessionCatalogWatcher({
    rootDir: options.sessionCatalogRoot ?? defaultSessionCatalogRoot(runtimeFactory),
    onChange: () => sessions.reconcileCatalogFromDisk(),
  });
  watcher.start();

  const v1 = createV1Routes({
    auth,
    sessions,
    kv,
    streams,
  });

  app.use("*", requestId());
  const loggerConfig = configureLogger({
    enabled: options.enableLogger ?? process.env.PI_REMOTE_ENABLE_LOGGER !== "0",
    pretty: process.env.PI_REMOTE_LOG_PRETTY !== "0",
    color: process.env.PI_REMOTE_LOG_COLOR === "0" ? false : process.stdout.isTTY,
    logSse: process.env.PI_REMOTE_LOG_SSE !== "0",
    maxBodyChars: parseMaxBodyChars(process.env.PI_REMOTE_LOG_MAX_BODY_CHARS),
    ...options.loggerOptions,
  });
  app.use("*", secureHeaders());
  app.use("*", cors());
  app.use("*", compress());
  if (loggerConfig.enabled) {
    app.use("*", logger(loggerConfig));
  }

  app.route("/v1", v1);
  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "pi-remote",
    }),
  );
  app.get("/openapi.json", createOpenApiHandler(app, origin));

  return {
    app,
    dispose: createDispose(sessions, watcher),
  };
}

function defaultRemoteKvFilePath(): string {
  return process.env.PI_REMOTE_KV_FILE ?? join(process.cwd(), ".pi", "remote-kv.json");
}

function defaultSessionCatalogRoot(
  runtimeFactory: RemoteRuntimeFactory | undefined,
): string | undefined {
  const runtimeCatalogRoot = runtimeFactory?.getSessionCatalogRoot?.();
  if (runtimeCatalogRoot !== undefined && runtimeCatalogRoot.length > 0) {
    return runtimeCatalogRoot;
  }
  return runtimeFactory === undefined ? join(getAgentDir(), "sessions") : undefined;
}

export type RemoteApiApp = ReturnType<typeof createRemoteApp>["app"];
