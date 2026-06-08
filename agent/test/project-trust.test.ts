import { expect } from "vitest";
import { isDefaultTrustedProjectPath } from "../src/extensions/project-trust.js";
import { timedTest } from "./test-utils/timed-test.ts";

timedTest("default project trust allows configured roots and descendants only", () => {
  expect(isDefaultTrustedProjectPath("/home/coder/project")).toBe(true);
  expect(isDefaultTrustedProjectPath("/home/coder/project/app")).toBe(true);
  expect(isDefaultTrustedProjectPath("/home/coder/dotai")).toBe(true);
  expect(isDefaultTrustedProjectPath("/home/coder/dotai/agent")).toBe(true);

  expect(isDefaultTrustedProjectPath("/home/coder/project-other")).toBe(false);
  expect(isDefaultTrustedProjectPath("/home/coder/dotai-other")).toBe(false);
  expect(isDefaultTrustedProjectPath("/home/coder")).toBe(false);
});
