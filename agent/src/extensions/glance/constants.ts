export const GLANCE_NAME = "pi-glance";
export const GLANCE_SCHEMA_VERSION = 1;
export const GLANCE_DEFAULT_PORT = 39273;
export const GLANCE_DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const GLANCE_DEFAULT_TTL_MS = 30 * 60 * 1000;
export const GLANCE_DEFAULT_MAX_IMAGES = 256;
export const GLANCE_HEARTBEAT_INTERVAL_MS = 15_000;
export const GLANCE_HEARTBEAT_FRESH_MS = 45_000;
export const GLANCE_IDLE_SHUTDOWN_MS = 90_000;
export const GLANCE_SWEEP_INTERVAL_MS = 10_000;
export const GLANCE_STARTUP_TIMEOUT_MS = 8_000;
export const GLANCE_PROBE_TIMEOUT_MS = 800;

export const GLANCE_SUPPORTED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;
