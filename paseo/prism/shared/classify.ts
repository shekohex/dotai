export type ChangeCategory = "code" | "tests" | "mocks" | "evals" | "docs" | "config" | "lockfiles";

export interface CategoryInfo {
  label: string;
  /** Lucide icon name. */
  icon: string;
}

/** Display order of the breakdown. */
export const CATEGORIES: Readonly<Record<ChangeCategory, CategoryInfo>> = {
  code: { label: "Code", icon: "Code" },
  tests: { label: "Tests", icon: "FlaskConical" },
  mocks: { label: "Mocks", icon: "Blocks" },
  evals: { label: "Evals", icon: "ClipboardCheck" },
  docs: { label: "Docs", icon: "BookOpen" },
  config: { label: "Config", icon: "Settings" },
  lockfiles: { label: "Lockfiles", icon: "Lock" },
};

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  "cargo.lock", "go.sum", "go.work.sum", "poetry.lock", "uv.lock", "pipfile.lock", "pdm.lock",
  "gemfile.lock", "composer.lock", "mix.lock", "pubspec.lock", "package.resolved", "podfile.lock",
  "cartfile.resolved", "gradle.lockfile", "packages.lock.json", "flake.lock", "deno.lock",
  "conan.lock", "shard.lock", "stack.yaml.lock", "cabal.project.freeze",
]);

const MOCK_DIRS = ["__mocks__", "mocks", "mock", "fixtures", "fixture", "__fixtures__", "__snapshots__", "testdata", "stubs", "fakes"];
const TEST_DIRS = ["test", "tests", "__tests__", "spec", "specs", "e2e", "integration-tests", "androidtest", "unittest"];
const EVAL_DIRS = ["evals", "eval", "benchmarks", "benchmark"];
const DOC_DIRS = ["docs", "doc", "documentation"];
const DOC_EXTENSIONS = new Set(["md", "mdx", "rst", "adoc", "txt", "org"]);
const CONFIG_EXTENSIONS = new Set(["json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "plist", "xml", "editorconfig"]);

// Test file names across TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, Swift, C/C++, C#,
// Ruby, PHP, Scala, Dart, Elixir and shell.
const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /\.(test|spec)\.[a-z0-9]+$/, // ts, js, tsx, jsx, mjs, vue, svelte
  /(^|\/)test_[^/]+\.py$/, /_test\.py$/, /(^|\/)conftest\.py$/,
  /_test\.go$/,
  /_test\.rs$/,
  /(test|tests|it|spec)\.(java|kt|kts|scala|groovy)$/,
  /tests?\.swift$/,
  /_(test|unittest)\.(c|cc|cpp|cxx|h|hpp)$/, /(^|\/)test_[^/]+\.(c|cc|cpp|cxx)$/,
  /tests?\.cs$/,
  /_spec\.rb$/, /_test\.rb$/,
  /test\.php$/,
  /_test\.exs?$/,
  /_test\.dart$/,
  /\.(bats|t)$/,
  /(^|\/)test[^/]*\.(sh|bash|zsh)$/,
];
const MOCK_FILE_PATTERNS: readonly RegExp[] = [/\.(mock|stub|fake)\.[a-z0-9]+$/, /\.snap$/, /_mock\.[a-z0-9]+$/, /mock_[^/]+\.[a-z0-9]+$/, /(^|\/)mock[A-Z][^/]*$/];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/** Buckets a changed file by path alone, so the breakdown needs no file contents. */
export function classifyPath(path: string): ChangeCategory {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  const name = parts[parts.length - 1] ?? lower;
  const directories = parts.slice(0, -1);
  const inDirectory = (names: readonly string[]) => directories.some((part) => names.includes(part));

  if (LOCKFILES.has(name) || name.endsWith(".lock")) return "lockfiles";
  if (MOCK_FILE_PATTERNS.some((pattern) => pattern.test(lower)) || inDirectory(MOCK_DIRS)) return "mocks";
  if (inDirectory(EVAL_DIRS)) return "evals";
  if (
    TEST_FILE_PATTERNS.some((pattern) => pattern.test(lower)) ||
    inDirectory(TEST_DIRS) ||
    `/${lower}`.includes("/src/test/")
  ) {
    return "tests";
  }
  const extension = extensionOf(name);
  if (DOC_EXTENSIONS.has(extension) || inDirectory(DOC_DIRS) || /^(license|changelog|readme|contributing|notice)/.test(name)) return "docs";
  if (
    name.startsWith(".") ||
    /\.config\.[a-z]+$/.test(name) ||
    /^(dockerfile|makefile|justfile|procfile|tsconfig.*|package\.json|cargo\.toml|go\.mod|pyproject\.toml|gemfile|build\.gradle.*|pom\.xml|pubspec\.yaml)$/.test(name) ||
    CONFIG_EXTENSIONS.has(extension) ||
    directories[0] === ".github"
  ) {
    return "config";
  }
  return "code";
}

export interface CategoryTotals {
  category: ChangeCategory;
  files: number;
  additions: number;
  deletions: number;
}

export function breakdownOf(
  files: readonly { path: string; additions: number; deletions: number }[],
): CategoryTotals[] {
  const totals = new Map<ChangeCategory, CategoryTotals>();
  for (const file of files) {
    const category = classifyPath(file.path);
    const entry = totals.get(category) ?? { category, files: 0, additions: 0, deletions: 0 };
    entry.files += 1;
    entry.additions += file.additions;
    entry.deletions += file.deletions;
    totals.set(category, entry);
  }
  return (Object.keys(CATEGORIES) as ChangeCategory[]).flatMap((category) => {
    const entry = totals.get(category);
    return entry ? [entry] : [];
  });
}
