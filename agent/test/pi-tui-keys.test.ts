import { afterEach, expect, test } from "vitest";
import {
  matchesKey,
  parseKey,
  setKittyProtocolActive,
} from "../node_modules/@mariozechner/pi-tui/dist/keys.js";

afterEach(() => {
  setKittyProtocolActive(false);
});

test("matches ctrl+alt letter shortcuts via CSI-u when kitty protocol is inactive", () => {
  setKittyProtocolActive(false);

  expect(parseKey("\x1B[115;7u")).toBe("ctrl+alt+s");
  expect(matchesKey("\x1B[115;7u", "ctrl+alt+s")).toBe(true);
  expect(matchesKey("\u001b[112;7u", "ctrl+alt+p")).toBe(true);
  expect(matchesKey("\x1B[111;7u", "ctrl+alt+o")).toBe(true);
  expect(matchesKey("\x1B[115;7u", "ctrl+alt+p")).toBe(false);
});

test("matches ctrl+alt letter shortcuts via xterm modifyOtherKeys when kitty protocol is inactive", () => {
  setKittyProtocolActive(false);

  expect(parseKey("\x1B[27;7;115~")).toBe("ctrl+alt+s");
  expect(matchesKey("\x1B[27;7;115~", "ctrl+alt+s")).toBe(true);
  expect(matchesKey("\x1B[27;7;112~", "ctrl+alt+p")).toBe(true);
  expect(matchesKey("\x1B[27;7;111~", "ctrl+alt+o")).toBe(true);
  expect(matchesKey("\x1B[27;7;115~", "ctrl+alt+p")).toBe(false);
});

test("matches uppercase ctrl+shift letters via CSI-u", () => {
  setKittyProtocolActive(false);

  expect(parseKey("\u001b[83;6u")).toBe("shift+ctrl+s");
  expect(matchesKey("\x1B[83;6u", "ctrl+shift+s")).toBe(true);
  expect(matchesKey("\u001b[80;6u", "ctrl+shift+p")).toBe(true);
  expect(matchesKey("\x1B[83;6u", "ctrl+shift+p")).toBe(false);
});

test("matches uppercase ctrl+shift letters via xterm modifyOtherKeys", () => {
  setKittyProtocolActive(false);

  expect(parseKey("\x1B[27;6;83~")).toBe("shift+ctrl+s");
  expect(matchesKey("\x1B[27;6;83~", "ctrl+shift+s")).toBe(true);
  expect(matchesKey("\u001b[27;6;80~", "ctrl+shift+p")).toBe(true);
  expect(matchesKey("\x1B[27;6;83~", "ctrl+shift+p")).toBe(false);
});

test("matches uppercase shift letters via xterm modifyOtherKeys", () => {
  setKittyProtocolActive(false);

  expect(parseKey("\x1B[27;2;83~")).toBe("shift+s");
  expect(matchesKey("\x1B[27;2;83~", "shift+s")).toBe(true);
  expect(matchesKey("\u001b[27;2;80~", "shift+p")).toBe(true);
  expect(matchesKey("\x1B[27;2;83~", "shift+p")).toBe(false);
});

test("preserves legacy ctrl+alt matching when kitty protocol is inactive", () => {
  setKittyProtocolActive(false);

  expect(parseKey("\x1B\x13")).toBe("ctrl+alt+s");
  expect(matchesKey("\x1B\x13", "ctrl+alt+s")).toBe(true);
  expect(matchesKey("\x1B\x10", "ctrl+alt+p")).toBe(true);
  expect(matchesKey("\x1B\x13", "ctrl+alt+p")).toBe(false);
});
