import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WorkRecordStore, type WorkRecord } from "./work-record.js";

function exampleRecord(workId: string): WorkRecord {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    workId,
    sandboxId: "sandbox-1",
    repositoryRoot: "/repo",
    projectId: "widget",
    repository: "acme/widget",
    sandboxDomain: "sbx.0iq.xyz",
    previewPorts: [],
    idleTimeoutSeconds: 300,
    relay: { serverId: "remote-1" },
    agents: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    status: "ready",
    activity: [
      { at: timestamp, type: "created", detail: "Created Work Sandbox" },
    ],
  };
}

describe("WorkRecordStore", () => {
  it("persists private validated records and secrets", async () => {
    const stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cube-record-test-"),
    );
    const store = new WorkRecordStore(stateDirectory);
    const workId = "f4e30d8d-ef62-4b9d-ac62-3c3875660018";
    await store.save(exampleRecord(workId));
    await store.saveSecrets(workId, {
      pairingUrl: "https://app.paseo.sh/#offer=secret",
    });

    expect((await store.get(workId)).sandboxId).toBe("sandbox-1");
    expect((await store.getSecrets(workId)).pairingUrl).toContain("#offer=");
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(store.recordsDirectory)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(path.join(store.recordsDirectory, `${workId}.json`))).mode &
        0o777,
    ).toBe(0o600);
    expect(
      (await stat(path.join(store.secretsDirectory, `${workId}.json`))).mode &
        0o777,
    ).toBe(0o600);
  });
});
