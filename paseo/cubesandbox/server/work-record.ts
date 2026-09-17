import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { agentReferenceSchema, workStatusSchema } from "../shared/contracts.js";
import {
  canonicalizeRoot,
  LEGACY_PROJECT_PREFIX,
  type ProjectScope,
} from "./project-registry.js";

const taskMetadataSchema = z
  .object({
    source: z.string().min(1),
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const activityEntrySchema = z
  .object({
    at: z.string().datetime(),
    type: z.enum([
      "created",
      "agent-created",
      "prompt-sent",
      "resumed",
      "paused",
      "error",
    ]),
    detail: z.string().min(1),
  })
  .strict();

const workRecordFields = {
  workId: z.string().uuid(),
  sandboxId: z.string().min(1),
  repositoryRoot: z.string().min(1),
  projectId: z.string().min(1),
  cubeProjectId: z.string().min(1).optional(),
  paseoProjectId: z.string().min(1).optional(),
  repository: z.string().min(1),
  sandboxDomain: z.string().min(1),
  previewPorts: z.array(z.number().int().min(1).max(65_535)),
  idleTimeoutSeconds: z.number().int().positive(),
  task: taskMetadataSchema.optional(),
  relay: z
    .object({ serverId: z.string().min(1) })
    .strict()
    .optional(),
  agents: z.array(agentReferenceSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  pausedAt: z.string().datetime().optional(),
  destroyedAt: z.string().datetime().optional(),
  status: workStatusSchema,
  ownershipStatus: z.enum(["active", "quarantined"]).optional(),
  quarantineReason: z.string().min(1).optional(),
  lastError: z.string().optional(),
  activity: z.array(activityEntrySchema),
} as const;

/** Accepts both legacy v1 and current v2 records for reads and writes. */
export const workRecordSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    ...workRecordFields,
  })
  .strict();

/** Current record shape: project identity is required before timer/resource mutations. */
export const workRecordV2Schema = workRecordSchema.extend({
  version: z.literal(2),
  cubeProjectId: z.string().min(1),
  paseoProjectId: z.string().min(1),
  ownershipStatus: z.enum(["active", "quarantined"]),
});

const workSecretsSchema = z
  .object({
    pairingUrl: z.string().url(),
  })
  .strict();

export type WorkRecord = z.infer<typeof workRecordSchema>;
export type WorkRecordV2 = z.infer<typeof workRecordV2Schema>;
export type WorkSecrets = z.infer<typeof workSecretsSchema>;

function canonicalProjectId(record: WorkRecord): string {
  return record.cubeProjectId ?? record.projectId;
}

function toMigratedRecord(
  record: WorkRecord,
  scopes: readonly ProjectScope[],
  canonicalRoot: string,
): WorkRecordV2 {
  const matches = scopes.filter(
    (scope) =>
      scope.availability === "online" && scope.canonicalRoot === canonicalRoot,
  );
  const scope = matches.length === 1 ? matches[0] : undefined;
  return {
    ...record,
    version: 2,
    repositoryRoot: canonicalRoot,
    cubeProjectId: canonicalProjectId(record),
    paseoProjectId:
      scope?.projectId ?? `${LEGACY_PROJECT_PREFIX}${record.workId}`,
    ownershipStatus: scope ? "active" : "quarantined",
    ...(scope
      ? {}
      : {
          quarantineReason:
            matches.length > 1
              ? "Legacy record matched multiple registered project roots"
              : "Legacy record root is not a registered Paseo project",
        }),
  };
}

async function writePrivateJson(
  targetPath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, targetPath);
    await stat(targetPath).then(() => undefined);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export class WorkRecordStore {
  readonly recordsDirectory: string;
  readonly secretsDirectory: string;

  constructor(readonly stateDirectory: string) {
    this.recordsDirectory = path.join(stateDirectory, "work-records");
    this.secretsDirectory = path.join(stateDirectory, "secrets");
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.recordsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.secretsDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      chmod(this.stateDirectory, 0o700),
      chmod(this.recordsDirectory, 0o700),
      chmod(this.secretsDirectory, 0o700),
    ]);
  }

  async save(record: WorkRecord): Promise<void> {
    await this.initialize();
    const validated = workRecordSchema.parse(record);
    await writePrivateJson(
      path.join(this.recordsDirectory, `${validated.workId}.json`),
      validated,
    );
  }

  async get(workId: string): Promise<WorkRecord> {
    const validatedId = z.string().uuid().parse(workId);
    const raw: unknown = JSON.parse(
      await readFile(
        path.join(this.recordsDirectory, `${validatedId}.json`),
        "utf8",
      ),
    );
    return workRecordSchema.parse(raw);
  }

  /**
   * Migrates legacy v1 records to v2 exactly when the canonical root maps to a
   * single online registered project. Ambiguous or removed roots are quarantined
   * with a stable synthetic project id so they stay visible for safe cleanup.
   */
  async migrateLegacy(scopes: readonly ProjectScope[]): Promise<void> {
    await this.initialize();
    const names = (await readdir(this.recordsDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    for (const name of names) {
      const filePath = path.join(this.recordsDirectory, name);
      const parsed = workRecordSchema.parse(
        JSON.parse(await readFile(filePath, "utf8")),
      );
      if (parsed.version !== 1) continue;
      const canonicalRoot = await canonicalizeRoot(parsed.repositoryRoot);
      await writePrivateJson(
        filePath,
        toMigratedRecord(parsed, scopes, canonicalRoot),
      );
    }
  }

  async list(repositoryRoot?: string): Promise<WorkRecord[]> {
    await this.initialize();
    const names = (await readdir(this.recordsDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    const records = await Promise.all(
      names.map(async (name) => {
        const raw: unknown = JSON.parse(
          await readFile(path.join(this.recordsDirectory, name), "utf8"),
        );
        return workRecordSchema.parse(raw);
      }),
    );
    return records
      .filter(
        (record) =>
          repositoryRoot === undefined ||
          record.repositoryRoot === repositoryRoot,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async remove(workId: string): Promise<void> {
    const validatedId = z.string().uuid().parse(workId);
    await Promise.all([
      rm(path.join(this.recordsDirectory, `${validatedId}.json`), {
        force: true,
      }),
      rm(path.join(this.secretsDirectory, `${validatedId}.json`), {
        force: true,
      }),
    ]);
  }

  async saveSecrets(workId: string, secrets: WorkSecrets): Promise<void> {
    await this.initialize();
    const validatedId = z.string().uuid().parse(workId);
    await writePrivateJson(
      path.join(this.secretsDirectory, `${validatedId}.json`),
      workSecretsSchema.parse(secrets),
    );
  }

  async getSecrets(workId: string): Promise<WorkSecrets> {
    const validatedId = z.string().uuid().parse(workId);
    const raw: unknown = JSON.parse(
      await readFile(
        path.join(this.secretsDirectory, `${validatedId}.json`),
        "utf8",
      ),
    );
    return workSecretsSchema.parse(raw);
  }
}
