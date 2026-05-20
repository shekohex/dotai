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
  isPiOscV1Event,
  type PiOscEnvelope,
} from "../src/extensions/pi-osc/index.js";

const fixtureEnvelope: PiOscEnvelope = {
  id: "evt-1",
  ts: 1779200000000,
  source: "agent",
  sessionId: "session-1",
  cwd: "/workspace",
  seq: 1,
  data: { protocol: 1 },
};

const fixturePayload =
  "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoic2Vzc2lvbi0xIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6MSwiZGF0YSI6eyJwcm90b2NvbCI6MX19";

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
  expect(createPiOscAgentSessionSequence(fixtureEnvelope)).toContain("]6767;pi;1;agent.session;");
  expect(createPiOscAgentRunSequence(fixtureEnvelope)).toContain("]6767;pi;1;agent.run;");
  expect(createPiOscAgentTurnSequence(fixtureEnvelope)).toContain("]6767;pi;1;agent.turn;");
  expect(createPiOscAgentProgressSequence(fixtureEnvelope)).toContain("]6767;pi;1;agent.progress;");
  expect(createPiOscAgentToolSequence(fixtureEnvelope)).toContain("]6767;pi;1;agent.tool;");
  expect(createPiOscAgentAlertSequence(fixtureEnvelope)).toContain("]6767;pi;1;agent.alert;");
  expect(createPiOscAgentCompactionSequence(fixtureEnvelope)).toContain(
    "]6767;pi;1;agent.compaction;",
  );
});

test("payload uses base64url alphabet", () => {
  const sequence = createPiOscSequence("agent.run", fixtureEnvelope);
  const payload = sequence.slice(sequence.lastIndexOf(";") + 1, -2);

  expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(payload).not.toContain("+");
  expect(payload).not.toContain("/");
  expect(payload).not.toContain("=");
});

test("semicolons and controls inside JSON cannot break OSC fields", () => {
  const sequence = createPiOscSequence("agent.alert", {
    ...fixtureEnvelope,
    data: { title: "a;b", body: "line\nnext\u0007tail\u001b\\" },
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

test("nested JSON payload values are accepted", () => {
  expect(
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: { tool: { name: "bash", args: ["echo", "ok"], result: null } },
    }),
  ).toContain("]6767;pi;1;agent.tool;");
});

test("shared acyclic payload values are accepted", () => {
  const shared = { name: "bash" };

  expect(
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: { start: shared, end: shared },
    }),
  ).toContain("]6767;pi;1;agent.tool;");
});

test("__proto__ payload keys are preserved", () => {
  const sequence = createPiOscSequence("agent.tool", {
    ...fixtureEnvelope,
    data: JSON.parse('{"__proto__":{"name":"bash"}}'),
  });
  const payload = sequence.slice(sequence.lastIndexOf(";") + 1, -2);
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

  expect(decoded.data.__proto__).toEqual({ name: "bash" });
});

test("oversized frames are rejected", () => {
  expect(() =>
    createPiOscSequence("agent.tool", {
      ...fixtureEnvelope,
      data: { summary: "x".repeat(9000) },
    }),
  ).toThrow(PiOscEncodingError);
});
