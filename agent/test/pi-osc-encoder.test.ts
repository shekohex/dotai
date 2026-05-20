import { expect, test } from "vitest";
import {
  PiOscEncodingError,
  createPiOscAgentAlertSequence,
  createPiOscAgentCompactionSequence,
  createPiOscAgentProgressSequence,
  createPiOscAgentRunSequence,
  createPiOscAgentSessionSequence,
  createPiOscAgentToolSequence,
  createPiOscAgentTurnSequence,
  createPiOscHelloSequence,
  createPiOscSequence,
  isValidPiOscPayload,
  isPiOscV1Event,
  type PiOscEnvelope,
  type PiOscV1Event,
} from "../src/extensions/pi-osc/index.js";

const fixtureEnvelope: PiOscEnvelope = {
  id: "evt-1",
  ts: 1779200000000,
  source: "agent",
  sessionId: "session-1",
  cwd: "/workspace",
  seq: 1,
  data: { protocol: 1, extension: "pi-osc", version: 1 },
};

const fixturePayload =
  "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoic2Vzc2lvbi0xIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6MSwiZGF0YSI6eyJwcm90b2NvbCI6MSwiZXh0ZW5zaW9uIjoicGktb3NjIiwidmVyc2lvbiI6MX19";

const payloadByEvent: Record<PiOscV1Event, PiOscEnvelope["data"]> = {
  hello: { protocol: 1, extension: "pi-osc", version: 1 },
  "agent.session": { state: "started", reason: "startup" },
  "agent.run": { state: "running" },
  "agent.turn": { state: "running", turnIndex: 1 },
  "agent.progress": { state: "active" },
  "agent.tool": { toolCallId: "tool-1", toolName: "bash", state: "running" },
  "agent.alert": {
    kind: "provider",
    title: "Provider rate limit",
    body: "Provider returned HTTP 429.",
    severity: "warning",
    statusCode: 429,
  },
  "agent.compaction": { state: "preparing" },
};

const envelopeFor = (eventName: PiOscV1Event): PiOscEnvelope => ({
  ...fixtureEnvelope,
  data: payloadByEvent[eventName],
});

test("createPiOscSequence emits exact ST-terminated fixture", () => {
  expect(createPiOscSequence("hello", fixtureEnvelope)).toBe(
    `\u001b]6767;pi;1;hello;${fixturePayload}\u001b\\`,
  );
});

test("createPiOscSequence supports BEL terminator", () => {
  expect(createPiOscSequence("hello", fixtureEnvelope, "bel")).toBe(
    `\u001b]6767;pi;1;hello;${fixturePayload}\u0007`,
  );
});

test("event wrapper functions emit every V1 event", () => {
  expect(createPiOscHelloSequence(fixtureEnvelope)).toContain("]6767;pi;1;hello;");
  expect(createPiOscAgentSessionSequence(envelopeFor("agent.session"))).toContain(
    "]6767;pi;1;agent.session;",
  );
  expect(createPiOscAgentRunSequence(envelopeFor("agent.run"))).toContain("]6767;pi;1;agent.run;");
  expect(createPiOscAgentTurnSequence(envelopeFor("agent.turn"))).toContain(
    "]6767;pi;1;agent.turn;",
  );
  expect(createPiOscAgentProgressSequence(envelopeFor("agent.progress"))).toContain(
    "]6767;pi;1;agent.progress;",
  );
  expect(createPiOscAgentToolSequence(envelopeFor("agent.tool"))).toContain(
    "]6767;pi;1;agent.tool;",
  );
  expect(createPiOscAgentAlertSequence(envelopeFor("agent.alert"))).toContain(
    "]6767;pi;1;agent.alert;",
  );
  expect(createPiOscAgentCompactionSequence(envelopeFor("agent.compaction"))).toContain(
    "]6767;pi;1;agent.compaction;",
  );
});

test("payload uses base64url alphabet", () => {
  const sequence = createPiOscSequence("agent.run", envelopeFor("agent.run"));
  const payload = sequence.slice(sequence.lastIndexOf(";") + 1, -2);

  expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(payload).not.toContain("+");
  expect(payload).not.toContain("/");
  expect(payload).not.toContain("=");
});

test("semicolons and controls inside JSON cannot break OSC fields", () => {
  const sequence = createPiOscSequence("agent.alert", {
    ...fixtureEnvelope,
    data: {
      kind: "provider",
      title: "a;b",
      body: "line\nnext\u0007tail\u001b\\",
      severity: "warning",
    },
  });
  const fields = sequence.slice(2, -2).split(";");

  expect(fields).toHaveLength(5);
  expect(fields.slice(0, 4)).toEqual(["6767", "pi", "1", "agent.alert"]);
});

test("event names are allowlisted", () => {
  expect(isPiOscV1Event("agent.run")).toBeTruthy();
  expect(isPiOscV1Event("message_update")).toBeFalsy();
  expect(() => createPiOscSequence("message_update", fixtureEnvelope)).toThrow(PiOscEncodingError);
});

test("invalid envelopes are rejected", () => {
  expect(() =>
    createPiOscSequence("hello", {
      ...fixtureEnvelope,
      source: "test",
    }),
  ).toThrow(PiOscEncodingError);
});

test("event payloads validate against V1 schemas", () => {
  for (const [eventName, payload] of Object.entries(payloadByEvent)) {
    expect(isValidPiOscPayload(eventName as PiOscV1Event, payload)).toBeTruthy();
  }
});

test("invalid tool, alert, and progress payloads are rejected", () => {
  expect(() =>
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: { toolCallId: "tool-1", toolName: "bash", state: "running", result: "secret" },
    }),
  ).toThrow(PiOscEncodingError);

  expect(() =>
    createPiOscSequence("agent.alert", {
      ...fixtureEnvelope,
      data: { kind: "provider", title: "x", body: "y", severity: "critical" },
    }),
  ).toThrow(PiOscEncodingError);

  expect(() =>
    createPiOscSequence("agent.progress", {
      ...fixtureEnvelope,
      data: { state: "running", percent: 50 },
    }),
  ).toThrow(PiOscEncodingError);
});

test("accessor envelope fields are rejected", () => {
  const envelope: Record<string, unknown> = { ...fixtureEnvelope };
  Object.defineProperty(envelope, "id", {
    enumerable: true,
    get: () => "evt-1",
  });

  expect(() => createPiOscSequence("hello", envelope)).toThrow(PiOscEncodingError);
});

test("non-plain top-level data values are rejected", () => {
  expect(() =>
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: new Date(0),
    }),
  ).toThrow(PiOscEncodingError);
});

test("non-JSON payload values are rejected", () => {
  expect(() =>
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: { callback: () => 1 },
    }),
  ).toThrow(PiOscEncodingError);

  expect(() =>
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: { missing: undefined },
    }),
  ).toThrow(PiOscEncodingError);

  expect(() =>
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: { count: BigInt(1) },
    }),
  ).toThrow(PiOscEncodingError);
});

test("cyclic payload values are rejected", () => {
  const data: Record<string, unknown> = {};
  data.self = data;

  expect(() => createPiOscSequence("agent.tool", { ...fixtureEnvelope, data })).toThrow(
    PiOscEncodingError,
  );
});

test("sparse array payload values are rejected", () => {
  const items = ["start", , "end"];

  expect(() =>
    createPiOscSequence("agent.progress", { ...fixtureEnvelope, data: { items } }),
  ).toThrow(PiOscEncodingError);
});

test("toJSON payload values are rejected", () => {
  const data: Record<string, unknown> = { title: "safe" };
  Object.defineProperty(data, "toJSON", { value: () => "bad" });

  expect(() => createPiOscSequence("agent.alert", { ...fixtureEnvelope, data })).toThrow(
    PiOscEncodingError,
  );
});

test("accessor payload values are rejected", () => {
  const data: Record<string, unknown> = {};
  Object.defineProperty(data, "bad", {
    enumerable: true,
    get: () => {
      throw new Error("boom");
    },
  });

  expect(() => createPiOscSequence("agent.alert", { ...fixtureEnvelope, data })).toThrow(
    PiOscEncodingError,
  );
});

test("symbol-keyed payload values are rejected", () => {
  const data: Record<string | symbol, unknown> = { title: "safe" };
  data[Symbol("hidden")] = () => "bad";

  expect(() => createPiOscSequence("agent.alert", { ...fixtureEnvelope, data })).toThrow(
    PiOscEncodingError,
  );
});

test("array accessor payload values are rejected", () => {
  const items = ["safe"];
  Object.defineProperty(items, "0", {
    enumerable: true,
    get: () => {
      throw new Error("boom");
    },
  });

  expect(() =>
    createPiOscSequence("agent.progress", { ...fixtureEnvelope, data: { items } }),
  ).toThrow(PiOscEncodingError);
});

test("non-enumerable array accessor payload values are rejected", () => {
  const items = ["safe"];
  Object.defineProperty(items, "0", {
    enumerable: false,
    get: () => {
      throw new Error("boom");
    },
  });

  expect(() =>
    createPiOscSequence("agent.progress", { ...fixtureEnvelope, data: { items } }),
  ).toThrow(PiOscEncodingError);
});

test("symbol-keyed array payload values are rejected", () => {
  const items: Array<string> & Record<symbol, unknown> = ["safe"];
  items[Symbol("hidden")] = () => "bad";

  expect(() =>
    createPiOscSequence("agent.progress", { ...fixtureEnvelope, data: { items } }),
  ).toThrow(PiOscEncodingError);
});

test("array toJSON payload values are rejected", () => {
  const items = ["safe"];
  Object.defineProperty(items, "toJSON", { value: () => ["bad"] });

  expect(() =>
    createPiOscSequence("agent.progress", { ...fixtureEnvelope, data: { items } }),
  ).toThrow(PiOscEncodingError);
});

test("extra array payload properties are rejected", () => {
  const items: Array<string> & { extra?: unknown } = ["safe"];
  items.extra = () => "bad";

  expect(() =>
    createPiOscSequence("agent.progress", { ...fixtureEnvelope, data: { items } }),
  ).toThrow(PiOscEncodingError);
});

test("array subclass payload values are rejected", () => {
  class PayloadArray extends Array<string> {
    map(): Array<unknown> {
      return [() => "bad"];
    }
  }

  const items = new PayloadArray("safe");

  expect(() =>
    createPiOscSequence("agent.progress", { ...fixtureEnvelope, data: { items } }),
  ).toThrow(PiOscEncodingError);
});

test("schema-supported optional payload values are accepted", () => {
  expect(
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: {
        toolCallId: "tool-1",
        toolName: "bash",
        state: "complete",
        isError: false,
        label: "Bash",
        summary: "Completed",
      },
    }),
  ).toContain("]6767;pi;1;agent.tool;");
});

test("unsupported nested payload values are rejected", () => {
  const shared = { name: "bash" };

  expect(() =>
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: { start: shared, end: shared },
    }),
  ).toThrow(PiOscEncodingError);
});

test("unsupported __proto__ payload keys are rejected", () => {
  expect(() =>
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: JSON.parse('{"__proto__":{"name":"bash"}}'),
    }),
  ).toThrow(PiOscEncodingError);
});

test("oversized frames are rejected", () => {
  expect(() =>
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: { summary: "x".repeat(9000) },
    }),
  ).toThrow(PiOscEncodingError);
});
