/**
 * Lib/intel.cjs -- Intel storage and query operations for GSD.
 *
 * Provides a persistent, queryable intelligence system for project metadata. Intel files live in
 * .planning/intel/ and store structured data about the project's files, APIs, dependencies,
 * architecture, and tech stack.
 *
 * All public functions gate on intel.enabled config (no-op when false).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── Constants ───────────────────────────────────────────────────────────────

const INTEL_DIR = ".planning/intel";

const INTEL_FILES = {
  files: "files.json",
  apis: "apis.json",
  deps: "deps.json",
  arch: "arch.md",
  stack: "stack.json",
};

const INTEL_FILE_CANDIDATES = {
  files: ["files.json", "file-roles.json"],
  apis: ["apis.json", "api-map.json"],
  deps: ["deps.json", "dependency-graph.json"],
  arch: ["arch.md", "arch.json", "arch-decisions.json"],
  stack: ["stack.json"],
};

const INTEL_SNAPSHOT_CANDIDATES = [".last-refresh.json", "snapshot.json"];
const ARCH_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;

function invalidIntelFile(file, error, preferredOver = []) {
  return {
    file,
    error,
    ...(preferredOver.length === 0 ? {} : { preferredOver }),
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Ensure the intel directory exists under the given planning dir.
 *
 * @param {string} planningDir - Path to .planning directory
 * @returns {string} Full path to .planning/intel/
 */
function ensureIntelDir(planningDir) {
  const intelPath = path.join(planningDir, "intel");
  if (!fs.existsSync(intelPath)) {
    fs.mkdirSync(intelPath, { recursive: true });
  }
  return intelPath;
}

/**
 * Check whether intel is enabled in the project config. Reads config.json directly via fs. Returns
 * false by default (when no config, no intel key, or on error).
 *
 * @param {string} planningDir - Path to .planning directory
 * @returns {boolean}
 */
function isIntelEnabled(planningDir) {
  try {
    const configPath = path.join(planningDir, "config.json");
    if (!fs.existsSync(configPath)) return false;
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (config && config.intel && config.intel.enabled === true) return true;
    return false;
  } catch (_e) {
    return false;
  }
}

/**
 * Return the standard disabled response object.
 *
 * @returns {{ disabled: true; message: string }}
 */
function disabledResponse() {
  return {
    disabled: true,
    message: "Intel system disabled. Set intel.enabled=true in config.json to activate.",
  };
}

/**
 * Resolve full path to an intel file.
 *
 * @param {string} planningDir
 * @param {string} filename
 * @returns {string}
 */
function intelFilePath(planningDir, filename) {
  return path.join(planningDir, "intel", filename);
}

function resolveIntelFilePath(planningDir, key) {
  const filenames = INTEL_FILE_CANDIDATES[key] || [];
  const existing = [];
  for (const filename of filenames) {
    const filePath = intelFilePath(planningDir, filename);
    if (fs.existsSync(filePath)) {
      existing.push({ filePath, filename });
    }
  }
  if (existing.length > 1) {
    return {
      ...existing[0],
      ambiguous: true,
      ignoredFilenames: existing.slice(1).map((entry) => entry.filename),
    };
  }
  if (existing.length === 1) {
    return { ...existing[0], ambiguous: false, ignoredFilenames: [] };
  }
  const fallback = filenames[0] || INTEL_FILES[key];
  return {
    filePath: intelFilePath(planningDir, fallback),
    filename: fallback,
    ambiguous: false,
    ignoredFilenames: [],
  };
}

function resolveSnapshotPath(planningDir) {
  const existing = [];
  for (const filename of INTEL_SNAPSHOT_CANDIDATES) {
    const filePath = intelFilePath(planningDir, filename);
    if (fs.existsSync(filePath)) {
      existing.push({ filePath, filename });
    }
  }
  if (existing.length > 1) {
    return {
      ...existing[0],
      ambiguous: true,
      ignoredFilenames: existing.slice(1).map((entry) => entry.filename),
    };
  }
  if (existing.length === 1) {
    return { ...existing[0], ambiguous: false, ignoredFilenames: [] };
  }
  return {
    filePath: intelFilePath(planningDir, INTEL_SNAPSHOT_CANDIDATES[0]),
    filename: INTEL_SNAPSHOT_CANDIDATES[0],
    ambiguous: false,
    ignoredFilenames: [],
  };
}

function readIntelUpdatedAt(filePath, isJson) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  if (isJson) {
    const data = safeReadJson(filePath);
    if (data.ok && data.value._meta && data.value._meta.updated_at) {
      return data.value._meta.updated_at;
    }
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsedArch = parseArchMarkdownMeta(content);
    return parsedArch.ok ? parsedArch.updatedAt : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Safely read and parse a JSON intel file.
 *
 * @param {string} filePath
 * @returns {{ ok: true; value: object }
 *   | { ok: false; missing: true }
 *   | { ok: false; invalid: true; error: string }}
 */
function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, missing: true };
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return {
      ok: false,
      invalid: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function searchJsonFile(filePath, term) {
  const parsed = safeReadJson(filePath);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, value: searchJsonEntries(parsed.value, term) };
}

/**
 * Compute SHA-256 hash of a file's contents. Returns null if the file doesn't exist.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
function hashFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8");
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch (_e) {
    return null;
  }
}

function parseArchMarkdownMeta(content) {
  const frontmatterMatch = content.match(ARCH_FRONTMATTER_PATTERN);
  if (!frontmatterMatch) {
    return { ok: false, error: "missing YAML frontmatter" };
  }

  const frontmatter = frontmatterMatch[1];
  const updatedAtMatch = frontmatter.match(/^updated_at:\s*"([^"]+)"\s*$/mu);
  if (!updatedAtMatch) {
    return { ok: false, error: "missing frontmatter updated_at" };
  }

  const updatedAt = updatedAtMatch[1];
  if (Number.isNaN(new Date(updatedAt).getTime())) {
    return { ok: false, error: "invalid frontmatter updated_at" };
  }

  return { ok: true, updatedAt, body: content.slice(frontmatterMatch[0].length).trim() };
}

function isValidSnapshotData(data) {
  return (
    typeof data === "object" &&
    data !== null &&
    "hashes" in data &&
    typeof data.hashes === "object" &&
    data.hashes !== null &&
    !Array.isArray(data.hashes) &&
    "timestamp" in data &&
    typeof data.timestamp === "string"
  );
}

function getPreviousHashForIntelFile(prevHashes, key, resolvedFilename) {
  const candidates = INTEL_FILE_CANDIDATES[key] || [resolvedFilename];
  for (const candidate of candidates) {
    const previousHash = prevHashes[candidate];
    if (typeof previousHash === "string" && previousHash.length > 0) {
      return previousHash;
    }
  }
  return null;
}

function isCanonicalIntelFilename(key, filename) {
  return INTEL_FILES[key] === filename;
}

function validateCanonicalIntelData(key, data) {
  if (!data || typeof data !== "object") {
    return "invalid root object";
  }
  if (!data._meta || typeof data._meta !== "object") {
    return "missing _meta";
  }
  if (typeof data._meta.updated_at !== "string") {
    return "missing _meta.updated_at";
  }
  if (Number.isNaN(new Date(data._meta.updated_at).getTime())) {
    return "invalid _meta.updated_at";
  }
  if (typeof data._meta.version !== "number") {
    return "missing _meta.version";
  }
  if (!data.entries || typeof data.entries !== "object") {
    return "missing entries";
  }

  if (key === "files") {
    const validFileTypes = new Set([
      "entry-point",
      "module",
      "config",
      "test",
      "script",
      "type-def",
      "style",
      "template",
      "data",
    ]);
    for (const entry of Object.values(data.entries)) {
      if (!entry || typeof entry !== "object") return "invalid file entry";
      if (!Array.isArray(entry.exports)) return "invalid files.json exports";
      if (!Array.isArray(entry.imports)) return "invalid files.json imports";
      if (typeof entry.type !== "string" || !validFileTypes.has(entry.type)) {
        return "invalid files.json type";
      }
    }
  }

  if (key === "apis") {
    for (const entry of Object.values(data.entries)) {
      if (!entry || typeof entry !== "object") return "invalid api entry";
      if (typeof entry.method !== "string") return "invalid apis.json method";
      if (typeof entry.path !== "string") return "invalid apis.json path";
      if (!Array.isArray(entry.params)) return "invalid apis.json params";
      if (typeof entry.file !== "string") return "invalid apis.json file";
      if (typeof entry.description !== "string") return "invalid apis.json description";
    }
  }

  if (key === "deps") {
    const validDependencyTypes = new Set(["production", "development", "peer", "optional"]);
    for (const entry of Object.values(data.entries)) {
      if (!entry || typeof entry !== "object") return "invalid dependency entry";
      if (typeof entry.version !== "string") return "invalid deps.json version";
      if (typeof entry.type !== "string" || !validDependencyTypes.has(entry.type)) {
        return "invalid deps.json type";
      }
      if (!Array.isArray(entry.used_by)) return "invalid deps.json used_by";
      if (typeof entry.invocation !== "string") return "invalid deps.json invocation";
    }
  }

  if (key === "stack") {
    if (!Array.isArray(data.languages)) return "invalid stack.json languages";
    if (!Array.isArray(data.frameworks)) return "invalid stack.json frameworks";
    if (!Array.isArray(data.tools)) return "invalid stack.json tools";
    if (typeof data.build_system !== "string") return "invalid stack.json build_system";
    if (typeof data.test_framework !== "string") return "invalid stack.json test_framework";
    if (typeof data.package_manager !== "string") return "invalid stack.json package_manager";
    if (!Array.isArray(data.content_formats)) return "invalid stack.json content_formats";
  }

  return null;
}

function resolveFileCandidates(basePath) {
  return [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mts`,
    `${basePath}.cts`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    `${basePath}.json`,
  ];
}

function isPathInsideWorkspace(workspaceDir, candidatePath) {
  const relativePath = path.relative(workspaceDir, candidatePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function isExactInRepoFile(workspaceDir, targetPath) {
  if (!isPathInsideWorkspace(workspaceDir, targetPath)) {
    return false;
  }
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
  } catch (_error) {
    return false;
  }
}

function resolvesToInRepoFileWithExtensionProbing(workspaceDir, targetPath) {
  for (const candidate of resolveFileCandidates(targetPath)) {
    if (isExactInRepoFile(workspaceDir, candidate)) {
      return true;
    }
  }
  return false;
}

function validateCanonicalIntelReferences(planningDir, key, data) {
  const workspaceDir = path.dirname(planningDir);

  if (key === "files") {
    for (const [entryPath, entry] of Object.entries(data.entries)) {
      const absoluteEntryPath = path.resolve(workspaceDir, entryPath);
      if (!isExactInRepoFile(workspaceDir, absoluteEntryPath)) {
        return `missing files.json entry path: ${entryPath}`;
      }
      for (const importedPath of entry.imports) {
        if (typeof importedPath !== "string") {
          return `invalid import path for ${entryPath}`;
        }
        if (!(importedPath.startsWith("./") || importedPath.startsWith("../"))) {
          continue;
        }
        const absoluteImportPath = path.resolve(path.dirname(absoluteEntryPath), importedPath);
        if (!resolvesToInRepoFileWithExtensionProbing(workspaceDir, absoluteImportPath)) {
          return `missing files.json import path: ${entryPath} -> ${importedPath}`;
        }
      }
    }
  }

  if (key === "apis") {
    for (const entry of Object.values(data.entries)) {
      const absoluteFilePath = path.resolve(workspaceDir, entry.file);
      if (!isExactInRepoFile(workspaceDir, absoluteFilePath)) {
        return `missing apis.json file path: ${entry.file}`;
      }
    }
  }

  return null;
}

function readValidatedIntelJson(planningDir, key, resolved) {
  const parsed = safeReadJson(resolved.filePath);
  if (!parsed.ok) {
    return parsed;
  }
  if (isCanonicalIntelFilename(key, resolved.filename)) {
    const schemaError = validateCanonicalIntelData(key, parsed.value);
    if (schemaError !== null) {
      return { ok: false, invalid: true, error: schemaError };
    }
    const referenceError = validateCanonicalIntelReferences(planningDir, key, parsed.value);
    if (referenceError !== null) {
      return { ok: false, invalid: true, error: referenceError };
    }
  }
  return parsed;
}

function readValidatedArchMarkdown(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, missing: true };
    const content = fs.readFileSync(filePath, "utf8");
    const parsedArch = parseArchMarkdownMeta(content);
    if (!parsedArch.ok) {
      return { ok: false, invalid: true, error: parsedArch.error };
    }
    return { ok: true, value: { content, meta: parsedArch } };
  } catch (error) {
    return {
      ok: false,
      invalid: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Search for a term (case-insensitive) in a JSON object's keys and string values. Returns an array
 * of matching entries.
 *
 * @param {object} data - The JSON data (expects { _meta, entries } or flat object)
 * @param {string} term - Search term
 * @returns {{ key: string; value: any }[]}
 */
function searchJsonEntries(data, term) {
  if (!data || typeof data !== "object") return [];

  const entries = data.entries || data;
  if (!entries || typeof entries !== "object") return [];

  const lowerTerm = term.toLowerCase();
  const matches = [];

  for (const [key, value] of Object.entries(entries)) {
    if (key === "_meta") continue;

    // Check key match
    if (key.toLowerCase().includes(lowerTerm)) {
      matches.push({ key, value });
      continue;
    }

    // Check string value match (recursive for objects)
    if (matchesInValue(value, lowerTerm)) {
      matches.push({ key, value });
    }
  }

  return matches;
}

/**
 * Recursively check if a term appears in any string value.
 *
 * @param {any} value
 * @param {string} lowerTerm
 * @returns {boolean}
 */
function matchesInValue(value, lowerTerm) {
  if (typeof value === "string") {
    return value.toLowerCase().includes(lowerTerm);
  }
  if (Array.isArray(value)) {
    return value.some((v) => matchesInValue(v, lowerTerm));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((v) => matchesInValue(v, lowerTerm));
  }
  return false;
}

/**
 * Search for a term in arch.md text content. Returns matching lines.
 *
 * @param {string} filePath - Path to arch.md
 * @param {string} term - Search term
 * @returns {string[]}
 */
function searchArchMd(filePath, term) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    const lowerTerm = term.toLowerCase();
    const lines = content.split(/\r?\n/);
    return lines.filter((line) => line.toLowerCase().includes(lowerTerm));
  } catch (_e) {
    return [];
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Query intel files for a search term. Searches across all JSON intel files (keys and values) and
 * arch.md (text lines).
 *
 * @param {string} term - Search term (case-insensitive)
 * @param {string} planningDir - Path to .planning directory
 * @returns {{ matches: { source: string; entries: Array }[]; term: string; total: number }
 *   | { disabled: true; message: string }}
 */
function intelQuery(term, planningDir) {
  if (!isIntelEnabled(planningDir)) return disabledResponse();

  const matches = [];
  const invalid_files = [];
  let total = 0;

  // Search all JSON intel files
  for (const [key] of Object.entries(INTEL_FILES)) {
    const resolved = resolveIntelFilePath(planningDir, key);
    const isArchMarkdown = resolved.filename === "arch.md";
    if (isArchMarkdown) {
      const validatedArch = readValidatedArchMarkdown(resolved.filePath);
      if (!validatedArch.ok) {
        if (validatedArch.invalid) {
          invalid_files.push(
            invalidIntelFile(resolved.filename, validatedArch.error, resolved.ignoredFilenames),
          );
        }
        continue;
      }
      const entries = searchArchMd(resolved.filePath, term).map((line) => ({
        key: line,
        value: line,
      }));
      if (entries.length > 0) {
        const source = resolved.ambiguous
          ? `${resolved.filename} (preferred over ${resolved.ignoredFilenames.join(", ")})`
          : resolved.filename;
        matches.push({ source, entries });
        total += entries.length;
      }
      continue;
    }

    const found = readValidatedIntelJson(planningDir, key, resolved);
    if (!found.ok) {
      if (found.invalid) {
        invalid_files.push(
          invalidIntelFile(resolved.filename, found.error, resolved.ignoredFilenames),
        );
      }
      continue;
    }

    const entries = searchJsonEntries(found.value, term);
    if (entries.length > 0) {
      const source = resolved.ambiguous
        ? `${resolved.filename} (preferred over ${resolved.ignoredFilenames.join(", ")})`
        : resolved.filename;
      matches.push({ source, entries });
      total += entries.length;
    }
  }

  return { matches, term, total, ...(invalid_files.length === 0 ? {} : { invalid_files }) };
}

/**
 * Report status and staleness of each intel file. A file is considered stale if its updated_at is
 * older than 24 hours.
 *
 * @param {string} planningDir - Path to .planning directory
 * @returns {{ files: object; overall_stale: boolean } | { disabled: true; message: string }}
 */
function intelStatus(planningDir) {
  if (!isIntelEnabled(planningDir)) return disabledResponse();

  const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  const files = {};
  const invalid_files = [];
  let overallStale = false;

  for (const [key] of Object.entries(INTEL_FILES)) {
    const resolved = resolveIntelFilePath(planningDir, key);
    const exists = fs.existsSync(resolved.filePath);
    const label = resolved.ambiguous
      ? `${resolved.filename} (preferred over ${resolved.ignoredFilenames.join(", ")})`
      : resolved.filename;

    if (!exists) {
      files[label] = { exists: false, updated_at: null, stale: true };
      overallStale = true;
      continue;
    }

    if (resolved.filename !== "arch.md") {
      const parsed = readValidatedIntelJson(planningDir, key, resolved);
      if (!parsed.ok) {
        if (parsed.invalid) {
          invalid_files.push(
            invalidIntelFile(resolved.filename, parsed.error, resolved.ignoredFilenames),
          );
          files[label] = { exists: true, updated_at: null, stale: true };
          overallStale = true;
        }
        continue;
      }
    } else {
      try {
        const content = fs.readFileSync(resolved.filePath, "utf8");
        const parsedArch = parseArchMarkdownMeta(content);
        if (!parsedArch.ok) {
          invalid_files.push(
            invalidIntelFile(resolved.filename, parsedArch.error, resolved.ignoredFilenames),
          );
          files[label] = { exists: true, updated_at: null, stale: true };
          overallStale = true;
          continue;
        }
      } catch (error) {
        invalid_files.push(
          invalidIntelFile(
            resolved.filename,
            error instanceof Error ? error.message : String(error),
            resolved.ignoredFilenames,
          ),
        );
        files[label] = { exists: true, updated_at: null, stale: true };
        overallStale = true;
        continue;
      }
    }

    const updatedAt = readIntelUpdatedAt(resolved.filePath, resolved.filename !== "arch.md");

    let stale = true;
    if (updatedAt) {
      const age = now - new Date(updatedAt).getTime();
      stale = age > STALE_MS;
    }

    if (stale) overallStale = true;
    files[label] = { exists: true, updated_at: updatedAt, stale };
  }

  return {
    files,
    overall_stale: overallStale,
    ...(invalid_files.length === 0 ? {} : { invalid_files }),
  };
}

/**
 * Show changes since the last full refresh by comparing file hashes.
 *
 * @param {string} planningDir - Path to .planning directory
 * @returns {{ changed: string[]; added: string[]; removed: string[] }
 *   | {
 *       invalid_baseline: true;
 *       message: string;
 *       invalid_files?: Array<{ file: string; error: string; preferredOver?: string[] }>;
 *     }
 *   | { no_baseline: true }
 *   | { disabled: true; message: string }}
 */
function intelDiff(planningDir) {
  if (!isIntelEnabled(planningDir)) return disabledResponse();

  const snapshotResolution = resolveSnapshotPath(planningDir);
  const snapshot = safeReadJson(snapshotResolution.filePath);
  const invalid_files = [];

  if (!snapshot.ok) {
    if (snapshot.invalid) {
      invalid_files.push(
        invalidIntelFile(
          snapshotResolution.filename,
          snapshot.error,
          snapshotResolution.ignoredFilenames,
        ),
      );
      return {
        invalid_baseline: true,
        message: "Intel diff unavailable: baseline snapshot is invalid.",
        invalid_files,
      };
    }
    return { no_baseline: true };
  }

  if (!isValidSnapshotData(snapshot.value)) {
    invalid_files.push(
      invalidIntelFile(
        snapshotResolution.filename,
        "invalid snapshot schema",
        snapshotResolution.ignoredFilenames,
      ),
    );
    return {
      invalid_baseline: true,
      message: "Intel diff unavailable: baseline snapshot is invalid.",
      invalid_files,
    };
  }

  const prevHashes = snapshot.value.hashes || {};
  const changed = [];
  const added = [];
  const removed = [];

  // Check current files against snapshot
  for (const [key] of Object.entries(INTEL_FILES)) {
    const resolved = resolveIntelFilePath(planningDir, key);
    const label = resolved.ambiguous
      ? `${resolved.filename} (preferred over ${resolved.ignoredFilenames.join(", ")})`
      : resolved.filename;
    const previousHash = getPreviousHashForIntelFile(prevHashes, key, resolved.filename);

    if (!fs.existsSync(resolved.filePath)) {
      if (previousHash) {
        removed.push(label);
      }
      continue;
    }

    if (resolved.filename !== "arch.md") {
      const parsed = readValidatedIntelJson(planningDir, key, resolved);
      if (!parsed.ok) {
        if (parsed.invalid) {
          invalid_files.push(
            invalidIntelFile(resolved.filename, parsed.error, resolved.ignoredFilenames),
          );
        }
        continue;
      }
    } else {
      const parsedArch = readValidatedArchMarkdown(resolved.filePath);
      if (!parsedArch.ok) {
        if (parsedArch.invalid) {
          invalid_files.push(
            invalidIntelFile(resolved.filename, parsedArch.error, resolved.ignoredFilenames),
          );
        }
        continue;
      }
    }
    const currentHash = hashFile(resolved.filePath);

    if (currentHash && !previousHash) {
      added.push(label);
    } else if (currentHash && previousHash && currentHash !== previousHash) {
      changed.push(label);
    } else if (!currentHash && previousHash) {
      removed.push(label);
    }
  }

  if (snapshotResolution.ambiguous) {
    changed.push(
      `${snapshotResolution.filename} (preferred over ${snapshotResolution.ignoredFilenames.join(", ")})`,
    );
  }

  return { changed, added, removed, ...(invalid_files.length === 0 ? {} : { invalid_files }) };
}

/**
 * Stub for triggering an intel update. The actual update is performed by the intel-updater agent
 * (PLAN-02).
 *
 * @param {string} planningDir - Path to .planning directory
 * @returns {{ action: string; message: string } | { disabled: true; message: string }}
 */
function intelUpdate(planningDir) {
  if (!isIntelEnabled(planningDir)) return disabledResponse();

  return {
    action: "spawn_agent",
    message: "Run gsd-tools intel update or spawn gsd-intel-updater agent for full refresh",
  };
}

/**
 * Save a refresh snapshot with hashes of all current intel files. Called by the intel-updater agent
 * after completing a refresh.
 *
 * @param {string} planningDir - Path to .planning directory
 * @returns {{ saved: boolean; timestamp: string; files: number }}
 */
function saveRefreshSnapshot(planningDir) {
  const intelPath = ensureIntelDir(planningDir);
  const hashes = {};
  let fileCount = 0;

  for (const [_key, filename] of Object.entries(INTEL_FILES)) {
    const filePath = path.join(intelPath, filename);
    const hash = hashFile(filePath);
    if (hash) {
      hashes[filename] = hash;
      fileCount++;
    }
  }

  const timestamp = new Date().toISOString();
  const snapshotPath = path.join(intelPath, ".last-refresh.json");
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify(
      {
        hashes,
        timestamp,
        version: 1,
      },
      null,
      2,
    ),
    "utf8",
  );

  return { saved: true, timestamp, files: fileCount };
}

// ─── CLI Subcommands ─────────────────────────────────────────────────────────

/**
 * Thin wrapper around saveRefreshSnapshot for CLI dispatch. Writes .last-refresh.json with accurate
 * timestamps and hashes.
 *
 * @param {string} planningDir - Path to .planning directory
 * @returns {{ saved: boolean; timestamp: string; files: number }
 *   | { disabled: true; message: string }}
 */
function intelSnapshot(planningDir) {
  if (!isIntelEnabled(planningDir)) return disabledResponse();
  return saveRefreshSnapshot(planningDir);
}

/**
 * Validate all intel files for correctness and freshness.
 *
 * @param {string} planningDir - Path to .planning directory
 * @returns {{ valid: boolean; errors: string[]; warnings: string[] }
 *   | { disabled: true; message: string }}
 */
function intelValidate(planningDir) {
  if (!isIntelEnabled(planningDir)) return disabledResponse();

  const errors = [];
  const warnings = [];
  const STALE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const [key, filename] of Object.entries(INTEL_FILES)) {
    const filePath = intelFilePath(planningDir, filename);

    // Check existence
    if (!fs.existsSync(filePath)) {
      errors.push(`${filename}: file does not exist`);
      continue;
    }

    if (filename === "arch.md") {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.trim().length === 0) {
          errors.push(`${filename}: file is empty`);
          continue;
        }
        const parsedArch = parseArchMarkdownMeta(content);
        if (!parsedArch.ok) {
          errors.push(`${filename}: ${parsedArch.error}`);
          continue;
        }
        if (parsedArch.body.length === 0) {
          errors.push(`${filename}: empty body`);
          continue;
        }
        const age = now - new Date(parsedArch.updatedAt).getTime();
        if (age > STALE_MS) {
          warnings.push(
            `${filename}: updated_at is ${Math.round(age / 3600000)} hours old (>24 hr)`,
          );
        }
      } catch (e) {
        errors.push(`${filename}: unreadable markdown — ${e.message}`);
      }
      continue;
    }

    // Parse JSON
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      errors.push(`${filename}: invalid JSON — ${e.message}`);
      continue;
    }

    // Check _meta.updated_at recency
    if (data._meta && data._meta.updated_at) {
      const updatedAtMs = new Date(data._meta.updated_at).getTime();
      if (Number.isNaN(updatedAtMs)) {
        errors.push(`${filename}: invalid _meta.updated_at`);
        continue;
      }
      const age = now - updatedAtMs;
      if (age > STALE_MS) {
        warnings.push(
          `${filename}: _meta.updated_at is ${Math.round(age / 3600000)} hours old (>24 hr)`,
        );
      }
    } else {
      warnings.push(`${filename}: missing _meta.updated_at`);
    }

    // Validate entries are objects with expected fields
    if (data.entries && typeof data.entries === "object") {
      // files.json: check exports are actual symbol names (no spaces)
      if (key === "files") {
        for (const [entryPath, entry] of Object.entries(data.entries)) {
          if (entry.exports && Array.isArray(entry.exports)) {
            for (const exp of entry.exports) {
              if (typeof exp === "string" && exp.includes(" ")) {
                warnings.push(
                  `${filename}: "${entryPath}" export "${exp}" looks like a description (contains space)`,
                );
              }
            }
          }
        }
      }

      // deps.json: check entries have version, type, used_by
      if (key === "deps") {
        for (const [depName, entry] of Object.entries(data.entries)) {
          const missing = [];
          if (!entry.version) missing.push("version");
          if (!entry.type) missing.push("type");
          if (!entry.used_by) missing.push("used_by");
          if (!entry.invocation) missing.push("invocation");
          if (missing.length > 0) {
            errors.push(`${filename}: "${depName}" missing fields: ${missing.join(", ")}`);
          }
        }
      }
    }

    const referenceError = validateCanonicalIntelReferences(planningDir, key, data);
    if (referenceError) {
      errors.push(`${filename}: ${referenceError}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Patch _meta.updated_at in a JSON intel file to the current timestamp. Reads the file, updates
 * _meta.updated_at, increments version, writes back.
 *
 * NOTE: Does not gate on isIntelEnabled — operates on arbitrary file paths for use by agents
 * patching individual files outside the intel store.
 *
 * @param {string} filePath - Absolute or relative path to the JSON intel file
 * @returns {{ patched: boolean; file: string; timestamp: string }
 *   | { patched: false; error: string }}
 */
function intelPatchMeta(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { patched: false, error: `File not found: ${filePath}` };
    }

    const content = fs.readFileSync(filePath, "utf8");
    let data;
    try {
      data = JSON.parse(content);
    } catch (e) {
      return { patched: false, error: `Invalid JSON: ${e.message}` };
    }

    if (!data._meta) {
      data._meta = {};
    }

    const timestamp = new Date().toISOString();
    data._meta.updated_at = timestamp;
    data._meta.version = (data._meta.version || 0) + 1;

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");

    return { patched: true, file: filePath, timestamp };
  } catch (e) {
    return { patched: false, error: e.message };
  }
}

/**
 * Extract exports from a JS/CJS file by parsing module.exports or exports.X patterns.
 *
 * NOTE: Does not gate on isIntelEnabled — operates on arbitrary source files for use by agents
 * building intel data from project files.
 *
 * @param {string} filePath - Path to the JS/CJS file
 * @returns {{ file: string; exports: string[]; method: string }}
 */
function intelExtractExports(filePath) {
  if (!fs.existsSync(filePath)) {
    return { file: filePath, exports: [], method: "none" };
  }

  const content = fs.readFileSync(filePath, "utf8");
  let exports = [];
  let method = "none";

  // Try module.exports = { ... } pattern (handle multi-line)
  // Find the LAST module.exports assignment (the actual one, not references in code)
  const allMatches = [...content.matchAll(/module\.exports\s*=\s*\{/g)];
  if (allMatches.length > 0) {
    const lastMatch = allMatches[allMatches.length - 1];
    const startIdx = lastMatch.index + lastMatch[0].length;
    // Find matching closing brace by counting braces
    let depth = 1;
    let endIdx = startIdx;
    while (endIdx < content.length && depth > 0) {
      if (content[endIdx] === "{") depth++;
      else if (content[endIdx] === "}") depth--;
      if (depth > 0) endIdx++;
    }
    const block = content.substring(startIdx, endIdx);
    method = "module.exports";
    // Extract key names from lines like "  keyName," or "  keyName: value,"
    const lines = block.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      // Match identifier at start of line (before comma, colon, end of line)
      const keyMatch = trimmed.match(/^(\w+)\s*[,}:]/) || trimmed.match(/^(\w+)$/);
      if (keyMatch) {
        exports.push(keyMatch[1]);
      }
    }
  }

  // Also try individual exports.X = patterns (only at start of line, not inside strings/regex)
  const individualPattern = /^exports\.(\w+)\s*=/gm;
  let im;
  while ((im = individualPattern.exec(content)) !== null) {
    if (!exports.includes(im[1])) {
      exports.push(im[1]);
      if (method === "none") method = "exports.X";
    }
  }

  const hadCjs = exports.length > 0;

  // ESM patterns
  const esmExports = [];

  // export default function X / export default class X
  const defaultNamedPattern = /^export\s+default\s+(?:function|class)\s+(\w+)/gm;
  let em;
  while ((em = defaultNamedPattern.exec(content)) !== null) {
    if (!esmExports.includes(em[1])) esmExports.push(em[1]);
  }

  // export default (without named function/class)
  const defaultAnonPattern = /^export\s+default\s+(?!function\s|class\s)/gm;
  if (defaultAnonPattern.test(content) && esmExports.length === 0) {
    if (!esmExports.includes("default")) esmExports.push("default");
  }

  // export function X( / export async function X(
  const exportFnPattern = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(/gm;
  while ((em = exportFnPattern.exec(content)) !== null) {
    if (!esmExports.includes(em[1])) esmExports.push(em[1]);
  }

  // export const X = / export let X = / export var X =
  const exportVarPattern = /^export\s+(?:const|let|var)\s+(\w+)\s*=/gm;
  while ((em = exportVarPattern.exec(content)) !== null) {
    if (!esmExports.includes(em[1])) esmExports.push(em[1]);
  }

  // export class X
  const exportClassPattern = /^export\s+class\s+(\w+)/gm;
  while ((em = exportClassPattern.exec(content)) !== null) {
    if (!esmExports.includes(em[1])) esmExports.push(em[1]);
  }

  // export { X, Y, Z } — strip "as alias" parts
  const exportBlockPattern = /^export\s*\{([^}]+)\}/gm;
  while ((em = exportBlockPattern.exec(content)) !== null) {
    const items = em[1].split(",");
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      // "foo as bar" -> extract "foo"
      const name = trimmed.split(/\s+as\s+/)[0].trim();
      if (name && !esmExports.includes(name)) esmExports.push(name);
    }
  }

  // Merge ESM exports into the result
  for (const e of esmExports) {
    if (!exports.includes(e)) exports.push(e);
  }

  // Determine method
  const hadEsm = esmExports.length > 0;
  if (hadCjs && hadEsm) {
    method = "mixed";
  } else if (hadEsm && !hadCjs) {
    method = "esm";
  }

  return { file: filePath, exports, method };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Public API
  intelQuery,
  intelUpdate,
  intelStatus,
  intelDiff,
  saveRefreshSnapshot,

  // CLI subcommands
  intelSnapshot,
  intelValidate,
  intelExtractExports,
  intelPatchMeta,

  // Utilities
  ensureIntelDir,
  isIntelEnabled,

  // Constants
  INTEL_FILES,
  INTEL_DIR,
};
