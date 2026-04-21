import { serve } from "@hono/node-server";
import { createRemoteApp } from "./app.js";
import { parseAllowedKeys } from "./auth.js";
import { InMemoryPiRuntimeFactory } from "./runtime-factory.js";

const port = Number.parseInt(process.env.PI_REMOTE_PORT ?? process.env.PORT ?? "3000", 10);
const origin = process.env.PI_REMOTE_ORIGIN ?? `http://localhost:${port}`;
const allowedKeys = parseAllowedKeys(process.env.PI_REMOTE_ALLOWED_KEYS);
const runtimeMode = process.env.PI_REMOTE_RUNTIME ?? "real";

if (allowedKeys.length === 0) {
  throw new Error("PI_REMOTE_ALLOWED_KEYS must contain at least one key");
}

const { app, dispose } = createRemoteApp({
  origin,
  allowedKeys,
  runtimeFactory: runtimeMode === "faux" ? InMemoryPiRuntimeFactory() : undefined,
});

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`pi-remote running on ${origin} (port ${info.port})`);
  },
);

const shutdown = async (): Promise<void> => {
  server.close();
  await dispose();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
