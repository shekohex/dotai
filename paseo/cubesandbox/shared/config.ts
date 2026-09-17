import { z } from "zod";

export const CUBE_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/shekohex/dotai/main/paseo/cubesandbox/shared/cube-config.schema.json";

export const cubeProjectConfigSchema = z
  .object({
    $schema: z.literal(CUBE_CONFIG_SCHEMA_URL),
    version: z.literal(1),
    project: z
      .object({
        id: z.string().min(1),
        repository: z.string().min(1),
        defaultRef: z.string().min(1),
        workspacePath: z.string().startsWith("/"),
      })
      .strict(),
    cube: z
      .object({
        apiUrl: z.string().url(),
        sandboxDomain: z.string().min(1),
      })
      .strict(),
    template: z
      .object({
        alias: z.string().min(1),
        dockerfile: z.string().min(1),
        buildContext: z.string().min(1),
        resources: z
          .object({
            cpuMillicores: z.number().int().positive(),
            memoryMb: z.number().int().positive(),
            writableLayerSize: z.string().regex(/^\d+[KMGT]$/),
          })
          .strict(),
      })
      .strict(),
    sandbox: z
      .object({
        idleTimeoutSeconds: z.number().int().positive(),
        onTimeout: z.literal("pause"),
        previewPorts: z.array(z.number().int().min(1).max(65_535)),
      })
      .strict(),
    snapshot: z
      .object({
        mode: z.literal("manual"),
        id: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export type CubeProjectConfig = z.infer<typeof cubeProjectConfigSchema>;
