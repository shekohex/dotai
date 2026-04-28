import { serve } from "@hono/node-server";
import { createServer } from "node:http";
import { createRemoteApp } from "./app.js";
import { parseAllowedKeys } from "./auth.js";

const port = Number.parseInt(process.env.PI_REMOTE_PORT ?? process.env.PORT ?? "3141", 10);
const hostname = process.env.PI_REMOTE_HOST ?? process.env.HOST ?? "0.0.0.0";
const origin = process.env.PI_REMOTE_ORIGIN ?? `http://localhost:${port}`;
const allowedKeys = parseAllowedKeys(process.env.PI_REMOTE_ALLOWED_KEYS);

if (allowedKeys.length === 0) {
  throw new Error("PI_REMOTE_ALLOWED_KEYS must contain at least one key");
}

const { app, dispose } = createRemoteApp({
  origin,
  allowedKeys,
});

const server = serve(
  {
    fetch: app.fetch,
    port,
    hostname,
    createServer,
  },
  (info) => {
    console.log(`pi-remote running on ${origin} via ${hostname}:${info.port}`);
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
