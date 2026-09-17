import { mkdtemp, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ProjectScope } from "./project-registry.js";
import {
  WorkRecordStore,
  workRecordV2Schema,
  type WorkRecord,
} from "./work-record.js";

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

  it("migrates a v1 record when its canonical root maps to one project", async () => {
    const stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cube-record-test-"),
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "cube-record-root-"));
    const canonicalRoot = await realpath(root);
    const store = new WorkRecordStore(stateDirectory);
    const workId = "f4e30d8d-ef62-4b9d-ac62-3c3875660019";
    await store.save({ ...exampleRecord(workId), repositoryRoot: root });

    await store.migrateLegacy([
      scope("prj_alpha", canonicalRoot),
      scope("prj_beta", path.join(canonicalRoot, "nested")),
    ]);

    const migrated = workRecordV2Schema.parse(await store.get(workId));
    expect(migrated.paseoProjectId).toBe("prj_alpha");
    expect(migrated.cubeProjectId).toBe("widget");
    expect(migrated.repositoryRoot).toBe(canonicalRoot);
    expect(migrated.ownershipStatus).toBe("active");
    expect(migrated.quarantineReason).toBeUndefined();

    await store.migrateLegacy([scope("prj_alpha", canonicalRoot)]);
    expect((await store.get(workId)).paseoProjectId).toBe("prj_alpha");
  });

  it("quarantines v1 records with ambiguous or removed roots", async () => {
    const stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cube-record-test-"),
    );
    const removedRoot = await mkdtemp(
      path.join(os.tmpdir(), "cube-record-removed-"),
    );
    const sharedRoot = await mkdtemp(
      path.join(os.tmpdir(), "cube-record-shared-"),
    );
    const canonicalShared = await realpath(sharedRoot);
    const store = new WorkRecordStore(stateDirectory);
    const removedId = "f4e30d8d-ef62-4b9d-ac62-3c3875660021";
    const ambiguousId = "f4e30d8d-ef62-4b9d-ac62-3c3875660022";
    await store.save({
      ...exampleRecord(removedId),
      repositoryRoot: removedRoot,
    });
    await store.save({
      ...exampleRecord(ambiguousId),
      repositoryRoot: sharedRoot,
    });

    await store.migrateLegacy([
      scope("prj_one", canonicalShared),
      scope("prj_two", canonicalShared),
    ]);

    const removed = workRecordV2Schema.parse(await store.get(removedId));
    expect(removed.ownershipStatus).toBe("quarantined");
    expect(removed.paseoProjectId).toBe(`legacy:${removedId}`);
    expect(removed.quarantineReason).toContain(
      "not a registered Paseo project",
    );

    const ambiguous = workRecordV2Schema.parse(await store.get(ambiguousId));
    expect(ambiguous.ownershipStatus).toBe("quarantined");
    expect(ambiguous.quarantineReason).toContain("multiple registered");
  });
});

function scope(projectId: string, canonicalRoot: string): ProjectScope {
  return {
    projectId,
    displayName: projectId,
    declaredRoot: canonicalRoot,
    canonicalRoot,
    availability: "online",
  };
}
