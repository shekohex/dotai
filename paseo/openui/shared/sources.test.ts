import { describe, expect, it } from "vitest";
import { expandEnv, parseFrame, parseOutput, SourceError, specProblems, STREAM_DONE, unwrapRpc, withDefaults } from "./sources";

describe("source output", () => {
  it("reads one JSON document, or the last line of NDJSON", () => {
    expect(parseOutput('{"cpu": 42}\n')).toEqual({ cpu: 42 });
    expect(parseOutput("[1,2]")).toEqual([1, 2]);
    expect(parseOutput('{"n":1}\n{"n":2}\n\n')).toEqual({ n: 2 });
    expect(parseOutput('warming up\n{"n":3}')).toEqual({ n: 3 });
  });

  it("says what is wrong with output that is not JSON", () => {
    expect(() => parseOutput("")).toThrow(/printed nothing/);
    expect(() => parseOutput("Traceback (most recent call last)")).toThrow(SourceError);
    try {
      parseOutput("<html>502</html>");
    } catch (error) {
      expect((error as SourceError).kind).toBe("parse");
      expect((error as SourceError).detail).toContain("<html>502</html>");
    }
  });

  it("unwraps JSON-RPC replies and reports their errors", () => {
    expect(unwrapRpc({ jsonrpc: "2.0", id: 1, result: { cpu: 1 } })).toEqual({ cpu: 1 });
    expect(unwrapRpc({ cpu: 1 })).toEqual({ cpu: 1 });
    expect(unwrapRpc({ jsonrpc: "2.0", id: 1 })).toBeNull();
    expect(() => unwrapRpc({ jsonrpc: "2.0", error: { code: -32000, message: "db down" } })).toThrow(/db down/);
    expect(() => parseOutput('{"jsonrpc":"2.0","error":{"message":"nope"}}')).toThrow(/nope/);
  });
});

describe("stream lines", () => {
  it("reads NDJSON and SSE alike", () => {
    expect(parseFrame('{"a":1}')).toEqual({ a: 1 });
    expect(parseFrame('data: {"a":2}')).toEqual({ a: 2 });
    expect(parseFrame("data:[1,2]")).toEqual([1, 2]);
    expect(parseFrame("")).toBeUndefined();
    expect(parseFrame(": keep-alive")).toBeUndefined();
    expect(parseFrame("event: tick")).toBeUndefined();
    expect(parseFrame("id: 7")).toBeUndefined();
    expect(parseFrame("data: [DONE]")).toBe(STREAM_DONE);
  });

  it("fails on a line that is not JSON", () => {
    expect(() => parseFrame("hello")).toThrow(/not JSON/);
  });
});

describe("specs", () => {
  it("fills defaults by mode", () => {
    expect(withDefaults({ type: "command", run: "x" })).toMatchObject({ mode: "once", timeoutSeconds: 10, window: 1, access: "read" });
    expect(withDefaults({ type: "command", run: "x", mode: "stream" })).toMatchObject({ timeoutSeconds: 30 });
    expect(withDefaults({ type: "command", run: "x", timeoutSeconds: 90 }).timeoutSeconds).toBe(90);
  });

  it("rejects specs that cannot run", () => {
    expect(specProblems(withDefaults({ type: "command" }))).toHaveLength(1);
    expect(specProblems(withDefaults({ type: "http", url: "ftp://x" }))).toHaveLength(1);
    expect(specProblems(withDefaults({ type: "http", url: "https://x", mode: "stream", access: "write" }))).toHaveLength(1);
    expect(specProblems(withDefaults({ type: "command", run: "x", timeoutSeconds: 0 }))).toHaveLength(1);
    expect(specProblems(withDefaults({ type: "command", run: "x", mode: "stream", timeoutSeconds: 0 }))).toEqual([]);
    expect(specProblems(withDefaults({ type: "command", run: "x" }))).toEqual([]);
  });

  it("expands environment references", () => {
    expect(expandEnv("Bearer ${TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
    expect(expandEnv("${MISSING}x", {})).toBe("x");
  });
});
