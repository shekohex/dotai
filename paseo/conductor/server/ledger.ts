import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { workerRecordSchema, type WorkerRecords } from "./health.js";

const ledgerSchema = z
  .object({
    version: z.literal(1),
    workers: z.record(z.string(), workerRecordSchema),
  })
  .strict();

export class LedgerStore {
  constructor(private readonly file: string) {}

  async load(): Promise<WorkerRecords> {
    const text = await readFile(this.file, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (text === null) return {};
    return ledgerSchema.parse(JSON.parse(text)).workers;
  }

  async save(workers: WorkerRecords): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, workers }, null, 2)}\n`,
    );
    await rename(temporary, this.file);
  }
}
