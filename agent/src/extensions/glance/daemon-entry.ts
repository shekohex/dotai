import { runGlanceDaemon } from "./server.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { GLANCE_DEFAULT_PORT } from "./constants.js";
import { getGlancePaths } from "./paths.js";

const GlanceDaemonEnvironmentSchema = Type.Object(
  {
    PI_GLANCE_PORT: Type.Optional(Type.String()),
    PI_GLANCE_AGENT_DIR: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const environment = Value.Check(GlanceDaemonEnvironmentSchema, process.env)
  ? Value.Parse(GlanceDaemonEnvironmentSchema, process.env)
  : {};

const parsedPort = Number(environment.PI_GLANCE_PORT ?? GLANCE_DEFAULT_PORT);

await runGlanceDaemon({
  paths: getGlancePaths(environment.PI_GLANCE_AGENT_DIR),
  port: Number.isInteger(parsedPort) ? parsedPort : GLANCE_DEFAULT_PORT,
});
