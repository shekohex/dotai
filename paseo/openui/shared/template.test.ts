import { describe, expect, it } from "vitest";
import { expandUi, fillTemplate, parseLiteral, templateProps } from "./template";

const lookup = (templates: Record<string, string>, programs: Record<string, string> = {}) => ({ component: (name: string) => templates[name], program: (name: string) => programs[name] });

describe("parseLiteral", () => {
  it("reads JSON and OpenUI-style objects", () => {
    expect(parseLiteral('{a: 1, "b": [true, null, "x\\"y"], c: \'q\',}')).toEqual({ a: 1, b: [true, null, 'x"y'], c: "q" });
    expect(parseLiteral("-2.5e1")).toBe(-25);
  });
  it("rejects junk", () => {
    expect(() => parseLiteral("{a: }")).toThrow();
    expect(() => parseLiteral("1 2")).toThrow();
  });
});

describe("fillTemplate", () => {
  it("writes literals outside strings and bare text inside", () => {
    const errors: string[] = [];
    const out = fillTemplate('Stat("Hi {{name}}", {{count}}, {{flag}})', { name: 'A "b"', count: 3, flag: true }, errors);
    expect(out).toBe('Stat("Hi A \\"b\\"", 3, true)');
    expect(errors).toEqual([]);
  });
  it("repeats each with item and index", () => {
    const out = fillTemplate('[{{#each rows}}Row({{@index}}, "{{this.label}}", {{this.n}}){{/each}}]', {
      rows: [{ label: "a", n: 1 }, { label: "b", n: 2 }],
    });
    expect(out).toBe('[Row(0, "a", 1), Row(1, "b", 2)]');
  });
  it("embeds arrays and nested paths", () => {
    expect(fillTemplate("X({{user.tags}}, {{user.name}})", { user: { tags: ["a", "b"], name: "n" } })).toBe('X(["a","b"], "n")');
  });
  it("reports missing props", () => {
    const errors: string[] = [];
    fillTemplate("X({{nope}}, {{#each xs}}{{/each}})", {}, errors);
    expect(errors).toEqual(['Missing prop "nope"', "{{#each xs}} needs an array prop"]);
  });
});

describe("expandUi", () => {
  const templates = {
    badge: 'Tag("{{label}}", "{{tone}}")',
    row: "Stack([@Use(\"badge\", {label: {{label}}, tone: \"info\"}), Text(\"{{label}}\")])",
    loop: '@Use("loop", {})',
  };
  it("expands in place and nests", () => {
    const out = expandUi('root = Stack([@Use("badge", {label: "New", tone: "success"}), @Use("row", {label: "x)y"})])', lookup(templates));
    expect(out.errors).toEqual([]);
    expect(out.ui).toBe('root = Stack([Tag("New", "success"), Stack([Tag("x)y", "info"), Text("x)y")])])');
  });
  it("leaves @Use inside strings alone", () => {
    expect(expandUi('root = Text("write @Use(\\"a\\") to reuse")', lookup({})).ui).toContain("@Use(");
  });
  it("reports unknown, bad props and recursion", () => {
    expect(expandUi('x = @Use("ghost")', lookup({})).errors).toEqual(['Unknown component "ghost"']);
    expect(expandUi('x = @Use("badge", {oops)', lookup(templates)).errors[0]).toContain("@Use(");
    expect(expandUi('x = @Use("loop")', lookup(templates)).errors.join()).toContain("nests too deep");
  });
  it("runs a program with props flowing into nested components", () => {
    const programs = { board: 'root = Stack([@Use("badge", {label: {{title}}, tone: "info"}), {{#each rows}}Text("{{this}}"){{/each}}])' };
    const out = expandUi('@Run("board", {title: "Hi", rows: ["a", "b"]})', lookup(templates, programs));
    expect(out.errors).toEqual([]);
    expect(out.ui).toBe('root = Stack([Tag("Hi", "info"), Text("a"), Text("b")])');
  });
  it("needs @Run to be the whole program and the program to exist", () => {
    expect(expandUi('@Run("ghost")', lookup({})).errors).toEqual(['Unknown program "ghost"']);
    expect(expandUi('@Run("board") trailing', lookup({}, { board: "x" })).errors[0]).toContain("whole program");
  });
  it("is a no-op without @Use", () => {
    expect(expandUi("root = Text(\"a\")", lookup({}))).toEqual({ ui: 'root = Text("a")', errors: [] });
  });
});

describe("templateProps", () => {
  it("lists props and list fields", () => {
    expect(templateProps('S("{{title}}", [{{#each rows}}R("{{this.label}}", {{@index}}){{/each}}])').sort()).toEqual(["rows[]", "rows[].label", "title"]);
  });
});
