import { describe, expect, it } from "vitest";
import {
  isRunningInCoderWorkspace,
  resolveCoderPublicBaseUrl,
} from "../src/extensions/interview/public-url.js";

describe("interview public url", () => {
  it("detects coder workspace from env", () => {
    expect(isRunningInCoderWorkspace({ CODER: "true" })).toBe(true);
    expect(isRunningInCoderWorkspace({ CODER: "false" })).toBe(false);
    expect(isRunningInCoderWorkspace({})).toBe(false);
    expect(isRunningInCoderWorkspace({ CODER: "" })).toBe(false);
  });

  it("builds wildcard access url when available", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_WILDCARD_ACCESS_URL: "https://*.coder.example.com",
        CODER_WORKSPACE_AGENT_NAME: "main",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBe("https://19847--main--pi--shekohex.coder.example.com/");
  });

  it("preserves wildcard protocol", () => {
    expect(
      resolveCoderPublicBaseUrl(3000, {
        CODER: "true",
        CODER_WILDCARD_ACCESS_URL: "http://*.coder.example.com",
        CODER_WORKSPACE_AGENT_NAME: "main",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBe("http://3000--main--pi--shekohex.coder.example.com/");
  });

  it("trims wildcard env values", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_WILDCARD_ACCESS_URL: "  https://*.coder.example.com/  ",
        CODER_WORKSPACE_AGENT_NAME: " main ",
        CODER_WORKSPACE_NAME: " pi ",
        CODER_WORKSPACE_OWNER_NAME: " shekohex ",
      }),
    ).toBe("https://19847--main--pi--shekohex.coder.example.com/");
  });

  it("builds subdomain url from coder url", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_URL: "https://coder.example.com",
        CODER_WORKSPACE_AGENT_NAME: "main",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBe("https://19847--main--pi--shekohex.coder.example.com/");
  });

  it("trims trailing slash from coder url", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_URL: "https://coder.example.com///",
        CODER_WORKSPACE_AGENT_NAME: "main",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBe("https://19847--main--pi--shekohex.coder.example.com/");
  });

  it("uses coder agent url when coder url missing", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_AGENT_URL: "https://coder-agent.example.com",
        CODER_WORKSPACE_AGENT_NAME: "main",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBe("https://19847--main--pi--shekohex.coder-agent.example.com/");
  });

  it("returns null when agent name missing", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_URL: "https://coder.example.com",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBeNull();
  });

  it("returns null outside coder workspace", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER_URL: "https://coder.example.com",
        CODER_WORKSPACE_AGENT_NAME: "main",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBeNull();
  });

  it("returns null when required env missing", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_URL: "https://coder.example.com",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBeNull();

    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_URL: "https://coder.example.com",
        CODER_WORKSPACE_NAME: "pi",
      }),
    ).toBeNull();
  });

  it("returns null when coder base urls missing", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_WORKSPACE_AGENT_NAME: "main",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBeNull();
  });

  it("falls back from incomplete wildcard env to dashboard path", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_WILDCARD_ACCESS_URL: "https://*.coder.example.com",
        CODER_URL: "https://coder.example.com",
        CODER_WORKSPACE_AGENT_NAME: "main",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBe("https://19847--main--pi--shekohex.coder.example.com/");
  });

  it("ignores blank env values", () => {
    expect(
      resolveCoderPublicBaseUrl(19847, {
        CODER: "true",
        CODER_WILDCARD_ACCESS_URL: "   ",
        CODER_URL: "   ",
        CODER_AGENT_URL: " ",
        CODER_WORKSPACE_AGENT_NAME: "   ",
        CODER_WORKSPACE_NAME: "pi",
        CODER_WORKSPACE_OWNER_NAME: "shekohex",
      }),
    ).toBeNull();
  });
});
