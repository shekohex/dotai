import { describe, expect, test } from "vitest";
import { createNotifyAuthHeaders } from "../src/extensions/notify/auth.js";

describe("notify auth", () => {
  test("uses bearer token for plain token", () => {
    const result = createNotifyAuthHeaders("tk_123", false);
    expect(result.mode).toBe("bearer");
    expect(result.headers.Authorization).toBe("Bearer tk_123");
  });

  test("uses basic auth for username password", () => {
    const result = createNotifyAuthHeaders("user:pass", false);
    expect(result.mode).toBe("basic");
    expect(result.headers.Authorization).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
  });

  test("supports anonymous when missing", () => {
    const result = createNotifyAuthHeaders(undefined, true);
    expect(result.mode).toBe("anonymous");
    expect(result.configured).toBe(false);
  });
});
