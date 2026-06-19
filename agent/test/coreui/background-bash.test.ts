import { describe, expect, test } from "vitest";
import {
  diffPollOutput,
  parseBackgroundCommand,
} from "../../src/extensions/coreui/background-bash.js";

describe("parseBackgroundCommand", () => {
  test("detects trailing ampersand", () => {
    expect(parseBackgroundCommand("npm run dev &")).toEqual({ command: "npm run dev" });
  });

  test("trims background operator whitespace", () => {
    expect(parseBackgroundCommand("  npm run dev   &   ")).toEqual({ command: "  npm run dev" });
  });

  test("detects trailing ampersand across multiline commands", () => {
    expect(parseBackgroundCommand("for i in 1 2; do\n  echo $i\ndone &")).toEqual({
      command: "for i in 1 2; do\n  echo $i\ndone",
    });
  });

  test("detects final background command after internal multiline comment", () => {
    expect(parseBackgroundCommand("echo before # internal\nnpm run dev & # poll:5000")).toEqual({
      command: "echo before # internal\nnpm run dev",
      pollIntervalMs: 5000,
    });
  });

  test("ignores non-trailing background before later multiline command", () => {
    expect(parseBackgroundCommand("npm run dev &\necho done")).toBeUndefined();
  });

  test("ignores background operator inside command substitution", () => {
    expect(parseBackgroundCommand('echo "$(sleep 1 & echo done)"')).toBeUndefined();
  });

  test("ignores background operator inside unquoted command substitution", () => {
    expect(parseBackgroundCommand("echo $(sleep 1 & echo done)")).toBeUndefined();
  });

  test("ignores comment inside command substitution", () => {
    expect(parseBackgroundCommand('echo $(echo "# poll:5000") & # poll:2000')).toEqual({
      command: 'echo $(echo "# poll:5000")',
      pollIntervalMs: 2000,
    });
  });

  test("ignores ampersand inside backticks", () => {
    expect(parseBackgroundCommand("echo `sleep 1 & echo done`")).toBeUndefined();
  });

  test("detects grouped command background", () => {
    expect(parseBackgroundCommand("(npm run dev) & # poll:5000")).toEqual({
      command: "(npm run dev)",
      pollIntervalMs: 5000,
    });
  });

  test("detects brace group background", () => {
    expect(parseBackgroundCommand("{ echo hi; echo bye; } & # poll:2s")).toEqual({
      command: "{ echo hi; echo bye; }",
      pollIntervalMs: 2000,
    });
  });

  test("ignores background operator inside non-background group", () => {
    expect(parseBackgroundCommand("(npm run dev &)")).toBeUndefined();
  });

  test("does not treat logical and as background", () => {
    expect(parseBackgroundCommand("npm test && npm run lint")).toBeUndefined();
  });

  test("does not treat trailing logical and as background", () => {
    expect(parseBackgroundCommand("npm test &&")).toBeUndefined();
  });

  test("detects trailing background after logical and", () => {
    expect(parseBackgroundCommand("npm test && npm run lint & # poll:3000")).toEqual({
      command: "npm test && npm run lint",
      pollIntervalMs: 3000,
    });
  });

  test("detects trailing background after logical or", () => {
    expect(parseBackgroundCommand("npm test || npm run lint &")).toEqual({
      command: "npm test || npm run lint",
    });
  });

  test("detects trailing background after pipe", () => {
    expect(parseBackgroundCommand("npm test | tee test.log &")).toEqual({
      command: "npm test | tee test.log",
    });
  });

  test("ignores comment after semicolon before ampersand", () => {
    expect(parseBackgroundCommand("echo foo;# poll:5000 &")).toBeUndefined();
  });

  test("ignores comment after pipe before ampersand", () => {
    expect(parseBackgroundCommand("echo foo |# poll:5000 &")).toBeUndefined();
  });

  test("detects poll comment after trailing ampersand", () => {
    expect(parseBackgroundCommand("npm run dev & # poll:5000")).toEqual({
      command: "npm run dev",
      pollIntervalMs: 5000,
    });
  });

  test("detects poll comment without whitespace after ampersand", () => {
    expect(parseBackgroundCommand("npm run dev &# poll:5000")).toEqual({
      command: "npm run dev",
      pollIntervalMs: 5000,
    });
  });

  test("detects fuzzy poll assignment syntax", () => {
    expect(parseBackgroundCommand("npm run dev & # poll = 5000")).toEqual({
      command: "npm run dev",
      pollIntervalMs: 5000,
    });
  });

  test("detects fuzzy poll whitespace syntax", () => {
    expect(parseBackgroundCommand("npm run dev & # poll 5000")).toEqual({
      command: "npm run dev",
      pollIntervalMs: 5000,
    });
  });

  test("detects tabs around background and poll syntax", () => {
    expect(parseBackgroundCommand("npm run dev\t&\t#\tpoll:5000")).toEqual({
      command: "npm run dev",
      pollIntervalMs: 5000,
    });
  });

  test("detects seconds poll unit", () => {
    expect(parseBackgroundCommand("npm run dev & # poll:5s")).toEqual({
      command: "npm run dev",
      pollIntervalMs: 5000,
    });
  });

  test("detects verbose seconds poll unit", () => {
    expect(parseBackgroundCommand("npm run dev & # POLL:2 seconds")).toEqual({
      command: "npm run dev",
      pollIntervalMs: 2000,
    });
  });

  test("clamps too-small poll interval", () => {
    expect(parseBackgroundCommand("npm run dev & # poll:10")).toEqual({
      command: "npm run dev",
      pollIntervalMs: 1000,
    });
  });

  test("keeps background when trailing comment is not poll syntax", () => {
    expect(parseBackgroundCommand("npm run dev & # starts server")).toEqual({
      command: "npm run dev",
    });
  });

  test("keeps background when poll syntax is invalid", () => {
    expect(parseBackgroundCommand("npm run dev & # poll:soon")).toEqual({
      command: "npm run dev",
    });
  });

  test("keeps background when decimal poll syntax is unsupported", () => {
    expect(parseBackgroundCommand("npm run dev & # poll:0.5s")).toEqual({
      command: "npm run dev",
    });
  });

  test("ignores ampersand inside quotes", () => {
    expect(parseBackgroundCommand('echo "a &"')).toBeUndefined();
  });

  test("ignores escaped trailing ampersand", () => {
    expect(parseBackgroundCommand("echo a \\\&")).toBeUndefined();
  });

  test("ignores ampersand in single quotes", () => {
    expect(parseBackgroundCommand("echo 'a &'")).toBeUndefined();
  });

  test("ignores comment marker inside quotes", () => {
    expect(parseBackgroundCommand('echo "# poll:5000" &')).toEqual({
      command: 'echo "# poll:5000"',
    });
  });

  test("ignores inline hash that is not a shell comment", () => {
    expect(parseBackgroundCommand("echo foo#bar &")).toEqual({ command: "echo foo#bar" });
  });

  test("handles escaped hash before real poll comment", () => {
    expect(parseBackgroundCommand("echo \\#text & # poll:2000")).toEqual({
      command: "echo \\#text",
      pollIntervalMs: 2000,
    });
  });

  test("detects redirect to fd before trailing background", () => {
    expect(parseBackgroundCommand("cmd > out 2>&1 & # poll:5s")).toEqual({
      command: "cmd > out 2>&1",
      pollIntervalMs: 5000,
    });
  });

  test("does not treat fd redirect as background", () => {
    expect(parseBackgroundCommand("cmd 2>&1")).toBeUndefined();
  });

  test("detects ampersand redirect before trailing background", () => {
    expect(parseBackgroundCommand("cmd &> out &")).toEqual({ command: "cmd &> out" });
  });

  test("does not treat ampersand redirect as background", () => {
    expect(parseBackgroundCommand("cmd &> out")).toBeUndefined();
  });

  test("detects heredoc with background after delimiter", () => {
    expect(parseBackgroundCommand("cat <<EOF\nhello\nEOF &")).toEqual({
      command: "cat <<EOF\nhello\nEOF",
    });
  });

  test("detects heredoc with background before body", () => {
    expect(parseBackgroundCommand("cat <<EOF &\nhello\nEOF")).toEqual({
      command: "cat <<EOF\nhello\nEOF",
    });
  });

  test("detects quoted heredoc delimiter with poll", () => {
    expect(parseBackgroundCommand("cat <<'EOF' & # poll:3000")).toEqual({
      command: "cat <<'EOF'",
      pollIntervalMs: 3000,
    });
  });

  test("detects process substitution with trailing background", () => {
    expect(parseBackgroundCommand("diff <(sort a &) <(sort b) &")).toEqual({
      command: "diff <(sort a &) <(sort b)",
    });
  });

  test("detects function definition with trailing background", () => {
    expect(parseBackgroundCommand("f() { echo hi; } &")).toEqual({
      command: "f() { echo hi; }",
    });
  });

  test("detects final background command when earlier line is background", () => {
    expect(parseBackgroundCommand("cmd1 & # poll:1000\ncmd2 & # poll:2000")).toEqual({
      command: "cmd1 & # poll:1000\ncmd2",
      pollIntervalMs: 2000,
    });
  });

  test("ignores poll comment without background operator", () => {
    expect(parseBackgroundCommand("npm run dev # poll:5000")).toBeUndefined();
  });

  test("ignores ampersand after a shell comment", () => {
    expect(parseBackgroundCommand("npm run dev # poll:5000 &")).toBeUndefined();
  });

  test("ignores trailing poll comment when later command follows", () => {
    expect(parseBackgroundCommand("npm run dev & # poll:5000\necho later")).toBeUndefined();
  });

  test("ignores empty background command", () => {
    expect(parseBackgroundCommand("& # poll:5000")).toBeUndefined();
  });
});

describe("diffPollOutput", () => {
  test("first poll sends current output", () => {
    expect(diffPollOutput(undefined, "one\ntwo")).toBe("one\ntwo");
  });

  test("unchanged poll sends nothing", () => {
    expect(diffPollOutput("one\ntwo", "one\ntwo")).toBe("");
  });

  test("sends only new appended lines", () => {
    expect(diffPollOutput("one\ntwo", "one\ntwo\nthree\nfour")).toBe("three\nfour");
  });

  test("handles rolling tail overlap", () => {
    expect(diffPollOutput("one\ntwo\nthree", "two\nthree\nfour\nfive")).toBe("four\nfive");
  });

  test("falls back to current output when no overlap exists", () => {
    expect(diffPollOutput("one\ntwo", "alpha\nbeta")).toBe("alpha\nbeta");
  });
});
