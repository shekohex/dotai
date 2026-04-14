import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
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

  assert.equal(parseKey("\x1b[115;7u"), "ctrl+alt+s");
  assert.equal(matchesKey("\x1b[115;7u", "ctrl+alt+s"), true);
  assert.equal(matchesKey("\x1b[112;7u", "ctrl+alt+p"), true);
  assert.equal(matchesKey("\x1b[111;7u", "ctrl+alt+o"), true);
  assert.equal(matchesKey("\x1b[115;7u", "ctrl+alt+p"), false);
});

test("matches ctrl+alt letter shortcuts via xterm modifyOtherKeys when kitty protocol is inactive", () => {
  setKittyProtocolActive(false);

  assert.equal(parseKey("\x1b[27;7;115~"), "ctrl+alt+s");
  assert.equal(matchesKey("\x1b[27;7;115~", "ctrl+alt+s"), true);
  assert.equal(matchesKey("\x1b[27;7;112~", "ctrl+alt+p"), true);
  assert.equal(matchesKey("\x1b[27;7;111~", "ctrl+alt+o"), true);
  assert.equal(matchesKey("\x1b[27;7;115~", "ctrl+alt+p"), false);
});

test("matches uppercase ctrl+shift letters via CSI-u", () => {
  setKittyProtocolActive(false);

  assert.equal(parseKey("\x1b[83;6u"), "shift+ctrl+s");
  assert.equal(matchesKey("\x1b[83;6u", "ctrl+shift+s"), true);
  assert.equal(matchesKey("\x1b[80;6u", "ctrl+shift+p"), true);
  assert.equal(matchesKey("\x1b[83;6u", "ctrl+shift+p"), false);
});

test("matches uppercase ctrl+shift letters via xterm modifyOtherKeys", () => {
  setKittyProtocolActive(false);

  assert.equal(parseKey("\x1b[27;6;83~"), "shift+ctrl+s");
  assert.equal(matchesKey("\x1b[27;6;83~", "ctrl+shift+s"), true);
  assert.equal(matchesKey("\x1b[27;6;80~", "ctrl+shift+p"), true);
  assert.equal(matchesKey("\x1b[27;6;83~", "ctrl+shift+p"), false);
});

test("matches uppercase shift letters via xterm modifyOtherKeys", () => {
  setKittyProtocolActive(false);

  assert.equal(parseKey("\x1b[27;2;83~"), "shift+s");
  assert.equal(matchesKey("\x1b[27;2;83~", "shift+s"), true);
  assert.equal(matchesKey("\x1b[27;2;80~", "shift+p"), true);
  assert.equal(matchesKey("\x1b[27;2;83~", "shift+p"), false);
});

test("preserves legacy ctrl+alt matching when kitty protocol is inactive", () => {
  setKittyProtocolActive(false);

  assert.equal(parseKey("\x1b\x13"), "ctrl+alt+s");
  assert.equal(matchesKey("\x1b\x13", "ctrl+alt+s"), true);
  assert.equal(matchesKey("\x1b\x10", "ctrl+alt+p"), true);
  assert.equal(matchesKey("\x1b\x13", "ctrl+alt+p"), false);
});
